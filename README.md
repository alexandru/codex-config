# My Codex configuration

Part of [alexandru/agents-config](https://github.com/alexandru/agents-config).

## Installation

<details>
<summary>STEP 1 — Clone the repository</summary>

### Clone the repository

**WARN** — This is for a fresh Copilot instalation (no history):
```sh
git clone https://github.com/alexandru/codex-config.git ~/.codex
```

**WARN:** This is Codex's working directory, so you may already have a `~/.codex` that you may need to delete, in which case you could lose all your sessios. An alternative would be...
```sh
if [[ -d ~/.codex ]]; then
  # Clones in temporary directory
  git clone https://github.com/alexandru/codex-config.git /tmp/codex-config
  echo
  # Sync all the files from clone to your working dir
  rsync -rcv /tmp/codex-config/ ~/.codex/
  # Doing some index cleanup
  cd ~/.codex
  git pull
  # Cleanup
  rm -rf /tmp/codex-config
else
  git clone https://github.com/alexandru/codex-config.git ~/.codex
fi 
```

If the path is not standard, set `CODEX_HOME` in `~/.zshrc`, `~/.bashrc`, or `~/.profile`:
```sh
export CODEX_HOME=/absolute/path/to/codex-config
```
</details>

<details>
<summary>STEP 2 — Install the shared skills globally</summary>

### Install the shared skills globally

```sh
cd ~/.codex
make install-skills
```

The skills are installed under `~/.agents/skills`, where Codex, OpenCode, and
Copilot CLI can share them.
</details>

<details>
<summary>STEP 3 — Choose a configuration preset</summary>

### Choose a configuration preset

The [codex-switch](./bin/codex-switch.js) utility switches the default model and
the models assigned to your agents. It requires Node.js 18 or newer and npm.

```sh
# List available presets
./bin/codex-switch

# Apply a preset
./bin/codex-switch p-openai
```

The switcher reads [config.presets.json](./config.presets.json) and updates the
model and reasoning effort in [config.toml](./config.toml) and the files under
[agents](./agents). It preserves unrelated settings and agent instructions.
It resolves paths relative to this repository, even when invoked from another
directory or through a symlink.

The `p-openai` preset uses `gpt-6-astra` with `medium` effort for the default
model and Orchestrator, `gpt-5.6-luna-fast` with `high` effort for Junior, and
`gpt-5.6-luna-fast` with `medium` effort for Explorer and Librarian.

To add a preset, copy the `p-openai` entry under a new name and edit its model
settings. Each preset must specify the default and all four agents, so switching
does not retain model assignments from the previous preset.

Start a new Codex session after switching. Command-line model overrides and
project configuration can override the selected defaults.
</details>

<details>
<summary>STEP 4 — Install Cellar (optional)</summary>

### Install Cellar (optional)

[Cellar](https://github.com/VirtusLab/cellar) is useful for JVM dependency API lookup, and this repo's [Makefile](./Makefile) also installs its associated skill.

Install [Coursier](https://get-coursier.io/docs/cli-installation) first:

```sh
## MacOS
brew install coursier/formulas/coursier
cs setup

## Linux x86-64 (aka AMD64)
curl -fL "https://github.com/coursier/launchers/raw/master/cs-x86_64-pc-linux.gz" | gzip -d > cs

## Linux ARM64
curl -fL "https://github.com/VirtusLab/coursier-m1/releases/latest/download/cs-aarch64-pc-linux.gz" | gzip -d > cs
```

Then install Cellar via Coursier:

```sh
cs install --contrib cellar
cellar --version

# Disable telemetry
cellar telemetry disable
```
</details>

## Defined agents

Main agents:

- `Orchestrator ([default](./AGENTS.md) + [agent](./agents/Orchestrator.toml)): designs and implements changes; delegates evidence, research, and checks.

Sub-agents:

- [Junior](./agents/Junior.toml): bounded execution, mechanical work.
- [Explorer](./agents/Explorer.toml): read-only codebase evidence gathering.
- [Librarian](./agents/Librarian.toml): read-only external documentation and dependency-source research.

## Shared skills

- [alexandru/skills](https://github.com/alexandru/skills/)
  - `code-review`: review changed code for bugs, structural problems, performance issues, and unintended behavior.
  - `simplify`: behavior-preserving code cleanup.
- [mattpocock/skills](https://github.com/mattpocock/skills/tree/v1.2.3)
  - `codebase-design`: deep-module design vocabulary and principles.
  - `diagnosing-bugs`: disciplined diagnosis for hard bugs and regressions.
  - `domain-modeling`: domain language and architectural decisions.
  - `grill-with-docs`: sharpen a plan or design while creating domain documentation.
  - `grilling`: structured decision-tree interviews.
  - `handoff`: prepare context for another agent or session.
  - `implement`: implement work from a specification or set of tickets.
  - `improve-codebase-architecture`: find and work through codebase architecture improvements.
  - `resolving-merge-conflicts`: merge and rebase conflict resolution.
  - `setup-matt-pocock-skills`: configure a repository for the engineering skills.
  - `tdd`: test-first development guidance.
  - `to-spec`: turn the current conversation into a published specification.
  - `to-tickets`: break a plan or specification into tracer-bullet tickets.
- [VirtusLab/cellar](https://github.com/VirtusLab/cellar/)
  - `cellar`: query the APIs of JVM dependencies (Scala, Java).
- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)
  - `caveman`: token-efficient response modes with preserved technical accuracy.
- [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop)
  - `unslop`: remove AI writing patterns and add a human voice.

## Updating shared skills

```sh
make update-skills
```

This reinstalls the configured global skill roster from its upstream sources.
