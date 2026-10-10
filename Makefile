# Bootstrap and manage the local Codex configuration.
# The default target installs every missing prerequisite, applies the default
# preset, and installs the shared skills globally. Never run automatically
# (no CI, no hooks); review upstream skill content before installation.

.NOTPARALLEL:

PRESET ?= p-openai
ALEXANDRU_SKILLS_TAG := v10.2.0
MATTPOCOCK_SKILLS_TAG := v1.3.1
NVM_TAG := v0.40.8
SKILLS_AGENT := codex
SKILLS_INSTALL_FLAGS := -g -a $(SKILLS_AGENT) -y

.PHONY: all install-scala apply-preset install-node install-skills update-skills check-mattpocock-skills-tag

all: install-scala apply-preset install-node install-skills

install-scala:
	@if command -v scala >/dev/null 2>&1; then \
		echo "Scala already installed: $$(scala -version 2>&1)"; exit 0; \
	fi; \
	case "$$(uname -s):$$(uname -m)" in \
		Darwin:arm64) launcher=cs-aarch64-apple-darwin.gz ;; \
		Darwin:*) launcher=cs-x86_64-apple-darwin.gz ;; \
		Linux:aarch64) launcher=cs-aarch64-pc-linux.gz ;; \
		Linux:*) launcher=cs-x86_64-pc-linux.gz ;; \
		*) echo "Unsupported platform: $$(uname -s) $$(uname -m)" >&2; exit 1 ;; \
	esac; \
	if [ "$$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then \
		brew install coursier/formulas/coursier; \
		cs setup --yes; \
	else \
		csbin="$$(mktemp)"; \
		trap 'rm -f "$$csbin"' EXIT; \
		curl -fL "https://github.com/coursier/launchers/raw/master/$$launcher" | gzip -d > "$$csbin" && \
		chmod +x "$$csbin" && \
		"$$csbin" setup --yes; \
	fi

apply-preset:
	PATH="$$HOME/.local/share/coursier/bin:$$HOME/Library/Application Support/Coursier/bin:$$PATH" ./bin/codex-switch $(PRESET)

install-node:
	@if command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then \
		echo "Node already installed: $$(node --version)"; exit 0; \
	fi; \
	case "$$(uname -s)" in \
		Darwin) brew install node ;; \
		Linux) \
			if [ ! -s "$$HOME/.nvm/nvm.sh" ]; then \
				curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/$(NVM_TAG)/install.sh" | bash; \
			fi; \
			. "$$HOME/.nvm/nvm.sh" && nvm install --lts && nvm alias default 'lts/*' ;; \
		*) echo "Unsupported platform: $$(uname -s)" >&2; exit 1 ;; \
	esac

check-mattpocock-skills-tag:
	@latest=$$(git ls-remote --tags --refs --sort=-version:refname https://github.com/mattpocock/skills.git 'v*' 2>/dev/null | sed -n '1s#.*refs/tags/##p'); \
	if [ -z "$$latest" ]; then \
		echo "WARN: unable to check the latest mattpocock/skills tag"; \
	elif [ "$$latest" != "$(MATTPOCOCK_SKILLS_TAG)" ]; then \
		echo "WARN: mattpocock/skills is pinned to $(MATTPOCOCK_SKILLS_TAG); latest tag is $$latest"; \
	fi

install-skills:
	set -e; \
	if [ -s "$$HOME/.nvm/nvm.sh" ]; then . "$$HOME/.nvm/nvm.sh"; fi; \
	npx skills add https://github.com/alexandru/skills/tree/$(ALEXANDRU_SKILLS_TAG) $(SKILLS_INSTALL_FLAGS) --skill \
		code-review \
		code-reviewing \
		simplicity \
		simplify; \
	npx skills add https://github.com/mattpocock/skills/tree/$(MATTPOCOCK_SKILLS_TAG) $(SKILLS_INSTALL_FLAGS) --skill \
		codebase-design \
		diagnosing-bugs \
		domain-modeling \
		grill-me \
		grill-with-docs \
		grilling \
		handoff \
		implement \
		improve-codebase-architecture \
		setup-matt-pocock-skills \
		tdd \
		teach \
		to-spec \
		to-tickets; \
	npx skills add https://github.com/VirtusLab/cellar/ $(SKILLS_INSTALL_FLAGS); \
	npx skills add https://github.com/JuliusBrussee/caveman $(SKILLS_INSTALL_FLAGS) --skill caveman; \
	npx skills add https://github.com/cursor/plugins/tree/main/pstack/skills/unslop $(SKILLS_INSTALL_FLAGS) --skill unslop; \
	npx skills add https://github.com/brave/brave-search-skills $(SKILLS_INSTALL_FLAGS) --skill web-search
	@echo "Shared skills installed in ~/.agents/skills."

update-skills: check-mattpocock-skills-tag
	$(MAKE) install-skills
