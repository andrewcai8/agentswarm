import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import main


class MainModuleTests(unittest.TestCase):
    def test_runtime_release_url_uses_default_repo(self):
        with patch.dict(os.environ, {}, clear=True):
            url = main._runtime_release_url("1.2.3")

        self.assertEqual(
            url,
            "https://github.com/andrewcai8/longshot/releases/download/v1.2.3/"
            "longshot-runtime-v1.2.3.tar.gz",
        )

    def test_runtime_release_url_respects_repo_override(self):
        with patch.dict(os.environ, {"LONGSHOT_RELEASE_REPO": "acme/longshot"}, clear=True):
            url = main._runtime_release_url("9.9.9")

        self.assertEqual(
            url,
            "https://github.com/acme/longshot/releases/download/v9.9.9/"
            "longshot-runtime-v9.9.9.tar.gz",
        )

    def test_write_runtime_package_json_pins_pi_agent_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            main._write_runtime_package_json(runtime_root)
            package_json = json.loads((runtime_root / "package.json").read_text(encoding="utf-8"))

        self.assertEqual(
            package_json["dependencies"]["@mariozechner/pi-coding-agent"],
            main.PI_CODING_AGENT_VERSION,
        )

    def test_build_parser_parses_core_flags(self):
        parser = main.build_parser()
        args = parser.parse_args(["Ship feature X", "--dashboard", "--reset", "--debug"])

        self.assertEqual(args.request, "Ship feature X")
        self.assertTrue(args.dashboard)
        self.assertTrue(args.reset)
        self.assertTrue(args.debug)


if __name__ == "__main__":
    unittest.main()
