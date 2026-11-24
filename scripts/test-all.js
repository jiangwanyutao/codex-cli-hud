"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true, shell: false });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const check = process.argv.includes("--check");
for (const name of fs.readdirSync(__dirname).sort()) {
  if (check && /^(quota-.*|build-quota-plugin|configure-quota-hud|test-all)\.js$/.test(name)) run(process.execPath, ["--check", path.join(__dirname, name)]);
  if (!check && /^test-quota-.*\.js$/.test(name)) run(process.execPath, [path.join(__dirname, name)]);
}
const python = process.env.CODEX_QUOTA_PYTHON || "python";
if (check) run(python, ["-c", "import ast,pathlib; [ast.parse(p.read_text(encoding='utf-8')) for p in pathlib.Path('scripts').glob('*.py')]; print('Python syntax passed')"]);
else run(python, [path.join(__dirname, "test-quota-settings.py")]);
