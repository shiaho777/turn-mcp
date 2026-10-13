# turn-mcp-web

把一次 Agent 请求扩展成可持续的人机协作对话。

`turn-mcp-web` 是一个自托管 MCP 服务，配套一个浏览器控制台。Agent 调用 `turn.wait` 后暂停执行，人工在网页里回复，同一轮运行继续向下执行，而不是重新开一轮。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)](https://nodejs.org)

[English](./README.md)

## 预览

<p align="center">
  <img src="./assets/screenshots/live-review-session.png" alt="实时会话界面" width="100%">
</p>

<p align="center">
  <img src="./assets/screenshots/settings-overview.png" alt="设置总览" width="32%">
  <img src="./assets/screenshots/setup-snippets.png" alt="客户端接入片段" width="32%">
  <img src="./assets/screenshots/language-picker.png" alt="首次启动语言选择" width="32%">
</p>

## 这个项目解决什么问题

大多数 Agent 系统里，“人工确认”通常意味着一次运行的终点：

- 模型提问
- 当前运行结束
- 用户回复后重新开新一轮

`turn-mcp-web` 把这个确认点放回同一次执行链里：

```text
做事 -> turn.wait -> 人工回复 -> 继续做事 -> turn.wait -> 人工回复
```

它适合审批、分支决策、值班交接、代码审阅、运维确认、长流程辅助执行。

工具返回的就是操作者的原话。每次等待都会进入一个终态：回复、超时、取消或中断。会话断开或服务关闭时，挂起的等待会被结束，而不是一直留在控制台里。

## 功能概览

- MCP 工具别名：`turn.wait`、`turn_wait`、`turn`
- 浏览器控制台实时回复
- 面向 IDE 客户端的 Streamable HTTP
- 面向桌面客户端的 stdio 入口
- 面向 Python 和非 MCP 框架的 REST 长轮询
- 持久化历史与事件日志
- Webhook 与 Telegram 通知
- operator / viewer 两级鉴权
- 会话列表、快捷回复、超时控制、SSE 实时刷新
- 本地一键启动

## 快速开始

### macOS

双击 `start.command`

### Windows

双击 `start.bat`

### Linux

```bash
bash start.sh
```

### 源码运行

```bash
npm install
npm run build
npm start
```

控制台：`http://127.0.0.1:3737/`  
MCP 端点：`http://127.0.0.1:3737/mcp`

## 核心工作流

1. 启动服务。
2. 把 MCP 客户端连到 `http://127.0.0.1:3737/mcp`，或者用 stdio 方式启动。
3. 把 [`skills/turn-mcp-web/SKILL.md`](./skills/turn-mcp-web/SKILL.md) 交给 Agent；如果需要中文 handoff，可同时参考 [`skills/turn-mcp-web/references/skill.zh-CN.md`](./skills/turn-mcp-web/references/skill.zh-CN.md)。
4. Agent 在需要人工输入时调用 `turn.wait`。
5. 你在浏览器控制台回复，同一轮运行继续执行。

## 客户端接入

### Streamable HTTP

适用于 Cursor、Windsurf、VS Code、Claude Code、Antigravity 等支持远程 MCP 的客户端。

```json
{
  "mcpServers": {
    "turn-mcp-web": {
      "url": "http://127.0.0.1:3737/mcp"
    }
  }
}
```

Windsurf 需要使用 `serverUrl` 字段。

### stdio

适用于通过本地子进程拉起 MCP 服务的客户端。

```json
{
  "mcpServers": {
    "turn-mcp-web": {
      "command": "node",
      "args": ["/绝对路径/dist/server-stdio.js"]
    }
  }
}
```

即使使用 stdio，浏览器控制台仍然运行在 `3737` 端口。

### Python

当你的框架不直接支持 MCP 时，可以使用仓库内的 Python client。

```bash
pip install ./python-client
```

```python
from turn_mcp_client import TurnMcpClient, TurnMcpCanceled, TurnMcpTimeout

client = TurnMcpClient("http://127.0.0.1:3737")

try:
    reply = client.wait(
        context="准备执行生产环境迁移。",
        question="是否继续？",
        options=["继续", "先看 SQL", "取消"],
        agent_name="MigrationAgent",
    )
    print(reply)
except TurnMcpTimeout:
    print("超时未回复。")
except TurnMcpCanceled:
    print("操作员已取消。")
```

更多示例见：[`python-client/README.md`](./python-client/README.md)

## Agent 约束文档

给 Agent 提供下面任一文件：

- 技能入口：[`skills/turn-mcp-web/SKILL.md`](./skills/turn-mcp-web/SKILL.md)
- 中文参考：[`skills/turn-mcp-web/references/skill.zh-CN.md`](./skills/turn-mcp-web/references/skill.zh-CN.md)

这些文档会要求 Agent 通过 `turn.wait` 与人沟通，而不是直接结束回复。

## API

### 公开接口

- `GET /healthz`
- `GET /api/public-config`

### wait 与会话控制

- `GET /api/waits`
- `GET /api/waits/:id`
- `POST /api/waits/:id/respond`
- `POST /api/waits/:id/cancel`
- `POST /api/waits/:id/extend`
- `POST /api/waits/cancel-all`
- `POST /api/waits/create-and-wait`

### 历史与事件

- `GET /api/history`
- `GET /api/history/timeline`
- `GET /api/events`
- `GET /api/stream`

### 运行时管理

- `GET /api/auth-check`
- `GET /api/sessions`
- `POST /api/settings`
- `POST /api/auto-configure`
- `POST /api/auto-unconfigure`

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `TURN_MCP_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `TURN_MCP_HTTP_PORT` | `3737` | HTTP 监听端口 |
| `TURN_MCP_HTTP_PATH` | `/mcp` | MCP 路径 |
| `TURN_MCP_DEFAULT_TIMEOUT_SECONDS` | `600` | 默认等待超时 |
| `TURN_MCP_API_KEY` | 未设置 | operator 密钥 |
| `TURN_MCP_VIEWER_API_KEY` | 未设置 | viewer 密钥 |
| `TURN_MCP_REQUIRE_API_KEY` | auto | 是否开启鉴权 |
| `TURN_MCP_EVENT_LOG_FILE` | 未设置 | 事件 JSONL 路径 |
| `TURN_MCP_HISTORY_FILE` | 未设置 | 历史 JSONL 路径 |
| `TURN_MCP_WEBHOOK_URL` | 未设置 | Webhook 目标地址 |
| `TURN_MCP_WEBHOOK_EVENTS` | 未设置 | Webhook 事件过滤 |
| `TURN_MCP_WEBHOOK_SECRET` | 未设置 | HMAC 签名密钥 |
| `TURN_MCP_WEBHOOK_FORMAT` | `json` | `json`、`slack`、`discord` |
| `TURN_MCP_TELEGRAM_BOT_TOKEN` | 未设置 | Telegram bot token |
| `TURN_MCP_TELEGRAM_CHAT_ID` | 未设置 | Telegram chat id |
| `TURN_MCP_TELEGRAM_EVENTS` | `wait_created` | Telegram 事件过滤 |
| `TURN_MCP_RATE_LIMIT_MAX` | `120` | 每 IP 请求上限 |
| `TURN_MCP_RATE_LIMIT_WINDOW_SECONDS` | `60` | 限流窗口 |
| `TURN_MCP_MAX_CONCURRENT_WAITS_PER_SESSION` | `10` | 单会话并发 wait 上限 |
| `TURN_MCP_MAX_PENDING_WAITS` | `100` | 进程内挂起等待上限 |
| `TURN_MCP_MAX_CONTEXT_CHARS` | `100000` | `context` 最大长度 |
| `TURN_MCP_EVENT_LOG_MAX_ITEMS` | `2000` | 内存中保留的事件条数 |

## 鉴权

监听在本机回环地址时，鉴权默认关闭。监听地址不是回环地址时，必须设置 `TURN_MCP_API_KEY`，并且不能关掉鉴权，否则进程拒绝启动。浏览器控制台只接受同源请求：跨站页面和 DNS 重绑定的 Host 会被拒绝，密钥也不再从查询参数读取。

开启鉴权后，用下面任一请求头，或控制台写入的 `turn_mcp_key` cookie：

```text
x-turn-mcp-api-key: <key>
Authorization: Bearer <key>
```

角色：

- `operator`：完整控制权限
- `viewer`：只读查看和 SSE 订阅

## Docker

```bash
docker build -t turn-mcp-web .
docker run --rm -p 3737:3737 \
  -e TURN_MCP_HTTP_HOST=0.0.0.0 \
  -e TURN_MCP_API_KEY=your_key \
  turn-mcp-web
```

Compose 文件：[`docker-compose.yml`](./docker-compose.yml)

## 仓库结构

```text
src/            TypeScript 服务端
public/         浏览器控制台
python-client/  Python 客户端
assets/         README 截图与演示视频
```

## 贡献

参见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## 许可证

MIT
