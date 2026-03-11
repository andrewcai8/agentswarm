import base64
import importlib
import sys
import types
import unittest
from unittest.mock import patch


def _load_spawn_sandbox_module():
    if "infra.spawn_sandbox" in sys.modules:
        del sys.modules["infra.spawn_sandbox"]

    fake_modal = types.ModuleType("modal")

    class FakeApp:
        @staticmethod
        def lookup(*_args, **_kwargs):
            return object()

    setattr(fake_modal, "App", FakeApp)

    fake_sandbox_image = types.ModuleType("infra.sandbox_image")
    setattr(fake_sandbox_image, "create_worker_image", lambda: object())

    with patch.dict(
        sys.modules,
        {
            "modal": fake_modal,
            "infra.sandbox_image": fake_sandbox_image,
        },
        clear=False,
    ):
        return importlib.import_module("infra.spawn_sandbox")


class SpawnSandboxRedactionTests(unittest.TestCase):
    def test_redaction_masks_token_and_basic_auth_forms(self):
        module = _load_spawn_sandbox_module()
        token = "ghp_test_token"
        basic_auth = base64.b64encode(f"x-access-token:{token}".encode()).decode("ascii")
        header = f"AUTHORIZATION: basic {basic_auth}"

        secrets = module._build_redaction_secrets(token)
        text = f"clone failed with {header} and raw {token}"
        redacted = module._redact_secrets(text, secrets)

        self.assertNotIn(token, redacted)
        self.assertNotIn(basic_auth, redacted)
        self.assertNotIn(header, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_redaction_is_noop_without_secrets(self):
        module = _load_spawn_sandbox_module()
        text = "plain error text"
        redacted = module._redact_secrets(text, [])
        self.assertEqual(redacted, text)


if __name__ == "__main__":
    unittest.main()
