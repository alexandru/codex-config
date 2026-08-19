# Codex Config

Codex configuration lives in this repository. Clone it to `~/.codex`, or set `CODEX_HOME` to the clone path:

```bash
git clone --recurse-submodules git@github.com:alexandru/codex-config.git ~/.codex
# or: export CODEX_HOME=/path/to/agents-config/codex
```

`CODEX_HOME` contains authentication, session, history, log, cache, and other runtime state. These files are gitignored. Never force-add or commit them.

`.agents -> .` is a tracked symlink for `npx skills add`, making the repository `skills/` directory its installation target. `skills/` setup intentionally mirrors other harnesses. Codex CLI 0.148.0 discovers skills directly from `$CODEX_HOME/skills`; `.agents` exists for installer compatibility.

Safety defaults are `workspace-write`, `on-request`, and `auto-review`. Normal workspace commands are not all model-reviewed; sandbox escalations are routed to the automatic reviewer.

## Agents

- **Orchestrator** — default behavior from global `AGENTS.md`; principal engineer and delegation owner.
- **Junior** — focused executor and shell-assisted explorer.
- **Explorer** — read-only codebase evidence specialist.
- **Librarian** — read-only external research specialist.

Codex custom-agent roles are spawned subagents. Global `AGENTS.md` supplies default Orchestrator behavior.

## Skills

`caveman`, `cellar`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grilling`, `handoff`, `resolving-merge-conflicts`, `simplify`, `tdd`.

Update skills manually, then review every change:

```bash
make update-skills
```
