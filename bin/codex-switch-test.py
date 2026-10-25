#!/usr/bin/env -S pipx run

# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "tomli-w==1.2.0",
# ]
# ///

"""Unit tests for codex-switch. Run: make test-codex-switch

The pins mirror codex-switch.py's PEP 723 metadata, because importing the tool
module imports those packages.
"""

import importlib.util
import tomllib
import unittest
from pathlib import Path
from types import ModuleType

TOOL_PATH = Path(__file__).resolve().parent / "codex-switch.py"


def load_tool() -> ModuleType:
    """Imports codex-switch.py; its dashed file name needs an explicit file load."""
    spec = importlib.util.spec_from_file_location("codex_switch", TOOL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = load_tool()


def valid_agents() -> dict[str, dict[str, str]]:
    return {
        "Solo": {"model": "gpt-5.6-sol", "model_reasoning_effort": "medium"},
        "Junior": {"model": "gpt-5.6-luna", "model_reasoning_effort": "xhigh"},
    }


def valid_preset() -> dict[str, object]:
    return {
        "model": "gpt-5.6-sol",
        "model_reasoning_effort": "medium",
        "agents": valid_agents(),
    }


class MergeTest(unittest.TestCase):
    def test_merges_objects_and_replaces_other_values(self) -> None:
        base = {
            "scalar": 1,
            "nested": {"kept": True, "replaced": "old"},
            "items": [1, 2],
        }
        overlay = {
            "scalar": 2,
            "nested": {"replaced": "new", "added": True},
            "items": [3],
            "added": "value",
        }

        merged = tool.merge_objects(base, overlay)

        self.assertEqual(
            merged,
            {
                "scalar": 2,
                "nested": {"kept": True, "replaced": "new", "added": True},
                "items": [3],
                "added": "value",
            },
        )
        self.assertEqual(tool.merge_values(1, {"a": 1}), {"a": 1})
        self.assertEqual(tool.merge_values({"a": 1}, 2), 2)

    def test_keeps_base_order_and_appends_overlay_keys(self) -> None:
        merged = tool.merge_objects({"b": 1, "a": 2}, {"a": 3, "c": 4})

        self.assertEqual(list(merged), ["b", "a", "c"])


class ValidatedSettingsTest(unittest.TestCase):
    def test_accepts_valid_models(self) -> None:
        settings = {"model": "gpt-5.6-sol", "model_reasoning_effort": "xhigh"}

        validated = tool.validated_settings(settings, "preset")

        self.assertEqual(validated[tool.MODEL_KEY], "gpt-5.6-sol")
        self.assertEqual(validated[tool.EFFORT_KEY], "xhigh")

    def test_rejects_invalid_models(self) -> None:
        blank = {"model": "  ", "model_reasoning_effort": "low"}
        with self.assertRaises(tool.ConfigError) as raised:
            tool.validated_settings(blank, "preset")
        self.assertEqual(
            str(raised.exception),
            "preset must define a model and valid model_reasoning_effort",
        )

        bad_effort = {"model": "gpt-5.6-sol", "model_reasoning_effort": "turbo"}
        with self.assertRaises(tool.ConfigError):
            tool.validated_settings(bad_effort, "preset")
        with self.assertRaises(tool.ConfigError):
            tool.validated_settings(None, "Junior")
        with self.assertRaises(tool.ConfigError):
            tool.validated_settings([1], "Junior")


class ValidatePresetTest(unittest.TestCase):
    def test_extracts_root_and_agent_settings(self) -> None:
        validated = tool.validate_preset("p-openai", valid_preset())

        self.assertEqual(validated.root_models[tool.MODEL_KEY], "gpt-5.6-sol")
        self.assertEqual([agent for agent, _ in validated.agents], list(tool.AGENTS))
        junior = dict(validated.agents)["Junior"]
        self.assertEqual(junior[tool.EFFORT_KEY], "xhigh")
        solo = dict(validated.agents)["Solo"]
        self.assertEqual(solo[tool.EFFORT_KEY], "medium")

    def test_rejects_unknown_preset_settings_and_agents(self) -> None:
        preset = {**valid_preset(), "model_provider": "openai"}
        with self.assertRaises(tool.ConfigError) as raised:
            tool.validate_preset("p-openai", preset)
        self.assertEqual(
            str(raised.exception), "Unknown preset setting: model_provider"
        )

        preset = {
            **valid_preset(),
            "agents": {**valid_agents(), "Architect": valid_agents()["Solo"]},
        }
        with self.assertRaises(tool.ConfigError) as raised:
            tool.validate_preset("p-openai", preset)
        self.assertEqual(str(raised.exception), "Unknown agent: Architect")

        agents = valid_agents()
        agents["Junior"] = {**agents["Junior"], "sandbox_mode": "workspace-write"}
        preset = {**valid_preset(), "agents": agents}
        with self.assertRaises(tool.ConfigError) as raised:
            tool.validate_preset("p-openai", preset)
        self.assertEqual(
            str(raised.exception), "Unknown setting for Junior: sandbox_mode"
        )

    def test_rejects_orchestrator_as_a_subagent(self) -> None:
        preset = {
            **valid_preset(),
            "agents": {**valid_agents(), "Orchestrator": valid_agents()["Solo"]},
        }
        with self.assertRaises(tool.ConfigError) as raised:
            tool.validate_preset("p-openai", preset)
        self.assertEqual(str(raised.exception), "Unknown agent: Orchestrator")

    def test_requires_every_agent(self) -> None:
        preset = valid_preset()
        agents = valid_agents()
        del agents["Junior"]
        preset["agents"] = agents
        with self.assertRaises(tool.ConfigError) as raised:
            tool.validate_preset("p-openai", preset)
        self.assertEqual(
            str(raised.exception),
            "Junior must define a model and valid model_reasoning_effort",
        )

        preset = {"model": "gpt-5.6-sol", "model_reasoning_effort": "low"}
        with self.assertRaises(tool.ConfigError) as raised:
            tool.validate_preset("p-openai", preset)
        self.assertEqual(str(raised.exception), "p-openai must define agents")


class RejectNullsTest(unittest.TestCase):
    def test_reports_the_offending_path(self) -> None:
        value = {"a": [1, {"b": None}]}

        with self.assertRaises(tool.ConfigError) as raised:
            tool.reject_nulls(value, tool.COMMON_FILE)

        self.assertEqual(
            str(raised.exception), "config.common.json.a[1].b must not contain null"
        )
        tool.reject_nulls({"a": [1, 2]}, tool.COMMON_FILE)


class IsModelAssignmentTest(unittest.TestCase):
    def test_matches_only_root_model_lines(self) -> None:
        self.assertTrue(tool.is_model_assignment('model = "x"\n'))
        self.assertTrue(tool.is_model_assignment('model_reasoning_effort = "x"\n'))
        self.assertTrue(tool.is_model_assignment("model_reasoning_effort\t= 1"))
        self.assertFalse(tool.is_model_assignment("model\n"))
        self.assertFalse(tool.is_model_assignment('  model = "x"\n'))
        self.assertFalse(tool.is_model_assignment('model_provider = "x"\n'))
        self.assertFalse(tool.is_model_assignment("[model]\n"))


class UpdateModelsTest(unittest.TestCase):
    def test_keeps_comments_and_prompts(self) -> None:
        source = (
            '# keep\nmodel = "old"\nmodel_reasoning_effort = "low"\n'
            'sandbox_mode = "workspace-write"\n\n[features]\nmulti_agent = true\n'
        )
        settings = {"model": "new", "model_reasoning_effort": "high"}

        updated = tool.update_models(source, settings)

        self.assertEqual(
            updated,
            'model = "new"\nmodel_reasoning_effort = "high"\n# keep\n'
            'sandbox_mode = "workspace-write"\n\n[features]\nmulti_agent = true\n',
        )

    def test_falls_back_to_serialization_for_unusual_layouts(self) -> None:
        source = (
            'model = "old"\nmodel_reasoning_effort = "low"\n'
            "prompt = '''\nmodel = keep me\n'''\n"
        )
        settings = {"model": "new", "model_reasoning_effort": "high"}

        updated = tool.update_models(source, settings)

        self.assertEqual(
            tomllib.loads(updated),
            {
                "model": "new",
                "model_reasoning_effort": "high",
                "prompt": "model = keep me\n",
            },
        )


class SerializeRootTest(unittest.TestCase):
    def test_round_trips_nested_tables(self) -> None:
        config = {
            "approval_policy": "on-request",
            "model": "gpt-5.6-sol",
            "model_reasoning_effort": "medium",
            "sandbox_workspace_write": {"network_access": False},
            "agents": {"max_depth": 2},
        }

        contents = tool.serialize_root(config)

        self.assertEqual(tomllib.loads(contents), config)


class ParseArgsTest(unittest.TestCase):
    def test_no_arguments_or_a_help_flag_print_help(self) -> None:
        self.assertIsNone(tool.parse_args([]))
        self.assertIsNone(tool.parse_args(["-h"]))
        self.assertIsNone(tool.parse_args(["--help"]))

    def test_one_name_selects_the_preset(self) -> None:
        self.assertEqual(tool.parse_args(["gpt-6"]), "gpt-6")
        self.assertEqual(tool.parse_args(["-weird-name"]), "-weird-name")

    def test_every_other_combination_is_a_usage_error(self) -> None:
        for argv in (["a", "b"], ["a", "-h"], ["-h", "-h"], ["-h", "a"]):
            with self.subTest(argv=argv):
                with self.assertRaises(tool.ConfigError) as raised:
                    tool.parse_args(argv)
                self.assertEqual(str(raised.exception), "Usage: codex-switch <preset>")


if __name__ == "__main__":
    unittest.main(verbosity=2)
