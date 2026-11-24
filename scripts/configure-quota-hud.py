"""Enable the native statusline; preserve unrelated TOML and back it up first."""
import os
from pathlib import Path
import re
import sys
import time
import tomllib


def set_key(text, section, key, value):
    header = re.search(r"(?m)^\[" + re.escape(section) + r"\][ \t]*(?:#.*)?$", text)
    if not header:
        return text.rstrip() + f"\n\n[{section}]\n{key} = {value}\n"
    next_header = re.search(r"(?m)^\[", text[header.end():])
    end = header.end() + next_header.start() if next_header else len(text)
    body = text[header.end():end]
    expression = r"(?m)^" + re.escape(key) + r"\s*=.*$"
    if re.search(expression, body):
        body = re.sub(expression, f"{key} = {value}", body)
    else:
        body = "\n" + f"{key} = {value}" + body
    return text[:header.end()] + body + text[end:]


def main():
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    target = home / "config.toml"
    original = target.read_text(encoding="utf-8-sig")
    tomllib.loads(original)
    modified = set_key(original, "features", "tui_extensions_statusline", "true")
    modified = set_key(modified, "tui", "status_line_provider", '{ server = "codex-quota-hud", tool = "quota_statusline" }')
    parsed = tomllib.loads(modified)
    assert parsed["features"]["tui_extensions_statusline"] is True
    if original == modified:
        print("Native quota HUD already selected")
        return
    backup = home / "quota-hud" / f"config-before-hud-{time.time_ns()}.toml"
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.write_bytes(target.read_bytes())
    staged = target.with_name(f"config.hud-{os.getpid()}.tmp")
    staged.write_text(modified, encoding="utf-8", newline="\n")
    os.replace(staged, target)
    print(f"Native quota HUD enabled. Config backup: {backup}")


if __name__ == "__main__":
    main()
