#!/usr/bin/env -S cargo +nightly -q -Zscript
---cargo
[package]
edition = "2024"

[dependencies]
anyhow = "1"
clap = { version = "4", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
toml = { version = "1", features = ["preserve_order"] }
---

//! Switches the Codex configuration between presets.
//!
//! The script merges `config.common.json` and the selected preset from
//! `config.presets.json` into the root `config.toml`, then rewrites the model
//! settings of every `agents/*.toml` file.

use std::{
    fs::{self, File, OpenOptions, Permissions},
    io::{self, ErrorKind, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use clap::{ArgAction, Parser};
use serde_json::{Map, Value};

const PRESETS_FILE: &str = "config.presets.json";
const COMMON_FILE: &str = "config.common.json";
const ROOT_CONFIG_FILE: &str = "config.toml";

/// Agents every preset must configure, in report order.
const AGENTS: [&str; 5] = ["Orchestrator", "Solo", "Junior", "Explorer", "Librarian"];

/// Root TOML key selecting an agent model.
const MODEL_KEY: &str = "model";
/// Root TOML key selecting an agent reasoning effort.
const EFFORT_KEY: &str = "model_reasoning_effort";
const MODEL_KEYS: [&str; 2] = [MODEL_KEY, EFFORT_KEY];

/// Reasoning efforts accepted by Codex.
const EFFORTS: [&str; 6] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/// Attempts allowed when creating a temporary file with an exclusive name.
const TEMP_ATTEMPTS: u32 = 16;

#[derive(Debug, Parser)]
#[command(
    name = "codex-switch",
    about = "Generate a Codex configuration from a preset",
    disable_help_flag = true
)]
struct Args {
    /// Preset to apply
    #[arg(value_name = "PRESET", allow_hyphen_values = true)]
    preset: Vec<String>,

    /// List the available presets
    #[arg(short, long, action = ArgAction::Count)]
    help: u8,
}

/// Reports errors in the same shape as the previous Node.js script.
fn main() {
    if let Err(error) = run() {
        eprintln!("codex-switch: {error:#}");
        process::exit(1);
    }
}

/// Applies the selected preset to the root and agent configuration files.
fn run() -> Result<()> {
    let args = Args::parse();
    let config_dir = config_dir()?;
    let presets = read_json_object(&config_dir.join(PRESETS_FILE), PRESETS_FILE)?;

    let Some(preset_name) = selected_preset(&args, &presets)? else {
        return Ok(());
    };
    let Some(preset) = presets.get(&preset_name) else {
        bail!("Unknown preset: {preset_name}");
    };

    let common = read_json_object(&config_dir.join(COMMON_FILE), COMMON_FILE)?;
    reject_nulls(&common, COMMON_FILE)?;
    let root_snapshot = read_root_snapshot(&config_dir)?;
    let preset = validate_preset(&preset_name, preset)?;

    let root_overlay = Value::Object(preset.root_models.clone());
    let expected_root = deep_merge(&deep_merge(&root_snapshot.config, &common), &root_overlay);
    reject_nulls(&expected_root, ROOT_CONFIG_FILE)?;
    let root_contents = serialize_root(&expected_root)?;

    // Validate every input before any configuration file changes.
    let agent_writes = prepare_agent_writes(&config_dir, &preset)?;
    write_root_config(&config_dir, &root_snapshot, &root_contents)?;
    for write in &agent_writes {
        fs::write(&write.path, &write.contents)
            .with_context(|| format!("failed to write {}", write.path.display()))?;
    }

    println!("Applied preset: {preset_name}");
    print_applied_table(&applied_rows(&preset));
    Ok(())
}

/// Returns the configuration directory containing this Cargo script's `bin` directory.
///
/// Cargo sets `CARGO_MANIFEST_DIR` to the directory containing the script, even when the
/// compiled script runs from Cargo's cache.
fn config_dir() -> Result<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .context("failed to locate the configuration directory")
}

/// Reads a JSON file and requires its root value to be an object.
fn read_json_object(path: &Path, label: &str) -> Result<Value> {
    let content = fs::read_to_string(path).with_context(|| {
        if path.exists() {
            format!("failed to read {}", path.display())
        } else {
            format!("configuration file missing: {}", path.display())
        }
    })?;
    let value: Value =
        serde_json::from_str(&content).with_context(|| format!("failed to parse {label}"))?;
    if !value.is_object() {
        bail!("{label} must contain a JSON object");
    }
    Ok(value)
}

/// Selects the preset named by the command line, or prints usage and returns `None`.
///
/// No arguments or a single `-h`/`--help` flag list the presets. Every other argument
/// combination is a usage error.
fn selected_preset(args: &Args, presets: &Value) -> Result<Option<String>> {
    match (args.preset.as_slice(), args.help) {
        ([], 0 | 1) => {
            print_help(presets);
            Ok(None)
        }
        ([name], 0) => Ok(Some(name.clone())),
        _ => bail!("Usage: codex-switch <preset>"),
    }
}

/// Prints usage information and the available preset names.
fn print_help(presets: &Value) {
    println!("Usage: codex-switch <preset>\n");
    println!("Available presets:");
    for name in preset_names(presets) {
        println!("  {name}");
    }
}

/// Iterates over preset names in file order.
fn preset_names(presets: &Value) -> impl Iterator<Item = &str> {
    presets
        .as_object()
        .into_iter()
        .flat_map(|presets| presets.keys().map(String::as_str))
}

/// Validated preset data ready to apply.
#[derive(Debug)]
struct ValidatedPreset {
    /// Root `model` and `model_reasoning_effort` values for `config.toml`.
    root_models: Map<String, Value>,
    /// Validated settings for every agent, in roster order.
    agents: Vec<(&'static str, Map<String, Value>)>,
}

/// Validates that a preset or agent entry defines a usable model.
///
/// The value must be an object; `model` must be a non-blank string, and
/// `model_reasoning_effort` one of the known efforts.
fn validated_settings<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    let Some(settings) = value.as_object() else {
        bail!("{label} must define a model and valid model_reasoning_effort");
    };
    let model = settings.get(MODEL_KEY).and_then(Value::as_str);
    let effort = settings.get(EFFORT_KEY).and_then(Value::as_str);
    let valid = model.is_some_and(|model| !model.trim().is_empty())
        && effort.is_some_and(|effort| EFFORTS.contains(&effort));
    if !valid {
        bail!("{label} must define a model and valid model_reasoning_effort");
    }
    Ok(settings)
}

/// Validates a preset and extracts the settings it applies.
///
/// A preset must define valid root model settings, use only known root keys, and provide
/// valid settings for every agent in the roster.
fn validate_preset(name: &str, preset: &Value) -> Result<ValidatedPreset> {
    let root = validated_settings(preset, name)?;
    for key in root.keys() {
        if key != "agents" && !MODEL_KEYS.contains(&key.as_str()) {
            bail!("Unknown preset setting: {key}");
        }
    }

    let Some(agents) = root.get("agents").and_then(Value::as_object) else {
        bail!("{name} must define agents");
    };
    for agent in agents.keys() {
        if !AGENTS.contains(&agent.as_str()) {
            bail!("Unknown agent: {agent}");
        }
    }

    let mut agent_settings = Vec::with_capacity(AGENTS.len());
    for agent in AGENTS {
        let Some(value) = agents.get(agent) else {
            bail!("{agent} must define a model and valid model_reasoning_effort");
        };
        let settings = validated_settings(value, agent)?;
        for key in settings.keys() {
            if !MODEL_KEYS.contains(&key.as_str()) {
                bail!("Unknown setting for {agent}: {key}");
            }
        }
        agent_settings.push((agent, model_settings(settings)));
    }

    Ok(ValidatedPreset {
        root_models: model_settings(root),
        agents: agent_settings,
    })
}

/// Extracts the model keys from a validated settings object.
fn model_settings(settings: &Map<String, Value>) -> Map<String, Value> {
    MODEL_KEYS
        .iter()
        .filter_map(|key| {
            settings
                .get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect()
}

/// Recursively merges `overlay` into `base`, replacing anything that is not an object pair.
fn deep_merge(base: &Value, overlay: &Value) -> Value {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            let mut merged = base.clone();
            for (key, overlay_value) in overlay {
                match merged.get_mut(key) {
                    Some(base_value) if base_value.is_object() && overlay_value.is_object() => {
                        let original = std::mem::take(base_value);
                        *base_value = deep_merge(&original, overlay_value);
                    }
                    Some(base_value) => *base_value = overlay_value.clone(),
                    None => {
                        merged.insert(key.clone(), overlay_value.clone());
                    }
                }
            }
            Value::Object(merged)
        }
        (_, overlay) => overlay.clone(),
    }
}

/// Rejects JSON null recursively, reporting the JSON path of the offending value.
fn reject_nulls(value: &Value, path: &str) -> Result<()> {
    match value {
        Value::Null => bail!("{path} must not contain null"),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                reject_nulls(item, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, value) in map {
                reject_nulls(value, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Snapshot of the root `config.toml` captured before any writes.
struct RootSnapshot {
    /// Raw file contents, or `None` when the file does not exist.
    contents: Option<Vec<u8>>,
    /// Parsed TOML document, empty when the file does not exist.
    config: Value,
}

/// Reads the optional root `config.toml` that existing local settings come from.
fn read_root_snapshot(config_dir: &Path) -> Result<RootSnapshot> {
    let path = config_dir.join(ROOT_CONFIG_FILE);
    let Some(contents) = read_optional(&path)? else {
        return Ok(RootSnapshot {
            contents: None,
            config: Value::Object(Map::new()),
        });
    };
    let text = std::str::from_utf8(&contents)
        .with_context(|| format!("{} is not valid UTF-8", path.display()))?;
    let config: Value =
        toml::from_str(text).with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(RootSnapshot {
        contents: Some(contents),
        config,
    })
}

/// Serializes the merged root configuration and verifies that it round-trips through TOML.
fn serialize_root(config: &Value) -> Result<String> {
    let contents = toml::to_string(config).context("failed to serialize generated config.toml")?;
    let round_trip: Value = toml::from_str(&contents)
        .context("generated config.toml did not round-trip through TOML")?;
    if &round_trip != config {
        bail!("generated config.toml did not round-trip through TOML");
    }
    Ok(contents)
}

/// A fully prepared agent configuration write.
struct AgentWrite {
    path: PathBuf,
    contents: String,
}

/// Computes every agent file write before any file is changed.
fn prepare_agent_writes(config_dir: &Path, preset: &ValidatedPreset) -> Result<Vec<AgentWrite>> {
    preset
        .agents
        .iter()
        .map(|(agent, settings)| {
            let path = config_dir.join("agents").join(format!("{agent}.toml"));
            let source = fs::read_to_string(&path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            let contents = update_models(&source, settings)
                .with_context(|| format!("failed to update {}", path.display()))?;
            Ok(AgentWrite { path, contents })
        })
        .collect()
}

/// Rewrites an agent TOML document with new model settings.
///
/// Ordinary single-line model assignments are replaced at the top of the file so comments
/// and prompts stay untouched. Unusual layouts fall back to TOML serialization, which
/// drops comments, so the result must first pass a semantic round-trip check.
fn update_models(source: &str, settings: &Map<String, Value>) -> Result<String> {
    let parsed: Value = toml::from_str(source).context("failed to parse agent configuration")?;
    let Some(parsed) = parsed.as_object() else {
        bail!("agent configuration must be a TOML table");
    };
    let mut expected = parsed.clone();
    for (key, value) in settings {
        expected.insert(key.clone(), value.clone());
    }

    let mut updated = String::new();
    for key in MODEL_KEYS {
        let value = settings
            .get(key)
            .with_context(|| format!("validated settings must define {key}"))?;
        updated.push_str(key);
        updated.push_str(" = ");
        updated.push_str(
            &serde_json::to_string(value).with_context(|| format!("failed to serialize {key}"))?,
        );
        updated.push('\n');
    }
    for line in source.split_inclusive('\n') {
        if !is_model_assignment(line) {
            updated.push_str(line);
        }
    }

    if toml::from_str::<Value>(&updated).is_ok_and(|value| value.as_object() == Some(&expected)) {
        return Ok(updated);
    }
    toml::to_string(&Value::Object(expected)).context("failed to serialize agent configuration")
}

/// Reports whether a TOML line assigns one of the root model keys.
fn is_model_assignment(line: &str) -> bool {
    MODEL_KEYS.iter().any(|key| {
        line.strip_prefix(key)
            .is_some_and(|rest| rest.trim_start().starts_with('='))
    })
}

/// Replaces the root `config.toml` atomically after re-checking for concurrent changes.
fn write_root_config(config_dir: &Path, snapshot: &RootSnapshot, contents: &str) -> Result<()> {
    let destination = config_dir.join(ROOT_CONFIG_FILE);
    let mode = if snapshot.contents.is_some() {
        Some(
            fs::metadata(&destination)
                .with_context(|| format!("failed to stat {}", destination.display()))?
                .permissions()
                .mode()
                & 0o777,
        )
    } else {
        None
    };

    assert_root_snapshot(config_dir, snapshot)?;
    let temp = TempFile::create(config_dir, contents, mode)?;
    assert_root_snapshot(config_dir, snapshot)?;
    fs::rename(temp.path(), &destination)
        .with_context(|| format!("failed to replace {}", destination.display()))?;
    temp.persist();
    Ok(())
}

/// Fails when the root `config.toml` no longer matches the captured snapshot.
fn assert_root_snapshot(config_dir: &Path, snapshot: &RootSnapshot) -> Result<()> {
    if read_optional(&config_dir.join(ROOT_CONFIG_FILE))? != snapshot.contents {
        bail!("config.toml changed while preparing configuration; no files written");
    }
    Ok(())
}

/// Reads a file, returning `None` when it does not exist.
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("failed to read {}", path.display())),
    }
}

/// Temporary file removed on drop unless persisted into place.
struct TempFile {
    path: PathBuf,
    persisted: bool,
}

impl TempFile {
    /// Creates an exclusively named temporary file next to the root `config.toml`.
    ///
    /// The file is created with mode `0600`, written, switched to `mode` when given, and
    /// flushed to disk before it is returned.
    fn create(config_dir: &Path, contents: &str, mode: Option<u32>) -> Result<Self> {
        for attempt in 0..TEMP_ATTEMPTS {
            let path = config_dir.join(temp_name(attempt));
            match open_exclusive(&path) {
                Ok(mut file) => {
                    let temp = Self {
                        path,
                        persisted: false,
                    };
                    write_temp(&mut file, contents, mode)
                        .with_context(|| format!("failed to write {}", temp.path.display()))?;
                    return Ok(temp);
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to create {}", path.display()));
                }
            }
        }
        bail!(
            "failed to create a temporary config.toml file in {}",
            config_dir.display()
        )
    }

    /// Returns the temporary file path.
    fn path(&self) -> &Path {
        &self.path
    }

    /// Keeps the temporary file after it has been moved into place.
    fn persist(mut self) {
        self.persisted = true;
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.persisted {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Opens a new file with mode `0600`, failing when the path already exists.
fn open_exclusive(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    options.open(path)
}

/// Writes and flushes temporary file contents, applying the previous mode when given.
fn write_temp(file: &mut File, contents: &str, mode: Option<u32>) -> io::Result<()> {
    file.write_all(contents.as_bytes())?;
    if let Some(mode) = mode {
        file.set_permissions(Permissions::from_mode(mode))?;
    }
    file.sync_all()
}

/// Builds a temporary file name with enough entropy to avoid collisions.
fn temp_name(attempt: u32) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!(".config.toml.{}.{nanos:x}.{attempt}.tmp", process::id())
}

/// Builds the success table rows: the root configuration followed by every agent file.
fn applied_rows(preset: &ValidatedPreset) -> Vec<(String, &str, &str)> {
    let mut rows = Vec::with_capacity(preset.agents.len() + 1);
    rows.push((
        ROOT_CONFIG_FILE.to_owned(),
        setting(&preset.root_models, MODEL_KEY),
        setting(&preset.root_models, EFFORT_KEY),
    ));
    for (agent, settings) in &preset.agents {
        rows.push((
            format!("agents/{agent}.toml"),
            setting(settings, MODEL_KEY),
            setting(settings, EFFORT_KEY),
        ));
    }
    rows
}

/// Returns a string setting, or `-` when it is absent.
fn setting<'a>(settings: &'a Map<String, Value>, key: &str) -> &'a str {
    settings.get(key).and_then(Value::as_str).unwrap_or("-")
}

/// Prints the applied configuration files with their model and reasoning effort.
fn print_applied_table(rows: &[(String, &str, &str)]) {
    let configuration_width = column_width("configuration", rows.iter().map(|row| row.0.as_str()));
    let model_width = column_width("model", rows.iter().map(|row| row.1));

    println!();
    println!(
        "  {0:<configuration_width$} │ {1:<model_width$} │ effort",
        "configuration", "model"
    );
    println!(
        "  {}─┼─{}─┼─{}",
        "─".repeat(configuration_width),
        "─".repeat(model_width),
        "─".repeat("effort".len())
    );
    for (configuration, model, effort) in rows {
        println!("  {configuration:<configuration_width$} │ {model:<model_width$} │ {effort}");
    }
    println!();
}

/// Returns the display width needed for a table column and its header.
fn column_width<'a>(header: &str, values: impl Iterator<Item = &'a str>) -> usize {
    values
        .map(|value| value.chars().count())
        .max()
        .unwrap_or(0)
        .max(header.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_agents() -> Value {
        json!({
            "Orchestrator": { "model": "gpt-5.6-sol", "model_reasoning_effort": "medium" },
            "Solo": { "model": "gpt-5.6-sol", "model_reasoning_effort": "medium" },
            "Junior": { "model": "gpt-5.6-luna", "model_reasoning_effort": "high" },
            "Explorer": { "model": "gpt-5.6-luna", "model_reasoning_effort": "medium" },
            "Librarian": { "model": "gpt-5.6-luna", "model_reasoning_effort": "medium" }
        })
    }

    fn valid_preset() -> Value {
        json!({
            "model": "gpt-5.6-sol",
            "model_reasoning_effort": "medium",
            "agents": valid_agents()
        })
    }

    fn settings(pairs: &[(&str, &str)]) -> Result<Map<String, Value>> {
        let value = json!(Map::from_iter(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), json!(value)))
        ));
        value
            .as_object()
            .cloned()
            .context("test settings must be an object")
    }

    #[test]
    fn deep_merge_merges_objects_and_replaces_other_values() {
        let base = json!({
            "scalar": 1,
            "nested": { "kept": true, "replaced": "old" },
            "items": [1, 2]
        });
        let overlay = json!({
            "scalar": 2,
            "nested": { "replaced": "new", "added": true },
            "items": [3],
            "added": "value"
        });

        let merged = deep_merge(&base, &overlay);

        assert_eq!(
            merged,
            json!({
                "scalar": 2,
                "nested": { "kept": true, "replaced": "new", "added": true },
                "items": [3],
                "added": "value"
            })
        );
        assert_eq!(deep_merge(&json!(1), &json!({ "a": 1 })), json!({ "a": 1 }));
        assert_eq!(deep_merge(&json!({ "a": 1 }), &json!(2)), json!(2));
    }

    #[test]
    fn deep_merge_keeps_base_order_and_appends_overlay_keys() {
        let base = json!({ "b": 1, "a": 2 });
        let overlay = json!({ "a": 3, "c": 4 });

        let merged = deep_merge(&base, &overlay);

        let keys: Vec<&str> = merged
            .as_object()
            .map(|object| object.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(keys, ["b", "a", "c"]);
    }

    #[test]
    fn validated_settings_accepts_valid_models() -> Result<()> {
        let settings = json!({ "model": "gpt-5.6-sol", "model_reasoning_effort": "xhigh" });

        let validated = validated_settings(&settings, "preset")?;

        assert_eq!(validated.get(MODEL_KEY), Some(&json!("gpt-5.6-sol")));
        assert_eq!(validated.get(EFFORT_KEY), Some(&json!("xhigh")));
        Ok(())
    }

    #[test]
    fn validated_settings_rejects_invalid_models() {
        let blank = json!({ "model": "  ", "model_reasoning_effort": "low" });
        let error = validated_settings(&blank, "preset").expect_err("blank model must fail");
        assert_eq!(
            error.to_string(),
            "preset must define a model and valid model_reasoning_effort"
        );

        let effort = json!({ "model": "gpt-5.6-sol", "model_reasoning_effort": "turbo" });
        assert!(validated_settings(&effort, "preset").is_err());

        assert!(validated_settings(&json!(null), "Junior").is_err());
        assert!(validated_settings(&json!([1]), "Junior").is_err());
    }

    #[test]
    fn validate_preset_extracts_root_and_agent_settings() -> Result<()> {
        let preset = valid_preset();

        let validated = validate_preset("p-openai", &preset)?;

        assert_eq!(
            validated.root_models.get(MODEL_KEY),
            Some(&json!("gpt-5.6-sol"))
        );
        assert_eq!(validated.agents.len(), AGENTS.len());
        let names: Vec<&str> = validated.agents.iter().map(|(agent, _)| *agent).collect();
        assert_eq!(names, AGENTS);
        let junior = validated
            .agents
            .iter()
            .find(|(agent, _)| *agent == "Junior")
            .map(|(_, settings)| settings)
            .context("Junior settings must be present")?;
        assert_eq!(junior.get(EFFORT_KEY), Some(&json!("high")));
        Ok(())
    }

    #[test]
    fn validate_preset_rejects_unknown_preset_settings_and_agents() {
        let mut preset = valid_preset();
        preset["model_provider"] = json!("openai");
        let error =
            validate_preset("p-openai", &preset).expect_err("unknown preset setting must fail");
        assert_eq!(error.to_string(), "Unknown preset setting: model_provider");

        let mut preset = valid_preset();
        preset["agents"]["Architect"] = valid_agents()["Solo"].clone();
        let error = validate_preset("p-openai", &preset).expect_err("unknown agent must fail");
        assert_eq!(error.to_string(), "Unknown agent: Architect");

        let mut preset = valid_preset();
        preset["agents"]["Junior"]["sandbox_mode"] = json!("workspace-write");
        let error = validate_preset("p-openai", &preset).expect_err("unknown setting must fail");
        assert_eq!(
            error.to_string(),
            "Unknown setting for Junior: sandbox_mode"
        );
    }

    #[test]
    fn validate_preset_requires_every_agent() {
        let mut preset = valid_preset();
        if let Some(agents) = preset["agents"].as_object_mut() {
            agents.remove("Junior");
        }
        let error = validate_preset("p-openai", &preset).expect_err("missing agent must fail");
        assert_eq!(
            error.to_string(),
            "Junior must define a model and valid model_reasoning_effort"
        );

        let preset = json!({ "model": "gpt-5.6-sol", "model_reasoning_effort": "low" });
        let error = validate_preset("p-openai", &preset).expect_err("missing agents must fail");
        assert_eq!(error.to_string(), "p-openai must define agents");
    }

    #[test]
    fn reject_nulls_reports_the_offending_path() {
        let value = json!({ "a": [1, { "b": null }] });

        let error = reject_nulls(&value, COMMON_FILE).expect_err("nested null must fail");

        assert_eq!(
            error.to_string(),
            "config.common.json.a[1].b must not contain null"
        );
        assert!(reject_nulls(&json!({ "a": [1, 2] }), COMMON_FILE).is_ok());
    }

    #[test]
    fn is_model_assignment_matches_only_root_model_lines() {
        assert!(is_model_assignment("model = \"x\"\n"));
        assert!(is_model_assignment("model_reasoning_effort = \"x\"\n"));
        assert!(is_model_assignment("model_reasoning_effort\t= 1"));
        assert!(!is_model_assignment("model\n"));
        assert!(!is_model_assignment("  model = \"x\"\n"));
        assert!(!is_model_assignment("model_provider = \"x\"\n"));
        assert!(!is_model_assignment("[model]\n"));
    }

    #[test]
    fn update_models_keeps_comments_and_prompts() -> Result<()> {
        let source = "# keep\nmodel = \"old\"\nmodel_reasoning_effort = \"low\"\nsandbox_mode = \"workspace-write\"\n\n[features]\nmulti_agent = true\n";

        let updated = update_models(
            source,
            &settings(&[(MODEL_KEY, "new"), (EFFORT_KEY, "high")])?,
        )?;

        assert_eq!(
            updated,
            "model = \"new\"\nmodel_reasoning_effort = \"high\"\n# keep\nsandbox_mode = \"workspace-write\"\n\n[features]\nmulti_agent = true\n"
        );
        Ok(())
    }

    #[test]
    fn update_models_falls_back_to_serialization_for_unusual_layouts() -> Result<()> {
        let source = "model = \"old\"\nmodel_reasoning_effort = \"low\"\nprompt = '''\nmodel = keep me\n'''\n";

        let updated = update_models(
            source,
            &settings(&[(MODEL_KEY, "new"), (EFFORT_KEY, "high")])?,
        )?;

        let parsed: Value = toml::from_str(&updated).context("fallback output must parse")?;
        assert_eq!(
            parsed,
            json!({
                "model": "new",
                "model_reasoning_effort": "high",
                "prompt": "model = keep me\n"
            })
        );
        Ok(())
    }

    #[test]
    fn serialize_root_round_trips_nested_tables() -> Result<()> {
        let config = json!({
            "approval_policy": "on-request",
            "model": "gpt-5.6-sol",
            "model_reasoning_effort": "medium",
            "sandbox_workspace_write": { "network_access": false },
            "agents": { "max_depth": 2 }
        });

        let contents = serialize_root(&config)?;

        let parsed: Value = toml::from_str(&contents).context("generated TOML must parse")?;
        assert_eq!(parsed, config);
        Ok(())
    }
}
