"""Credential discovery tests use temporary fake files only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("quota_settings", Path(__file__).with_name("quota-settings.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.codex = self.root / "codex"
        self.cc = self.root / "cc"
        self.codex.mkdir()
        self.cc.mkdir()
        self.env = {"CODEX_HOME": str(self.codex), "CC_SWITCH_HOME": str(self.cc)}
        self.live()

    def tearDown(self):
        self.temporary.cleanup()

    def config(self, base, extra=""):
        return f'model_provider="custom"\n[model_providers.custom]\nbase_url={json.dumps(base)}\n{extra}\n'

    def live(self, base="https://example.test/v1", key="fixture-live", extra=""):
        (self.codex / "config.toml").write_text(self.config(base, extra), encoding="utf-8")
        (self.codex / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": key}), encoding="utf-8")

    def override(self, values):
        folder = self.codex / "quota-hud"
        folder.mkdir(exist_ok=True)
        (folder / "providers.json").write_text(json.dumps({"providers": values}), encoding="utf-8")

    def read(self):
        return module.settings(self.env)

    def test_standalone_codex_without_cc_database(self):
        self.assertFalse((self.cc / "cc-switch.db").exists())
        result = self.read()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["templateType"], "auto")
        self.assertEqual(result["apiKey"], "fixture-live")
        self.assertEqual(result["configSource"], "codex")

    def test_poisoned_cc_directory_is_never_read(self):
        (self.cc / "cc-switch.db").write_bytes(b"poisoned database")
        (self.cc / "settings.json").write_text('{"currentProviderCodex":"wrong"}')
        actual_read = Path.read_text
        def guarded_read(path, *args, **kwargs):
            self.assertNotIn(self.cc, path.parents, "CC Switch must never be consulted")
            return actual_read(path, *args, **kwargs)
        with patch.object(Path, "read_text", guarded_read):
            result = self.read()
        self.assertEqual(result["apiKey"], "fixture-live")
        self.assertEqual(result["baseUrl"], "https://example.test/v1")
        source = Path(module.__file__).read_text()
        self.assertNotIn("sqlite3", source)
        self.assertNotIn("CC_SWITCH_HOME", source)
        self.assertNotIn(".cc-switch", source)

    def test_builtin_official_has_no_custom_endpoint_or_api_key_requirement(self):
        for config in ('model="gpt-test"\n', 'model_provider="openai"\n'):
            (self.codex / "config.toml").write_text(config)
            (self.codex / "auth.json").write_text("{}")
            result = self.read()
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["templateType"], "official_subscription")
            self.assertEqual(result["configSource"], "codex")
            self.assertIsNone(result["key"])

    def test_openai_custom_endpoint_still_uses_provider_adapter(self):
        (self.codex / "config.toml").write_text('[model_providers.openai]\nbase_url="https://example.test/v1"\n')
        self.assertEqual(self.read()["templateType"], "auto")

    def test_copilot_credentials_only_from_plugin_override(self):
        self.override([{"baseUrl": "https://example.test/v1", "templateType": "github_copilot"}])
        self.assertEqual(self.read()["status"], "credentials-required")
        self.override([{"baseUrl": "https://example.test/v1", "templateType": "github_copilot", "githubToken": "fixture-github", "githubDomain": "github.com"}])
        result = self.read()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["githubToken"], "fixture-github")
        self.assertEqual(result["configSource"], "plugin-override")

    def test_declared_missing_env_never_falls_back(self):
        self.live(extra='env_key="FIXTURE_REQUIRED"')
        result = self.read()
        self.assertEqual(result["status"], "login-required")
        self.assertIsNone(result["key"])
        self.env["FIXTURE_REQUIRED"] = "fixture-env"
        self.assertEqual(self.read()["apiKey"], "fixture-env")

    def test_explicit_bearer_precedes_env_and_auth(self):
        self.live(extra='experimental_bearer_token="fixture-bearer"\nenv_key="FIXTURE_ABSENT"')
        self.assertEqual(self.read()["apiKey"], "fixture-bearer")



    def test_local_allowed_origins_are_exact_and_normalized(self):
        self.override([{"baseUrl": "https://example.test/v1", "allowedOrigins": [
            "https://USAGE.test:443/", "http://localhost:7890", "http://[::1]:8080/",
        ]}])
        result = self.read()
        self.assertEqual(result["allowedOrigins"], ["https://usage.test", "http://localhost:7890", "http://[::1]:8080"])
        original = result["fingerprint"]
        self.override([{"baseUrl": "https://example.test/v1", "allowedOrigins": []}])
        self.assertNotEqual(self.read()["fingerprint"], original)

    def test_local_allowed_origins_reject_ambiguous_values(self):
        for invalid in (None, "https://usage.test", [1], ["https://usage.test/path"],
                        ["https://user:pass@usage.test"], ["https://usage.test?secret=1"],
                        ["https://usage.test#fragment"], [" https://usage.test"], ["*.usage.test"]):
            with self.subTest(invalid=invalid):
                self.override([{"baseUrl": "https://example.test/v1", "allowedOrigins": invalid}])
                self.assertEqual(self.read()["status"], "config-error")



    def test_overrides_exact_endpoint_and_safe_argv(self):
        self.override([
            {"baseUrl": "https://example.test/wrong", "apiKey": "fixture-wrong"},
            {"baseUrl": "https://example.test.evil/v1", "apiKey": "fixture-wrong"},
            {"baseUrl": "https://EXAMPLE.test:443/v1/", "command": "node", "args": ["local.js", "literal;not-shell"], "usageBaseUrl": "https://query.test/usage", "templateType": "command"},
        ])
        result = self.read()
        self.assertEqual(result["command"], "node")
        self.assertEqual(result["args"], ["local.js", "literal;not-shell"])
        self.assertEqual(result["baseUrl"], "https://query.test/usage")
        self.assertEqual(result["apiKey"], "fixture-live")

    def test_invalid_argv_rejected(self):
        self.override([{"baseUrl": "https://example.test/v1", "command": "node", "args": "script.js"}])
        self.assertEqual(self.read()["status"], "config-error")

    def test_fingerprint_changes_with_key_and_query(self):
        initial = self.read()["fingerprint"]
        self.assertEqual(initial, self.read()["fingerprint"])
        self.live(key="fixture-new")
        changed_key = self.read()["fingerprint"]
        self.assertNotEqual(initial, changed_key)
        self.override([{"baseUrl": "https://example.test/v1", "templateType": "new-api"}])
        self.assertNotEqual(changed_key, self.read()["fingerprint"])

    def test_unknown_endpoint_is_auto_and_missing_config_safe(self):
        self.live("https://unknown.test/custom/path")
        self.assertEqual(self.read()["templateType"], "auto")
        self.assertEqual(self.read()["status"], "ok")
        (self.codex / "config.toml").unlink()
        self.assertEqual(self.read()["status"], "not-configured")





    def test_http_usage_origin_override(self):
        self.override([{"baseUrl": "https://example.test/v1", "usageBaseUrl": "http://127.0.0.1:8765"}])
        self.assertEqual(self.read()["baseUrl"], "http://127.0.0.1:8765")

if __name__ == "__main__":
    unittest.main()
