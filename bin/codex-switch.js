#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { parse, stringify } = require("smol-toml");

const root = path.resolve(__dirname, "..");
const agents = ["Orchestrator", "Junior", "Explorer", "Librarian"];
const modelKeys = ["model", "model_reasoning_effort"];
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function validateModel(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.model !== "string" || !value.model.trim() ||
      !efforts.has(value.model_reasoning_effort)) {
    throw new Error(`${label} must define a model and valid model_reasoning_effort`);
  }
}

function updateModels(source, settings) {
  const expected = { ...parse(source), ...settings };
  // Keep comments and agent prompts unchanged for ordinary single-line settings.
  let updated = source;
  for (const key of modelKeys) {
    updated = updated.replace(new RegExp(`^${key}\\s*=.*(?:\\r?\\n|$)`, "gm"), "");
  }
  updated = modelKeys.map(key => `${key} = ${JSON.stringify(settings[key])}\n`).join("") + updated;
  try {
    if (isDeepStrictEqual(parse(updated), expected)) return updated;
  } catch {
    // Unusual TOML layouts are handled by the serializer instead.
  }
  return stringify(expected);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepMerge(base, overlay) {
  if (!isPlainRecord(base) || !isPlainRecord(overlay)) return overlay;
  const keys = new Set([...Object.keys(base), ...Object.keys(overlay)]);
  return Object.fromEntries([...keys].map((key) => [
    key,
    Object.hasOwn(overlay, key)
      ? (Object.hasOwn(base, key) ? deepMerge(base[key], overlay[key]) : overlay[key])
      : base[key],
  ]));
}

function rejectNulls(value, label, path = label) {
  if (value === null) throw new Error(`${path} must not contain null`);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectNulls(item, label, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(value)) rejectNulls(value[key], label, `${path}.${key}`);
}

function readCommon() {
  const file = path.join(root, "config.common.json");
  const common = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isPlainRecord(common)) throw new Error("config.common.json must contain a JSON object");
  rejectNulls(common, "config.common.json");
  return common;
}

function readOptionalRoot() {
  const file = path.join(root, "config.toml");
  try {
    const contents = fs.readFileSync(file);
    return { exists: true, contents, config: parse(contents.toString("utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { exists: false, contents: undefined, config: {} };
  }
}

function readRootSnapshot() {
  const file = path.join(root, "config.toml");
  try {
    return { exists: true, contents: fs.readFileSync(file) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { exists: false, contents: undefined };
  }
}

function assertRootSnapshot(snapshot) {
  const current = readRootSnapshot();
  if (current.exists !== snapshot.exists ||
      (current.exists && !current.contents.equals(snapshot.contents))) {
    throw new Error("config.toml changed while preparing configuration; no files written");
  }
}

function createRootTemp(contents, mode) {
  const directory = path.dirname(path.join(root, "config.toml"));
  let file;
  let descriptor;
  try {
    for (;;) {
      const candidate = path.join(directory, `.config.toml.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
      try {
        descriptor = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        file = candidate;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    fs.writeFileSync(descriptor, contents, "utf8");
    if (mode !== undefined) fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return file;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (file !== undefined) fs.rmSync(file, { force: true });
    throw error;
  }
}

function main() {
  const presets = JSON.parse(fs.readFileSync(path.join(root, "config.presets.json"), "utf8"));
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ["-h", "--help"].includes(args[0]))) {
    console.log("Usage: codex-switch <preset>\n\nAvailable presets:");
    for (const name of Object.keys(presets)) console.log(`  ${name}`);
    return;
  }
  if (args.length !== 1) throw new Error("Usage: codex-switch <preset>");
  const name = args[0];
  if (!Object.hasOwn(presets, name)) throw new Error(`Unknown preset: ${name}`);
  const preset = presets[name];
  const common = readCommon();
  const rootSnapshot = readOptionalRoot();
  validateModel(preset, name);
  for (const key of Object.keys(preset)) {
    if (![...modelKeys, "agents"].includes(key)) throw new Error(`Unknown preset setting: ${key}`);
  }
  if (!preset.agents || typeof preset.agents !== "object" || Array.isArray(preset.agents)) {
    throw new Error(`${name} must define agents`);
  }
  for (const agent of Object.keys(preset.agents)) {
    if (!agents.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
  }
  const targets = [["config.toml", preset]];
  for (const agent of agents) {
    const settings = preset.agents[agent];
    validateModel(settings, agent);
    for (const key of Object.keys(settings)) {
      if (!modelKeys.includes(key)) throw new Error(`Unknown setting for ${agent}: ${key}`);
    }
    targets.push([`agents/${agent}.toml`, settings]);
  }
  // Validate every input before writing any configuration files.
  const rootModels = Object.fromEntries(modelKeys.map(key => [key, preset[key]]));
  const expectedRoot = deepMerge(deepMerge(rootSnapshot.config, common), rootModels);
  rejectNulls(expectedRoot, "generated config.toml");
  const rootContents = stringify(expectedRoot);
  if (!isDeepStrictEqual(parse(rootContents), expectedRoot)) {
    throw new Error("generated config.toml did not round-trip through TOML");
  }
  const writes = targets.slice(1).map(([file, settings]) => {
    const destination = path.join(root, file);
    const models = Object.fromEntries(modelKeys.map(key => [key, settings[key]]));
    return [destination, updateModels(fs.readFileSync(destination, "utf8"), models)];
  });
  const rootFile = path.join(root, "config.toml");
  let rootTemp;
  try {
    let mode;
    if (rootSnapshot.exists) mode = fs.statSync(rootFile).mode & 0o777;
    assertRootSnapshot(rootSnapshot);
    rootTemp = createRootTemp(rootContents, mode);
    assertRootSnapshot(rootSnapshot);
    fs.renameSync(rootTemp, rootFile);
    rootTemp = undefined;
    for (const [file, contents] of writes) fs.writeFileSync(file, contents);
  } finally {
    if (rootTemp !== undefined) fs.rmSync(rootTemp, { force: true });
  }
  console.log(`Applied preset: ${name}`);
  console.table(targets.map(([file, settings]) => ({
    configuration: file,
    model: settings.model,
    effort: settings.model_reasoning_effort,
  })));
}

try {
  main();
} catch (error) {
  console.error(`codex-switch: ${error.message}`);
  process.exitCode = 1;
}
