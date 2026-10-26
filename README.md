# My Codex configuration

Part of [alexandru/agents-config](https://github.com/alexandru/agents-config).

## Installation

<details>
<summary>STEP 1 — Install</summary>

### Install

```bash
curl -fsSL https://alexandru.github.io/codex-config/install.sh | bash
```

If the path is not standard, set `CODEX_HOME` in `~/.zshrc`, `~/.bashrc`, or `~/.profile`:
```sh
export CODEX_HOME=/absolute/path/to/codex-config
```

The skills are installed under `~/.agents/skills`, where Codex, OpenCode,
Copilot CLI, and Pi can share them.

### Windows (PowerShell)

Requires Git. Default directory: `C:\Users\<username>\.codex`.

For a fresh Codex installation (no history):

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $false
    $codexHome = Join-Path $env:USERPROFILE '.codex'
    git clone https://github.com/alexandru/codex-config.git $codexHome
    if ($LASTEXITCODE -ne 0) { throw 'Git clone failed.' }
    git -C $codexHome config --local status.showUntrackedFiles no
    if ($LASTEXITCODE -ne 0) { throw 'Git config failed.' }
}
```

For an existing installation, close Codex and back up `.codex`. This preserves sessions but overwrites matching files; a failed copy may leave partial updates.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $false
    $codexHome = Join-Path $env:USERPROFILE '.codex'
    $cloneDir = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-config-' + [guid]::NewGuid())
    git clone https://github.com/alexandru/codex-config.git $cloneDir
    if ($LASTEXITCODE -ne 0) { throw 'Git clone failed.' }

    robocopy $cloneDir $codexHome /E
    if ($LASTEXITCODE -ge 8) { throw "Copy failed; temporary clone retained at $cloneDir" }
    git -C $codexHome config --local status.showUntrackedFiles no
    if ($LASTEXITCODE -ne 0) { throw "Git config failed; temporary clone retained at $cloneDir" }
    Remove-Item -LiteralPath $cloneDir -Recurse -Force
}
```

For a nonstandard directory:

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $env:CODEX_HOME = 'D:\codex-config'
    [Environment]::SetEnvironmentVariable('CODEX_HOME', $env:CODEX_HOME, 'User')
}
```
</details>

<details>
<summary>STEP 2 — Choose a configuration preset (optional)</summary>

### Choose a configuration preset (optional)

The [codex-switch](./bin/codex-switch.py) utility switches the default model and the models assigned to your agents.

```bash
(
  set -e
  # List available presets
  ~/.codex/bin/codex-switch

  # Apply a preset
  ~/.codex/bin/codex-switch default
)
```

The switcher generates your local `config.toml` from:

- [config.common.json](./config.common.json)
- [config.presets.json](./config.presets.json)

`config.toml` is not tracked by Git. Existing local settings, such as project
trust entries, are preserved unless overridden by the shared configuration.

Run the switcher between Codex sessions. Command-line model overrides and
project configuration can override the selected defaults.
</details>

## Defined agents

Main agents:

- [Orchestrator](./AGENTS.md) (default agent): designs and implements changes; delegates evidence, research, and execution to Junior.
- [Solo](./agent-templates/Solo.toml): designs and implements changes; works directly.

Sub-agents:

- [Junior](./agent-templates/Junior.toml): codebase and external evidence gathering, bounded execution, mechanical work.

## Shared skills

- [alexandru/skills](https://github.com/alexandru/skills/tree/v13.2.6)
  - `code-review`: user-invoked adapter for `code-reviewing`.
  - `code-reviewing`: review changed code for bugs, structural problems, performance issues, and unintended behavior.
  - `code-refine`: behavior-preserving refinement using the `code-refinements` lenses.
  - `code-refinements`: refinement lenses of constraints, simplicity, and parametricity.
  - `external-research`: research external documentation, public repositories, and dependency artifacts with a persistent cache.
- [mattpocock/skills](https://github.com/mattpocock/skills/tree/v1.3.1)
  - `codebase-design`: deep-module design vocabulary and principles.
  - `diagnosing-bugs`: disciplined diagnosis for hard bugs and regressions.
  - `domain-modeling`: domain language and architectural decisions.
  - `grill-me`: user-invoked adapter for `grilling`.
  - `grill-with-docs`: sharpen a plan or design while creating domain documentation.
  - `grilling`: structured decision-tree interviews.
  - `handoff`: prepare context for another agent or session.
  - `implement`: implement work from a specification or set of tickets.
  - `improve-codebase-architecture`: find and work through codebase architecture improvements.
  - `setup-matt-pocock-skills`: configure a repository for the engineering skills.
  - `tdd`: test-first development guidance.
  - `teach`: teach the user a topic through a stateful learning workspace with lessons and reference documents.
  - `to-spec`: turn the current conversation into a published specification.
  - `to-tickets`: break a plan or specification into tracer-bullet tickets.
- [VirtusLab/cellar](https://github.com/VirtusLab/cellar/)
  - `cellar`: query the APIs of JVM dependencies (Scala, Java).
- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)
  - `caveman`: token-efficient response modes with preserved technical accuracy.

## Updating shared skills

```sh
make update-skills
```

This reinstalls the configured global skill roster from its upstream sources.
