#!/usr/bin/env python3

"""Unit tests for the deployment helper."""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from types import ModuleType
from unittest import mock

TOOL_PATH = Path(__file__).resolve().parent.parent / "bin" / "utils" / "deploy.py"


def load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("deploy", TOOL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()


class RepositoryIdentityTest(unittest.TestCase):
    def test_windows_drive_paths_are_paths_on_every_host(self) -> None:
        self.assertEqual(
            tool.repository_identity(r"C:\Codex\Config.git"),
            tool.repository_identity("c:/codex/config"),
        )


class DeployablesTest(unittest.TestCase):
    def test_windows_materializes_indexed_links_as_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "launcher").write_bytes(b"../launcher.py")

            with mock.patch.object(
                tool, "eligible_paths", return_value=[PurePosixPath("launcher")]
            ):
                items = tool.deployables(source, windows=True)

            self.assertEqual(
                items[0].entry,
                tool.RegularFile(b"../launcher.py", False),
            )

    def test_windows_materializes_checkout_symlinks_without_privilege(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()

            with (
                mock.patch.object(
                    tool,
                    "eligible_paths",
                    return_value=[PurePosixPath("launcher")],
                ),
                mock.patch.object(
                    tool, "read_entry", return_value=tool.Symlink("../launcher.py")
                ),
            ):
                items = tool.deployables(source, windows=True)

            self.assertEqual(
                items[0].entry,
                tool.RegularFile(b"../launcher.py", False),
            )

    @unittest.skipIf(os.name == "nt", "POSIX file modes and symlinks are unavailable")
    def test_posix_preserves_symlinks_and_executable_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "launcher").symlink_to("../launcher.py")
            executable = source / "deploy"
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
            indexed = [
                PurePosixPath("launcher"),
                PurePosixPath("deploy"),
            ]

            with mock.patch.object(tool, "eligible_paths", return_value=indexed):
                tool.copy_files(source, destination, windows=False)

            self.assertTrue((destination / "launcher").is_symlink())
            self.assertEqual(os_readlink(destination / "launcher"), "../launcher.py")
            self.assertTrue((destination / "deploy").stat().st_mode & 0o111)

    def test_windows_symlink_conflicts_are_found_before_any_files_are_written(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "launcher").write_bytes(b"../launcher.py")
            (source / "new-file").write_text("source", encoding="utf-8")
            (destination / "launcher").write_text("local", encoding="utf-8")
            indexed = [
                PurePosixPath("launcher"),
                PurePosixPath("new-file"),
            ]

            with mock.patch.object(tool, "eligible_paths", return_value=indexed):
                with self.assertRaises(tool.DeployError):
                    tool.copy_files(source, destination, windows=True)

            self.assertFalse((destination / "new-file").exists())
            self.assertEqual(
                (destination / "launcher").read_text(encoding="utf-8"), "local"
            )

    def test_working_tree_regular_file_stays_regular_on_posix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "launcher").write_bytes(b"local replacement")

            with mock.patch.object(
                tool, "eligible_paths", return_value=[PurePosixPath("launcher")]
            ):
                items = tool.deployables(source, windows=False)

            self.assertEqual(items[0].entry, tool.RegularFile(b"local replacement", False))


class InstallMetadataTest(unittest.TestCase):
    def test_only_windows_clone_disables_symlinks(self) -> None:
        for windows in (False, True):
            with self.subTest(windows=windows), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "source"
                destination = root / "destination"
                source.mkdir()
                destination.mkdir()
                calls: list[tuple[Path, tuple[str, ...]]] = []

                def fake_git(directory: Path, *arguments: str) -> str:
                    calls.append((directory, arguments))
                    if arguments[0] == "clone":
                        (Path(arguments[-1]) / ".git").mkdir(parents=True)
                    return ""

                with mock.patch.object(tool, "run_git", side_effect=fake_git):
                    tool.install_metadata(
                        source,
                        "https://example.com/config.git",
                        destination,
                        windows=windows,
                    )

                symlink_commands = [
                    arguments
                    for _, arguments in calls
                    if arguments[:3] == ("config", "--local", "core.symlinks")
                ]
                self.assertEqual(
                    symlink_commands,
                    [("config", "--local", "core.symlinks", "false")]
                    if windows
                    else [],
                )


class SkipSetupTest(unittest.TestCase):
    def test_skip_setup_omits_make_and_default_runs_it(self) -> None:
        for skip_setup in (False, True):
            with self.subTest(skip_setup=skip_setup):
                stdout = mock.Mock()
                with (
                    tempfile.TemporaryDirectory() as temporary,
                    mock.patch.object(tool, "deploy"),
                    mock.patch.object(tool, "run_make") as run_make,
                    mock.patch.object(tool.sys, "stdout", stdout),
                ):
                    arguments = [
                        "--source",
                        temporary,
                        "--source-kind",
                        "checkout",
                        "--repository",
                        "https://example.com/config.git",
                        "--destination",
                        temporary,
                        "--directory-variable",
                        "CODEX_HOME",
                    ]
                    if skip_setup:
                        arguments.append("--skip-setup")

                    status = tool.main(arguments)

                self.assertEqual(status, 0)
                if skip_setup:
                    run_make.assert_not_called()
                else:
                    run_make.assert_called_once()


def os_readlink(path: Path) -> str:
    return path.readlink().as_posix()


if __name__ == "__main__":
    unittest.main(verbosity=2)
