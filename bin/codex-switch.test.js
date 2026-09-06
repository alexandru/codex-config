"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parse, stringify } = require("smol-toml");

const repoRoot = path.resolve(__dirname, "..");
const switcher = path.join(repoRoot, "bin", "codex-switch.js");
const wrapper = path.join(repoRoot, "bin", "codex-switch");
const agentNames = ["Orchestrator", "Junior", "Explorer", "Librarian"];
const configFiles = [
  "config.toml",
  ...agentNames.map((name) => `agents/${name}.toml`),
  "config.presets.json",
  "config.common.json",
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

function outputPaths(fixture) {
  return configFiles
    .filter((file) => file.endsWith(".toml"))
    .map((file) => path.join(fixture, file));
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
  for (const file of configFiles.filter((file) => file !== "config.toml")) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(fixture, file));
  }
  const common = JSON.parse(fs.readFileSync(path.join(fixture, "config.common.json"), "utf8"));
  fs.writeFileSync(
    path.join(fixture, "config.toml"),
    stringify({
      model: "fixture-root-model",
      model_reasoning_effort: "low",
      ...common,
      features: {
        ...common.features,
        unknown_nested: { preserved: true },
      },
      projects: {
        "/example/project": { trust_level: "trusted" },
      },
      tui: {
        model_availability_nux: { "fixture-model": 1 },
      },
    })
  );
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(fixture, "node_modules"), "dir");
  return fixture;
}

function createMissingRootFixture() {
  const fixture = createFixture();
  fs.unlinkSync(path.join(fixture, "config.toml"));
  return fixture;
}

function editPresets(fixture, edit) {
  const file = path.join(fixture, "config.presets.json");
  const presets = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(presets);
  fs.writeFileSync(file, `${JSON.stringify(presets, null, 2)}\n`);
}

function editCommon(fixture, edit) {
  const file = path.join(fixture, "config.common.json");
  const common = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(common);
  fs.writeFileSync(file, `${JSON.stringify(common, null, 2)}\n`);
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

test("a missing root generates common settings and selected root models", (t) => {
  const fixture = createMissingRootFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const result = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  const config = parseConfig(fixture, "config.toml");
  assert.equal(config.model, "gpt-6-astra");
  assert.equal(config.model_reasoning_effort, "medium");
  assert.equal(config.approval_policy, "on-request");
  assert.equal(config.features.context_management.experimental_mode, true);
  assert.equal(config.agents.max_depth, 2);
  assert.equal(config.permissions.librarian.network.enabled, true);
  assert.equal(fs.statSync(path.join(fixture, "config.toml")).mode & 0o777, 0o600);
});

test("root generation keeps local project, tui, and unknown feature values", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const result = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  const config = parseConfig(fixture, "config.toml");
  assert.equal(config.projects["/example/project"].trust_level, "trusted");
  assert.equal(config.tui.model_availability_nux["fixture-model"], 1);
  assert.equal(config.features.unknown_nested.preserved, true);
});

test("common values win recursively and arrays replace local arrays", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const rootFile = path.join(fixture, "config.toml");
  const root = parseConfig(fixture, "config.toml");
  root.features.context_management = { experimental_mode: false, local_only: true };
  root.features.local_array = ["local"];
  root.local_only = "retained";
  fs.writeFileSync(rootFile, stringify(root));
  editCommon(fixture, (common) => {
    common.features.context_management = { experimental_mode: true };
    common.features.local_array = ["common"];
  });

  const result = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  const config = parseConfig(fixture, "config.toml");
  assert.deepEqual(config.features.context_management, {
    experimental_mode: true,
    local_only: true,
  });
  assert.deepEqual(config.features.local_array, ["common"]);
  assert.equal(config.local_only, "retained");
});

test("omitted common keys retain local values and preset model values win", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const rootFile = path.join(fixture, "config.toml");
  const root = parseConfig(fixture, "config.toml");
  root.model = "local-model";
  root.model_reasoning_effort = "none";
  root.approval_policy = "local-approval";
  root.local_setting = "retained";
  fs.writeFileSync(rootFile, stringify(root));
  editCommon(fixture, (common) => {
    delete common.approval_policy;
    common.model = "common-model";
    common.model_reasoning_effort = "high";
  });

  const result = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  const config = parseConfig(fixture, "config.toml");
  assert.equal(config.model, "gpt-6-astra");
  assert.equal(config.model_reasoning_effort, "medium");
  assert.equal(config.local_setting, "retained");
  assert.equal(config.approval_policy, "local-approval");
});

test("p-openai applies the requested models and preserves non-model fields", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const paths = allConfigPaths(fixture);
  const before = snapshot(paths);
  const rootStat = fs.statSync(path.join(fixture, "config.toml"));

  const result = runScript(fixture, ["p-openai"], os.tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assertModels(fixture, {
    "config.toml": { model: "gpt-6-astra", model_reasoning_effort: "medium" },
    "agents/Orchestrator.toml": {
      model: "gpt-6-astra",
      model_reasoning_effort: "medium",
    },
    "agents/Junior.toml": {
      model: "gpt-5.6-luna",
      model_reasoning_effort: "high",
    },
    "agents/Explorer.toml": {
      model: "gpt-5.6-luna",
      model_reasoning_effort: "medium",
    },
    "agents/Librarian.toml": {
      model: "gpt-5.6-luna",
      model_reasoning_effort: "medium",
    },
  });
  assertNonModelFieldsUnchanged(fixture, before);
  const updatedRootStat = fs.statSync(path.join(fixture, "config.toml"));
  assert.equal(updatedRootStat.mode & 0o777, rootStat.mode & 0o777);
  assert.notEqual(updatedRootStat.ino, rootStat.ino);

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

for (const [label, value] of [
  ["missing common JSON", undefined],
  ["malformed common JSON", "{\n"],
  ["null common JSON", "null\n"],
  ["array common JSON", "[]\n"],
  ["nested null common JSON", '{"features":{"bad":null}}\n'],
]) {
  test(`${label} fails without modifying outputs`, (t) => {
    const fixture = createFixture();
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const commonFile = path.join(fixture, "config.common.json");
    if (value === undefined) fs.unlinkSync(commonFile);
    else fs.writeFileSync(commonFile, value);
    const paths = outputPaths(fixture);
    const before = snapshot(paths);
    const result = runScript(fixture, ["p-openai"], os.tmpdir());
    expectFailure(result);
    assertSnapshotUnchanged(before, paths);
  });
}

for (const [label, file, contents] of [
  ["root TOML", "config.toml", "model = [\n"],
  ["last agent TOML", "agents/Librarian.toml", "model = [\n"],
]) {
  test(`malformed ${label} fails without modifying outputs`, (t) => {
    const fixture = createFixture();
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.writeFileSync(path.join(fixture, file), contents);
    const paths = outputPaths(fixture);
    const before = snapshot(paths);
    const result = runScript(fixture, ["p-openai"], os.tmpdir());
    expectFailure(result);
    assertSnapshotUnchanged(before, paths);
  });
}

test("root replacement detects a concurrent root change before rename", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const rootFile = path.join(fixture, "config.toml");
  const beforeRoot = fs.readFileSync(rootFile);
  const beforeAgents = snapshot(
    agentNames.map((name) => path.join(fixture, "agents", `${name}.toml`))
  );
  const preload = path.join(fixture, "preload.js");
  fs.writeFileSync(preload, `
    const fs = require("node:fs");
    const path = require("node:path");
    const target = ${JSON.stringify(rootFile)};
    const readFileSync = fs.readFileSync.bind(fs);
    const writeFileSync = fs.writeFileSync.bind(fs);
    let reads = 0;
    fs.readFileSync = (file, ...args) => {
      const result = readFileSync(file, ...args);
      if (path.resolve(file) === target && ++reads === 2) {
        writeFileSync(file, Buffer.concat([result, Buffer.from("\\n# concurrent change\\n")]));
      }
      return result;
    };
  `);
  const result = run(
    process.execPath,
    ["--require", preload, path.join(fixture, "bin", "codex-switch.js"), "p-openai"],
    os.tmpdir()
  );
  expectFailure(result);
  assert.match(result.stderr, /changed while preparing configuration/);
  assert.notDeepEqual(fs.readFileSync(rootFile), beforeRoot);
  assertSnapshotUnchanged(beforeAgents, [...beforeAgents.keys()]);
  assert.equal(
    fs.readdirSync(fixture).some((file) => file.startsWith(".config.toml.")),
    false
  );
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
  assert.equal(after.prompt, before.prompt);
  assert.equal(after.approval_policy, "on-request");
  assert.equal(after.features.context_management.experimental_mode, true);
});
