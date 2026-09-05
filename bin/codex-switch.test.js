"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parse } = require("smol-toml");

const repoRoot = path.resolve(__dirname, "..");
const switcher = path.join(repoRoot, "bin", "codex-switch.js");
const wrapper = path.join(repoRoot, "bin", "codex-switch");
const agentNames = ["Orchestrator", "Junior", "Explorer", "Librarian"];
const configFiles = [
  "config.toml",
  ...agentNames.map((name) => `agents/${name}.toml`),
  "config.presets.json",
];

function run(command, args, cwd) {
  return childProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });
}

function runScript(fixture, args = [], cwd = fixture) {
  return run(process.execPath, [path.join(fixture, "bin", "codex-switch.js"), ...args], cwd);
}

function allConfigPaths(fixture) {
  return configFiles.map((file) => path.join(fixture, file));
}

function snapshot(paths) {
  return new Map(paths.map((file) => [file, fs.readFileSync(file)]));
}

function assertSnapshotUnchanged(before, paths) {
  for (const file of paths) {
    assert.deepEqual(fs.readFileSync(file), before.get(file), file);
  }
}

function parseConfig(fixture, file) {
  return parse(fs.readFileSync(path.join(fixture, file), "utf8"));
}

function withoutModelFields(config) {
  const result = { ...config };
  delete result.model;
  delete result.model_reasoning_effort;
  return result;
}

function assertModels(fixture, expected) {
  for (const [file, settings] of Object.entries(expected)) {
    const config = parseConfig(fixture, file);
    assert.equal(config.model, settings.model, `${file} model`);
    assert.equal(
      config.model_reasoning_effort,
      settings.model_reasoning_effort,
      `${file} model_reasoning_effort`
    );
  }
}

function assertNonModelFieldsUnchanged(fixture, before) {
  for (const file of configFiles.filter((file) => file.endsWith(".toml"))) {
    assert.deepEqual(
      withoutModelFields(parse(before.get(path.join(fixture, file)).toString("utf8"))),
      withoutModelFields(parseConfig(fixture, file)),
      `${file} non-model fields`
    );
  }
}

function createFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
  fs.mkdirSync(path.join(fixture, "bin"));
  fs.mkdirSync(path.join(fixture, "agents"));
  fs.copyFileSync(switcher, path.join(fixture, "bin", "codex-switch.js"));
  fs.copyFileSync(wrapper, path.join(fixture, "bin", "codex-switch"));
  fs.chmodSync(path.join(fixture, "bin", "codex-switch"), 0o755);
  for (const file of configFiles) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(fixture, file));
  }
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(fixture, "node_modules"), "dir");
  return fixture;
}

function editPresets(fixture, edit) {
  const file = path.join(fixture, "config.presets.json");
  const presets = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(presets);
  fs.writeFileSync(file, `${JSON.stringify(presets, null, 2)}\n`);
}

function expectFailure(result) {
  assert.notEqual(result.status, 0);
  assert.equal(result.error, undefined);
}

test("no args and help list p-openai without writes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const paths = allConfigPaths(fixture);
  const before = snapshot(paths);

  for (const args of [[], ["--help"]]) {
    const result = runScript(fixture, args, os.tmpdir());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /p-openai/);
    assertSnapshotUnchanged(before, paths);
  }
});

test("p-openai applies the requested models and preserves non-model fields", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const paths = allConfigPaths(fixture);
  const before = snapshot(paths);

  const result = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assertModels(fixture, {
    "config.toml": { model: "gpt-6-astra", model_reasoning_effort: "medium" },
    "agents/Orchestrator.toml": {
      model: "gpt-6-astra",
      model_reasoning_effort: "medium",
    },
    "agents/Junior.toml": {
      model: "gpt-5.6-luna-fast",
      model_reasoning_effort: "high",
    },
    "agents/Explorer.toml": {
      model: "gpt-5.6-luna-fast",
      model_reasoning_effort: "medium",
    },
    "agents/Librarian.toml": {
      model: "gpt-5.6-luna-fast",
      model_reasoning_effort: "medium",
    },
  });
  assertNonModelFieldsUnchanged(fixture, before);

  const after = snapshot(paths);
  const repeated = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(repeated.status, 0, repeated.stderr);
  for (const file of paths) assert.deepEqual(fs.readFileSync(file), after.get(file), file);
});

test("a complete second preset switches every configuration file", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  editPresets(fixture, (presets) => {
    presets.other = {
      model: "model-root-other",
      model_reasoning_effort: "low",
      agents: {
        Orchestrator: { model: "model-orchestrator-other", model_reasoning_effort: "none" },
        Junior: { model: "model-junior-other", model_reasoning_effort: "minimal" },
        Explorer: { model: "model-explorer-other", model_reasoning_effort: "xhigh" },
        Librarian: { model: "model-librarian-other", model_reasoning_effort: "high" },
      },
    };
  });
  const result = runScript(fixture, ["other"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assertModels(fixture, {
    "config.toml": { model: "model-root-other", model_reasoning_effort: "low" },
    "agents/Orchestrator.toml": {
      model: "model-orchestrator-other",
      model_reasoning_effort: "none",
    },
    "agents/Junior.toml": {
      model: "model-junior-other",
      model_reasoning_effort: "minimal",
    },
    "agents/Explorer.toml": {
      model: "model-explorer-other",
      model_reasoning_effort: "xhigh",
    },
    "agents/Librarian.toml": {
      model: "model-librarian-other",
      model_reasoning_effort: "high",
    },
  });
});

for (const name of ["unknown", "toString", "__proto__"]) {
  test(`${name} preset fails without writes`, (t) => {
    const fixture = createFixture();
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const paths = allConfigPaths(fixture);
    const before = snapshot(paths);
    expectFailure(runScript(fixture, [name], os.tmpdir()));
    assertSnapshotUnchanged(before, paths);
  });
}

test("extra args fail without writes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const paths = allConfigPaths(fixture);
  const before = snapshot(paths);
  expectFailure(runScript(fixture, ["p-openai", "extra"], os.tmpdir()));
  assertSnapshotUnchanged(before, paths);
});

for (const [label, edit] of [
  ["missing agent", (presets) => delete presets["p-openai"].agents.Junior],
  ["unknown agent", (presets) => {
    presets["p-openai"].agents.Unknown = {
      model: "valid-model",
      model_reasoning_effort: "medium",
    };
  }],
  ["invalid effort", (presets) => {
    presets["p-openai"].model_reasoning_effort = "invalid";
  }],
]) {
  test(`${label} fails before writing`, (t) => {
    const fixture = createFixture();
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    editPresets(fixture, edit);
    const paths = allConfigPaths(fixture);
    const before = snapshot(paths);
    expectFailure(runScript(fixture, ["p-openai"], os.tmpdir()));
    assertSnapshotUnchanged(before, paths);
  });
}

test("malformed TOML fails before writing", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, "agents", "Librarian.toml"), "malformed = [\n");
  const paths = allConfigPaths(fixture);
  const before = snapshot(paths);
  expectFailure(runScript(fixture, ["p-openai"], os.tmpdir()));
  assertSnapshotUnchanged(before, paths);
});

test("alternate cwd and symlinked wrapper invocation work", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const link = path.join(fixture, "bin", "switch-link");
  fs.symlinkSync("codex-switch", link);
  const result = run(link, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseConfig(fixture, "config.toml").model, "gpt-6-astra");
  assert.equal(
    parseConfig(fixture, "agents/Junior.toml").model_reasoning_effort,
    "high"
  );
});

test("multiline and nested model keys preserve fallback semantics", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const file = path.join(fixture, "config.toml");
  fs.writeFileSync(
    file,
    [
      'model = """',
      "legacy multiline model",
      '"""',
      'model_reasoning_effort = "low"',
      'prompt = "keep this"',
      "[nested]",
      'model = "nested-model"',
      'prompt = "nested prompt"',
      "",
    ].join("\n")
  );
  const before = parseConfig(fixture, "config.toml");
  const result = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  const after = parseConfig(fixture, "config.toml");
  assert.equal(after.model, "gpt-6-astra");
  assert.equal(after.model_reasoning_effort, "medium");
  assert.equal(after.nested.model, before.nested.model);
  assert.equal(after.nested.prompt, before.nested.prompt);
  assert.deepEqual(withoutModelFields(after), withoutModelFields(before));
});
