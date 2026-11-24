# Codex CLI HUD 1.2

Claude HUD 风格的原生终端状态栏。优先显示当前 Codex 启用的订阅或 API，平台查询协议内置于插件。不读取 CC Switch 数据库、配置或查询脚本，不需要安装或运行 CC Switch。

```text
[gpt-6-astra] │ project
当前服务商 · 已用 ████░ 80% · 剩余 $360.00 / $1,800.00
上下文 ██░░░ 40%
```

不展示 newapi/sub2api 等实现名称。自定义 API 模式不再查询或显示另外登录的官方账号。官方模式直接使用当前 Codex 状态栏快照里的官方额度，不再额外启动 app-server；新会话未提供额度/上下文时显示暂无数据。

## 内置查询

- Sub2API：额度、订阅、速率窗口。
- NewAPI：API key 用量；有管理凭据时支持用户额度。
- 通用余额；DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita。
- Coding Plan：Kimi、智谱个人/团队、MiniMax、ZenMux、火山引擎、OpenCode Go、Command Code、Ollama Cloud。
- Copilot：显式配置 GitHub OAuth 凭据，不读取 CC Switch 托管账号。

读取 Codex 当前 config.toml/auth.json 或声明的环境变量，按端点及响应结构自动识别，同源查询并拒绝重定向。额外管理 token、userId、AK/SK、团队 ID 无法从 URL 推断，缺失时明确提示。未知平台允许显式配置查询方式。

默认网络刷新 30 秒，配置轮询 5 秒；刷新期间使用缓存，查询失败标记旧数据。切换服务商或凭据后清除旧额度。只读余额接口不发送推理请求。

## 安装

需要 Node 22+、Python 3.11+，当前在 Windows Codex CLI 0.171.0 验证。常规内置查询不启动浏览器，不依赖 Playwright。

```powershell
node scripts/build-quota-plugin.js
codex plugin marketplace add ./dist/quota-marketplace
codex plugin add quota-hud@codex-quota-local
python scripts/configure-quota-hud.py
```

重启 Codex CLI 使用新版。建议默认全屏终端且宽度至少 80 列；--no-alt-screen 的宿主高度不足。桌面 App 不使用 CLI 状态栏。安装工具先备份配置再启用状态栏，其他项保留。

## 可选覆盖

插件自己的 ~/.codex/quota-hud/providers.json 可按实际 baseUrl 精确匹配配置，完全独立于 CC Switch：

```json
{"providers":[{"baseUrl":"https://your-api.example/v1","templateType":"newapi","accessToken":"YOUR_MANAGEMENT_TOKEN","userId":"YOUR_USER_ID"}]}
```

特殊脚本仍可显式设置 command 和 args，stdin 接收 JSON 凭据，stdout 输出 total/used/remaining/unit JSON。只有用户显式配置 scriptCode 才会执行 JS 沙箱，这需要本机 Python Playwright 和 Edge/Chrome；普通内置查询不使用它。HTTP helper 可用 usageBaseUrl，跨源须显式 allowedOrigins。

## 检查

```powershell
node scripts/quota-hud.js --check
node scripts/quota-hud.js --preview
Get-ChildItem scripts/test-quota-*.js | ForEach-Object { node $_.FullName }
python scripts/test-quota-settings.py
codex mcp get codex-quota-hud --json
```

--check 输出脱敏额度与状态；官方额度需真实宿主的 account.rate_limits 快照，单独命令不包含该快照。不要运行私有 quota-settings.py 或保存它的凭据输出。

恢复：/statusline 选择默认。卸载：codex plugin remove quota-hud@codex-quota-local。

## 实现与验证边界

quota-settings.py 只发现 Codex 与插件自身配置，quota-provider.js 调度内置平台采集，quota-platforms.js 包含移植的协议，quota-hud.js 使用当前宿主官方额度，quota-hud-render.js 提供中文紧凑渲染。平台移植保留 CC Switch MIT 许可声明。

已实际查询当前自定义 API，其他平台使用模拟响应、身份切换、凭据缺失及签名测试。没有逐个平台真实账号验收。终端最终字体、背景与高度由宿主控制。

## 会话活动

完整工作目录来自当前线程。按线程 ID 校验并增量读取 Codex 会话 JSONL，只展示工具名称/次数、活动调用、已确认的子代理和计划完成数，不展示参数、提示词或输出正文。数据不足时省略；调用返回不等于执行成功。支持新旧日志格式，长会话分块读取不阻塞状态栏；过长日志行可能跳过，统计以可解析记录为准。上下文始终可见，更多活动每五秒分页。
