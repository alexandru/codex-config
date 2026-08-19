# Manual, reviewable skill updates. Never run automatically (no CI, no hooks).

# Uses same upstream sources as source repository; review skills-lock.json and vendored files after install.

.PHONY: update-skills

update-skills:
	npx skills add https://github.com/alexandru/skills/ -y --skill \
		simplify
	npx skills add https://github.com/mattpocock/skills -y --skill \
		codebase-design \
		diagnosing-bugs \
		domain-modeling \
		grilling \
		handoff \
		resolving-merge-conflicts \
		tdd
	npx skills add https://github.com/VirtusLab/cellar/ -y
	npx skills add https://github.com/JuliusBrussee/caveman -y --skill caveman
	@echo "---"
	@echo "Manual review required: inspect git diff, skills-lock.json, and vendored skills before commit."
