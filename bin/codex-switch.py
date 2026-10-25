#!/usr/bin/env -S pipx run

# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "tomli-w==1.2.0",
# ]
# ///

"""Generate Codex's configuration from a preset.

Merges config.common.json and the selected preset from config.presets.json into
config.toml, preserving existing local settings, and generates every
agents/*.toml from agent-templates/*.toml with the preset's model settings.
"""

import json
import os
import sys
import time
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias

import tomli_w

PRESETS_FILE = "config.presets.json"
COMMON_FILE = "config.common.json"
ROOT_CONFIG_FILE = "config.toml"
AGENTS_DIR = "agents"
TEMPLATES_DIR = "agent-templates"

AGENTS: tuple[str, ...] = ("Solo", "Junior")
MODEL_KEY = "model"
EFFORT_KEY = "model_reasoning_effort"
MODEL_KEYS: tuple[str, ...] = (MODEL_KEY, EFFORT_KEY)
EFFORTS: tuple[str, ...] = ("none", "minimal", "low", "medium", "high", "xhigh")
TEMP_ATTEMPTS = 16

CONFIG_DIR = Path(__file__).resolve().parent.parent

Json: TypeAlias = dict[str, "Json"] | list["Json"] | str | int | float | bool | None
JsonObject: TypeAlias = dict[str, Json]


class ConfigError(Exception):
    """A configuration problem, reported as one clear message, not a traceback."""


def main() -> None:
    try:
        switch(parse_args(sys.argv[1:]))
    except ConfigError as error:
        print(f"codex-switch: {error}", file=sys.stderr)
        raise SystemExit(1) from None


def parse_args(argv: list[str]) -> str | None:
    """The selected preset name, or None to print help; every other argument
    combination is a usage error.
    """
    help_count = 0
    presets: list[str] = []
    for arg in argv:
        if arg in ("-h", "--help"):
            help_count += 1
        else:
            presets.append(arg)
    if not presets and help_count <= 1:
        return None
    if len(presets) == 1 and help_count == 0:
        return presets[0]
    raise ConfigError("Usage: codex-switch <preset>")


def switch(preset_name: str | None) -> None:
    """Applies the selected preset to the root and agent configuration files."""
    presets = read_json_object(CONFIG_DIR / PRESETS_FILE, PRESETS_FILE)
    if preset_name is None:
        print_help(presets)
        return
    preset = presets.get(preset_name)
    if preset is None:
        raise ConfigError(f"Unknown preset: {preset_name}")

    common = read_json_object(CONFIG_DIR / COMMON_FILE, COMMON_FILE)
    reject_nulls(common, COMMON_FILE)
    root_snapshot = read_root_snapshot()
    validated = validate_preset(preset_name, preset)

    expected_root = merge_objects(
        merge_objects(root_snapshot.config, common), validated.root_models
    )
    reject_nulls(expected_root, ROOT_CONFIG_FILE)
    root_contents = serialize_root(expected_root)

    # Every input is validated before any configuration file changes.
    agent_writes = prepare_agent_writes(validated)
    write_root_config(root_snapshot, root_contents)
    agents_dir = CONFIG_DIR / AGENTS_DIR
    try:
        agents_dir.mkdir(exist_ok=True)
    except OSError as error:
        raise ConfigError(f"failed to create {agents_dir}: {error}") from None
    for write in agent_writes:
        try:
            write.path.write_text(write.contents, encoding="utf-8")
        except OSError as error:
            raise ConfigError(f"failed to write {write.path}: {error}") from None

    print(f"Applied preset: {preset_name}")
    print_applied_table(applied_rows(validated))


def read_json_object(path: Path, label: str) -> JsonObject:
    """The root object of a JSON file; configuration inputs must be objects."""
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise ConfigError(f"configuration file missing: {path}") from None
    except OSError as error:
        raise ConfigError(f"failed to read {path}: {error}") from None
    try:
        value = json.loads(content)
    except ValueError as error:
        raise ConfigError(f"failed to parse {label}: {error}") from None
    if not isinstance(value, dict):
        raise ConfigError(f"{label} must contain a JSON object")
    return value


def print_help(presets: JsonObject) -> None:
    print("Usage: codex-switch <preset>\n")
    print("Available presets:")
    for name in presets:
        print(f"  {name}")


def validated_settings(value: Json, label: str) -> JsonObject:
    """A model and a valid reasoning effort, or nothing."""
    if not isinstance(value, dict):
        raise ConfigError(
            f"{label} must define a model and valid model_reasoning_effort"
        )
    model = value.get(MODEL_KEY)
    effort = value.get(EFFORT_KEY)
    valid = (
        isinstance(model, str)
        and model.strip() != ""
        and isinstance(effort, str)
        and effort in EFFORTS
    )
    if not valid:
        raise ConfigError(
            f"{label} must define a model and valid model_reasoning_effort"
        )
    return value


def model_settings(settings: JsonObject) -> JsonObject:
    return {key: settings[key] for key in MODEL_KEYS if key in settings}


@dataclass(frozen=True)
class ValidatedPreset:
    """A preset ready to apply: root model keys and every agent's settings."""

    root_models: JsonObject
    agents: list[tuple[str, JsonObject]]


def validate_preset(name: str, preset: Json) -> ValidatedPreset:
    """A known-shape preset: only model keys at the root, and valid settings for
    every agent in the roster.
    """
    root = validated_settings(preset, name)
    for key in root:
        if key != "agents" and key not in MODEL_KEYS:
            raise ConfigError(f"Unknown preset setting: {key}")

    agents = root.get("agents")
    if not isinstance(agents, dict):
        raise ConfigError(f"{name} must define agents")
    for agent in agents:
        if agent not in AGENTS:
            raise ConfigError(f"Unknown agent: {agent}")

    agent_settings: list[tuple[str, JsonObject]] = []
    for agent in AGENTS:
        value = agents.get(agent)
        if value is None:
            raise ConfigError(
                f"{agent} must define a model and valid model_reasoning_effort"
            )
        settings = validated_settings(value, agent)
        for key in settings:
            if key not in MODEL_KEYS:
                raise ConfigError(f"Unknown setting for {agent}: {key}")
        agent_settings.append((agent, model_settings(settings)))

    return ValidatedPreset(root_models=model_settings(root), agents=agent_settings)


def merge_values(base: Json, overlay: Json) -> Json:
    if isinstance(base, dict) and isinstance(overlay, dict):
        return merge_objects(base, overlay)
    return overlay


def merge_objects(base: JsonObject, overlay: JsonObject) -> JsonObject:
    """Objects merge recursively; every other overlay value replaces the base."""
    return {
        **base,
        **{key: merge_values(base.get(key), value) for key, value in overlay.items()},
    }


def reject_nulls(value: Json, path: str) -> None:
    """TOML has no null; a null anywhere in the generated configuration is an error."""
    if value is None:
        raise ConfigError(f"{path} must not contain null")
    if isinstance(value, list):
        for index, item in enumerate(value):
            reject_nulls(item, f"{path}[{index}]")
    if isinstance(value, dict):
        for key, item in value.items():
            reject_nulls(item, f"{path}.{key}")


@dataclass(frozen=True)
class RootSnapshot:
    """The root config.toml captured before any writes.

    Local settings survive the switch by merging the common configuration and
    the preset into the parsed snapshot.
    """

    contents: bytes | None
    config: JsonObject


def read_root_snapshot() -> RootSnapshot:
    """The existing config.toml, or an empty config when the file does not exist."""
    path = CONFIG_DIR / ROOT_CONFIG_FILE
    try:
        contents = path.read_bytes()
    except FileNotFoundError:
        return RootSnapshot(contents=None, config={})
    except OSError as error:
        raise ConfigError(f"failed to read {path}: {error}") from None
    try:
        text = contents.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ConfigError(f"{path} is not valid UTF-8: {error}") from None
    try:
        config = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"failed to parse {path}: {error}") from None
    return RootSnapshot(contents=contents, config=config)


def serialize_root(config: JsonObject) -> str:
    """TOML that round-trips to the same configuration."""
    try:
        contents = tomli_w.dumps(config)
    except TypeError as error:
        raise ConfigError(
            f"failed to serialize generated config.toml: {error}"
        ) from None
    try:
        round_trip = tomllib.loads(contents)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(
            f"generated config.toml did not round-trip through TOML: {error}"
        ) from None
    if round_trip != config:
        raise ConfigError("generated config.toml did not round-trip through TOML")
    return contents


@dataclass(frozen=True)
class AgentWrite:
    """A fully prepared agent configuration write."""

    path: Path
    contents: str


def prepare_agent_writes(preset: ValidatedPreset) -> list[AgentWrite]:
    """Every generated agent file, computed before any file is changed."""
    writes: list[AgentWrite] = []
    for agent, settings in preset.agents:
        template = CONFIG_DIR / TEMPLATES_DIR / f"{agent}.toml"
        try:
            source = template.read_text(encoding="utf-8")
        except OSError as error:
            raise ConfigError(f"failed to read {template}: {error}") from None
        try:
            contents = update_models(source, settings)
        except ConfigError as error:
            raise ConfigError(f"failed to generate from {template}: {error}") from None
        path = CONFIG_DIR / AGENTS_DIR / f"{agent}.toml"
        writes.append(AgentWrite(path=path, contents=contents))
    return writes


def update_models(source: str, settings: JsonObject) -> str:
    """New model assignments at the top, every other line untouched.

    Unusual layouts fall back to TOML serialization, which drops comments, so
    the line-surgery result must first pass a semantic round-trip check.
    """
    try:
        parsed = tomllib.loads(source)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"failed to parse agent configuration: {error}") from None
    if not isinstance(parsed, dict):
        raise ConfigError("agent configuration must be a TOML table")
    expected = {**parsed, **settings}

    updated = "".join(f"{key} = {json.dumps(settings[key])}\n" for key in MODEL_KEYS)
    updated += "".join(
        line
        for line in source.splitlines(keepends=True)
        if not is_model_assignment(line)
    )

    try:
        if tomllib.loads(updated) == expected:
            return updated
    except tomllib.TOMLDecodeError:
        pass
    try:
        return tomli_w.dumps(expected)
    except TypeError as error:
        raise ConfigError(f"failed to serialize agent configuration: {error}") from None


def is_model_assignment(line: str) -> bool:
    return any(
        line.startswith(key) and line[len(key) :].lstrip().startswith("=")
        for key in MODEL_KEYS
    )


def read_optional(path: Path) -> bytes | None:
    """A file's bytes, or None when it does not exist."""
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ConfigError(f"failed to read {path}: {error}") from None


def assert_root_snapshot(snapshot: RootSnapshot) -> None:
    """Fails when config.toml changed since the snapshot was taken."""
    if read_optional(CONFIG_DIR / ROOT_CONFIG_FILE) != snapshot.contents:
        raise ConfigError(
            "config.toml changed while preparing configuration; no files written"
        )


def create_temp_file(contents: str, mode: int | None) -> Path:
    """An exclusively created, written, and synced temp file next to config.toml."""
    for attempt in range(TEMP_ATTEMPTS):
        path = CONFIG_DIR / temp_name(attempt)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        except OSError as error:
            raise ConfigError(f"failed to create {path}: {error}") from None
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(contents)
            if mode is not None:
                os.fchmod(file.fileno(), mode)
            os.fsync(file.fileno())
        return path
    raise ConfigError(f"failed to create a temporary config.toml file in {CONFIG_DIR}")


def temp_name(attempt: int) -> str:
    return f".config.toml.{os.getpid()}.{time.time_ns():x}.{attempt}.tmp"


def write_root_config(snapshot: RootSnapshot, contents: str) -> None:
    """Replaces config.toml atomically, re-checking for concurrent changes."""
    destination = CONFIG_DIR / ROOT_CONFIG_FILE
    mode: int | None = None
    if snapshot.contents is not None:
        try:
            mode = destination.stat().st_mode & 0o777
        except OSError as error:
            raise ConfigError(f"failed to stat {destination}: {error}") from None

    assert_root_snapshot(snapshot)
    temp_path = create_temp_file(contents, mode)
    try:
        assert_root_snapshot(snapshot)
        os.replace(temp_path, destination)
    except OSError as error:
        temp_path.unlink(missing_ok=True)
        raise ConfigError(f"failed to replace {destination}: {error}") from None
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


@dataclass(frozen=True)
class AppliedRow:
    configuration: str
    model: str
    effort: str


def applied_rows(preset: ValidatedPreset) -> list[AppliedRow]:
    rows = [
        AppliedRow(
            configuration=ROOT_CONFIG_FILE,
            model=setting(preset.root_models, MODEL_KEY),
            effort=setting(preset.root_models, EFFORT_KEY),
        )
    ]
    rows += [
        AppliedRow(
            configuration=f"{AGENTS_DIR}/{agent}.toml",
            model=setting(settings, MODEL_KEY),
            effort=setting(settings, EFFORT_KEY),
        )
        for agent, settings in preset.agents
    ]
    return rows


def setting(settings: JsonObject, key: str) -> str:
    value = settings.get(key)
    return value if isinstance(value, str) else "-"


def column_width(header: str, values: Iterable[str]) -> int:
    return max([len(header), *(len(value) for value in values)])


def print_applied_table(rows: list[AppliedRow]) -> None:
    configuration_width = column_width(
        "configuration", (row.configuration for row in rows)
    )
    model_width = column_width("model", (row.model for row in rows))

    print()
    print(
        f"  {'configuration':<{configuration_width}} │ {'model':<{model_width}} │ effort"
    )
    print(
        f"  {'─' * configuration_width}─┼─{'─' * model_width}─┼─{'─' * len('effort')}"
    )
    for row in rows:
        print(
            f"  {row.configuration:<{configuration_width}} │ {row.model:<{model_width}} │ {row.effort}"
        )
    print()


if __name__ == "__main__":
    main()
