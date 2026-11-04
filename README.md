# TestMate MCP

[English](#english) · 中文

`testmate-mcp` 是 [TestMate](https://testmate.beansmile.ai) 的 MCP 服务器（stdio），让 Claude Code、Cursor、Codex 等 AI 编程工具直接读取并处理 TestMate 里的用户反馈。它是对上游 [`@makethisbetter/mcp`](https://github.com/makethisbetter/mcp)（固定版本 1.11.0）的轻量封装：读取 `~/.testmate/config.json`，并额外提供 TestMate 独有的 QA 验证工具 `verify` / `reject`。

## 1. 先登录

MCP 服务器与 [TestMate CLI](https://github.com/beansmile/testmate-cli) 共用配置文件。先在 <https://testmate.beansmile.ai/settings/tokens> 创建 API Token，然后：

```bash
npx -y github:beansmile/testmate-cli login --token <token>
```

这会写入 `~/.testmate/config.json`。（若已设置 `MAKETHISBETTER_CONFIG`，则使用该路径；若只有旧的 `~/.makethisbetter/config.json`，首次启动时会自动复制一份。）

## 2. 添加到 AI 工具

**Claude Code**

```bash
claude mcp add --scope user testmate -- npx -y github:beansmile/testmate-mcp
```

**Cursor**（`~/.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "testmate": {
      "command": "npx",
      "args": ["-y", "github:beansmile/testmate-mcp"]
    }
  }
}
```

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.testmate]
command = "npx"
args = ["-y", "github:beansmile/testmate-mcp"]
```

或 JSON 形式的客户端：

```json
{ "command": "npx", "args": ["-y", "github:beansmile/testmate-mcp"] }
```

> 首次通过 `npx` 从 GitHub 安装需要几秒到几十秒；如客户端启动超时，可先全局安装：`npm i -g github:beansmile/testmate-mcp`，然后把 command 改成 `testmate-mcp`。

## 工具列表

| 工具 | 作用 |
| --- | --- |
| `list` | 列出某个项目的反馈（可按状态、标签、优先级过滤；状态含 `pending_verification`） |
| `detail` | 查看一条反馈的完整内容 |
| `pick` | 认领反馈，状态变为 in_progress |
| `respond` | 回复用户并关闭反馈 |
| `ready` | 标记已实现、待发布（需要 summary） |
| `verify` | QA 验证通过：`pending_verification` → `closed(shipped)`（`note`、`evidence_url` 可选） |
| `reject` | QA 验证失败：`pending_verification` → `in_progress`，负责人不变（`note` 必填） |
| `decline` | 以“不计划处理”关闭 |
| `duplicate` | 标记为重复 |
| `reopen` | 重新打开已关闭的反馈 |
| `archive` / `restore` | 归档 / 恢复未认领的反馈 |
| `project_list` | 列出账号下的项目 |
| `project_show` / `project_create` / `project_update` | 项目详情 / 创建 / 更新 |

> 注意：`project_show` 和 `project_create` 的返回值里包含项目的**身份验证签名密钥（signing secret）**，会进入 AI 对话上下文。不需要时请勿调用，或在客户端中禁用这两个工具。

**QA 验证是按项目开启的**（项目设置 → General →「关闭前需要 QA 验证」）。开启后，`release` 会把反馈移到「待验证」（`pending_verification`）而不是直接关闭：

```text
pending_release → pending_verification → closed(shipped)   # verify
                          └──────────────→ in_progress      # reject（note 必填）
```

`verify` / `reject` 只接受处于 `pending_verification` 的反馈，否则返回 409 `invalid_transition`。`reject` 之后修复、重新提交带 `Feedback:` trailer 的 commit，再 `ready`、`release`。

`release`（按部署的 Git 提交批量标记为已发布）**只在 CLI 中提供**，请在 CI 里用 `testmate feedback release --project <handle> --through <sha>`，见 [testmate-cli](https://github.com/beansmile/testmate-cli)。

---

## English

`testmate-mcp` is a stdio MCP server for [TestMate](https://testmate.beansmile.ai), wrapping [`@makethisbetter/mcp`](https://github.com/makethisbetter/mcp) 1.11.0. It reads `~/.testmate/config.json` (or `$MAKETHISBETTER_CONFIG`), which `testmate login --token <token>` creates (tokens: <https://testmate.beansmile.ai/settings/tokens>).

```bash
claude mcp add --scope user testmate -- npx -y github:beansmile/testmate-mcp
```

Cursor / Codex: use command `npx` with args `["-y", "github:beansmile/testmate-mcp"]` (snippets above).

Tools: `list`, `detail`, `pick`, `respond`, `ready`, `verify`, `reject`, `decline`, `duplicate`, `reopen`, `archive`, `restore`, `project_list`, `project_show`, `project_create`, `project_update`. `project_show` and `project_create` return the project's identity-verification signing secret into the model context. `release` is CLI-only.

QA verification is opt-in per project (Settings → General → "Require QA verification before closing"). When it is on, release moves Feedback to `pending_verification` ("Verifying") instead of closing it: `verify` (optional `note`, `evidence_url`) closes it as `closed(shipped)`, and `reject` (required `note`) sends it back to `in_progress` with the same assignee. Both return 409 `invalid_transition` unless the Feedback is in `pending_verification`. `list` accepts `status: "pending_verification"`.

## Development

```bash
npm ci
npm test        # node --test; connects a real MCP client over an in-memory transport
```

## License

MIT
