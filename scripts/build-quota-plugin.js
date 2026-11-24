"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const market = path.join(root, "dist", "quota-marketplace");
const plugin = path.join(market, "plugins", "quota-hud");
function json(relative, value) {
  const file = path.join(market, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
json(".agents/plugins/marketplace.json", {
  name: "codex-quota-local", interface: { displayName: "Codex CLI HUD" },
  plugins: [{ name: "quota-hud", source: { source: "local", path: "./plugins/quota-hud" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
});
json("plugins/quota-hud/.codex-plugin/plugin.json", {
  name: "quota-hud", version: "1.2.1", description: "Codex CLI HUD: subscription quotas, workspace, context and live session activity.",
  license: "MIT", mcpServers: "./.mcp.json",
  interface: { displayName: "Codex CLI HUD", shortDescription: "Quotas, context, workspace and tools in a native footer.", category: "Productivity" },
});
json("plugins/quota-hud/.mcp.json", { mcpServers: { "codex-quota-hud": {
  command: "node", args: ["scripts/quota-hud.js"], cwd: ".", startup_timeout_sec: 15,
} } });
fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
for (const file of ["quota-hud.js", "quota-hud-render.js", "quota-activity.js", "quota-provider.js", "quota-platforms.js", "quota-custom.js", "quota-copilot.js", "quota-script-sandbox.py", "quota-official.js", "quota-settings.py"]) {
  fs.copyFileSync(path.join(__dirname, file), path.join(plugin, "scripts", file));
}
fs.copyFileSync(path.join(root, "LICENSE"), path.join(plugin, "LICENSE"));
for (const file of ["QUOTA-HUD.md", "THIRD_PARTY_NOTICES.md"]) fs.copyFileSync(path.join(root, file), path.join(plugin, file));
// The repository itself is also an installable remote marketplace.
for (const relative of [".agents/plugins/marketplace.json", "plugins/quota-hud/.codex-plugin/plugin.json", "plugins/quota-hud/.mcp.json"]) {
  const destination = relative.replace("plugins/quota-hud/", "");
  const target = path.join(root, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (relative.includes("marketplace.json")) {
    const data = JSON.parse(fs.readFileSync(path.join(market, relative), "utf8"));
    data.plugins[0].source.path = "./";
    fs.writeFileSync(target, JSON.stringify(data, null, 2) + "\n");
  } else fs.copyFileSync(path.join(market, relative), target);
}
console.log(market);
