#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
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
  const writes = targets.map(([file, settings]) => {
    const destination = path.join(root, file);
    const models = Object.fromEntries(modelKeys.map(key => [key, settings[key]]));
    return [destination, updateModels(fs.readFileSync(destination, "utf8"), models)];
  });
  for (const [file, contents] of writes) fs.writeFileSync(file, contents);
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
