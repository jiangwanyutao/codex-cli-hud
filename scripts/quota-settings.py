"""Private credential handoff to the HUD process. Never run as a diagnostic."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tomllib
from urllib.parse import urlsplit

FIELDS = ("apiKey", "accessToken", "userId", "accessKeyId", "secretAccessKey",
          "teamOrganizationId", "teamProjectId", "codingPlanProvider", "timeout",
          "autoQueryInterval", "unit")


def json_object(value):
    if isinstance(value, dict):
        return value
    try:
        result = json.loads(value or "{}")
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError):
        return {}


def read_json(path):
    try:
        return json_object(path.read_text(encoding="utf-8-sig"))
    except OSError:
        return {}


def endpoint(value):
    """Exact origin/path identity; never match a suffix or unrelated URL path."""
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value.strip())
        if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.query or url.fragment:
            return None
        return (url.scheme, url.hostname.lower(), url.port or (443 if url.scheme == "https" else 80), url.path.rstrip("/"))
    except ValueError:
        return None


def exact_origin(value):
    parsed = endpoint(value)
    if not parsed or value != value.strip() or urlsplit(value).path not in ("", "/"):
        return None
    scheme, host, port, _ = parsed
    if ":" in host:
        host = f"[{host}]"
    suffix = "" if port == (443 if scheme == "https" else 80) else f":{port}"
    return f"{scheme}://{host}{suffix}"


def resolve_config(config, auth, env):
    if isinstance(config, str):
        try:
            config = tomllib.loads(config)
        except ValueError:
            config = {}
    config = config if isinstance(config, dict) else {}
    active = config.get("model_provider", "openai")
    providers = config.get("model_providers", {})
    provider = providers.get(active, {}) if isinstance(providers, dict) else {}
    provider = provider if isinstance(provider, dict) else {}
    base = provider.get("base_url", config.get("base_url", ""))
    key = provider.get("experimental_bearer_token") or config.get("experimental_bearer_token")
    declared_env = provider.get("env_key", config.get("env_key"))
    missing_env = False
    if not key and isinstance(declared_env, str) and declared_env:
        key = env.get(declared_env)
        missing_env = not bool(key)
    if not key and not missing_env:
        key = json_object(auth).get("OPENAI_API_KEY")
    return {"baseUrl": base if isinstance(base, str) else "", "apiKey": key if isinstance(key, str) else None,
            "name": provider.get("name") or active or "Provider", "missingEnv": missing_env}


def finalize(result):
    if result.get("apiKey") == "PROXY_MANAGED":
        result.pop("apiKey", None)
        if result.get("status") == "ok":
            result["status"] = "login-required"
    result["key"] = result.get("apiKey")
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    result["fingerprint"] = hashlib.sha256(encoded).hexdigest()
    return result


def settings(env=None):
    env = os.environ if env is None else env
    home = Path(env.get("CODEX_HOME", str(Path.home() / ".codex")))
    try:
        config = tomllib.loads((home / "config.toml").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return finalize({"status": "not-configured"})
    live = resolve_config(config, read_json(home / "auth.json"), env)
    if live["missingEnv"]:
        return finalize({"status": "login-required", "name": live["name"], "baseUrl": live["baseUrl"]})
    if not live["baseUrl"] and config.get("model_provider", "openai") == "openai":
        return finalize({"status": "ok", "name": "OpenAI", "templateType": "official_subscription", "configSource": "codex"})
    if not endpoint(live["baseUrl"]):
        return finalize({"status": "not-configured", "name": live["name"]})
    result = {"status": "ok", "baseUrl": live["baseUrl"].rstrip("/"), "apiKey": live["apiKey"],
              "name": live["name"], "templateType": "auto", "configSource": "codex"}
    if str(result["name"]).lower() in ("custom", "openai", "provider"):
        result["name"] = urlsplit(live["baseUrl"]).hostname
    overrides = read_json(home / "quota-hud" / "providers.json").get("providers", [])
    if isinstance(overrides, list):
        for override in overrides:
            if not isinstance(override, dict) or endpoint(override.get("baseUrl")) != endpoint(live["baseUrl"]):
                continue
            result["configSource"] = "plugin-override"
            command = override.get("command")
            args = override.get("args", [])
            if command is not None and (not isinstance(command, str) or not command or "\x00" in command or
                    not isinstance(args, list) or any(not isinstance(arg, str) or "\x00" in arg for arg in args)):
                return finalize({"status": "config-error", "name": result["name"]})
            if command is not None:
                result.update({"command": command, "args": args})
            if "allowedOrigins" in override:
                origins = override["allowedOrigins"]
                if not isinstance(origins, list) or any(not exact_origin(origin) for origin in origins):
                    return finalize({"status": "config-error", "name": result["name"]})
                result["allowedOrigins"] = [exact_origin(origin) for origin in origins]
            for field in FIELDS + ("name", "templateType", "scriptCode", "githubToken", "githubDomain"):
                if override.get(field) is not None:
                    result[field] = override[field]
            if override.get("usageBaseUrl"):
                result["baseUrl"] = override["usageBaseUrl"].rstrip("/")
            if override.get("enabled") is False:
                result["status"] = "disabled"
            break
    if not endpoint(result["baseUrl"]):
        return finalize({"status": "config-error", "name": result["name"]})
    if result.get("templateType") == "github_copilot" and result["status"] == "ok" and not result.get("githubToken"):
        result["status"] = "credentials-required"
    if result["status"] == "ok" and result.get("templateType") != "official_subscription" and not (result.get("apiKey") or result.get("accessToken") or
            result.get("command") or result.get("githubToken") or (result.get("accessKeyId") and result.get("secretAccessKey"))):
        result["status"] = "login-required"
    return finalize(result)


if __name__ == "__main__":
    if sys.stdout.isatty():
        sys.exit("This helper is private; use quota-hud.js --check instead.")
    try:
        print(json.dumps(settings()))
    except (OSError, ValueError, TypeError, AttributeError):
        print(json.dumps({"status": "config-error"}))
