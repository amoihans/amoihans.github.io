---
author: Hans
pubDatetime: 2026-07-18T10:00:00+08:00
modDatetime: 2026-07-18T10:00:00+08:00
title: Hermes Agent MCP 集成:客户端 + 服务端双向
slug: 09-mcp
featured: false
draft: false
tags:
  - Hermes Agent
  - MCP
description: 解析 MCP 客户端(250KB)与服务端(mcp_serve.py, 36KB)的双向集成、OAuth 鉴权、stdio 看门狗、动态工具注入。
---

# 09 · MCP 集成(Model Context Protocol)

## 概述

Hermes 的 MCP 实现是 OSS 生态里**最完整**的之一:
- **客户端**(`tools/mcp_tool.py`, 250 KB):stdio / HTTP / SSE 三种 transport
- **服务端**(`mcp_serve.py`, 36 KB):Hermes 自己也可以作为 MCP 服务器对外暴露
- **OAuth 2.0**(`tools/mcp_oauth.py` + `mcp_oauth_manager.py`)
- **stdio 看门狗**(`tools/mcp_stdio_watchdog.py`)
- **Sampling**(MCP server 反向请求 LLM)
- **OSV 恶意软件预检**(`tools/osv_check.py`)

---

## 客户端架构

```mermaid
flowchart TB
    subgraph Loop["MCP 事件循环(daemon thread)"]
        EventLoop["_mcp_loop()"]
    end

    subgraph Servers["MCP Servers(每个一个 asyncio Task)"]
        S1["server #1<br/>(stdio)"]
        S2["server #2<br/>(HTTP)"]
        S3["server #3<br/>(SSE)"]
    end

    subgraph Bridge["同步桥(run_coroutine_threadsafe)"]
        Bridge["主线程 → asyncio"]
    end

    subgraph Reg["Tool Registry"]
        McpTools["mcp_<server>_<tool>"]
    end

    Loop --> S1
    Loop --> S2
    Loop --> S3
    Bridge --> Loop
    S1 --> Reg
    S2 --> Reg
    S3 --> Reg
```

**关键设计**:
- **专用后台事件循环**(daemon thread,`_mcp_loop`)
- 每个 MCP server 一个**长期 asyncio Task**
- 主线程通过 `run_coroutine_threadsafe` 调用

---

## 三种 Transport

`tools/mcp_tool.py:13-61`:

| Transport | 用途 | 示例 |
|-----------|------|------|
| **stdio** | 本地进程(stdin/stdout) | 官方 mcp servers |
| **HTTP** / Streamable HTTP | 远程 HTTP | 远程 MCP server |
| **SSE** | Server-Sent Events(legacy) | 老 MCP 协议 |

### 配置示例

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
    timeout: 30
    connect_timeout: 10
    keepalive_interval: 60
    idle_timeout_seconds: 300
    max_lifetime_seconds: 3600
    supports_parallel_tool_calls: true
    sampling:
      enabled: true
      model: anthropic/claude-3.5-sonnet
      max_tokens_cap: 4000
      timeout: 60
      max_rpm: 30
      allowed_models: [...]
      max_tool_rounds: 3
    headers:
      Authorization: Bearer ...

  - name: linear
    url: https://mcp.linear.app/sse
    transport: sse
    oauth:
      client_id: ...
      scopes: ["read", "write"]
```

---

## Sampling(MCP 反向调用 LLM)

MCP server 可以请求 LLM 完成(`sampling/createMessage`):
- 文本响应
- 工具调用响应

可配置:
- `enabled` —— 是否启用
- `model` —— 强制使用哪个模型
- `max_tokens_cap` —— 上限
- `timeout` / `max_rpm`
- `allowed_models` —— 白名单
- `max_tool_rounds` —— 工具调用轮次
- `log_level` —— 日志

**安全**:`allowed_models` 防止 server 偷偷换模型。

---

## 安全设计

### 环境变量过滤
stdio 子进程继承时过滤敏感环境变量。

### 凭证剥离
错误消息中**不包含凭证**(返回 LLM 前清洗)。

### OSV 恶意软件预检
```python
# tools/osv_check.py
osv_check(server, timeout=12)  # 12s 外层超时
```

`#29184` —— 防止卡住的 SSL 握手冻结整个 MCP 循环。

### stderr 重定向
默认 MCP stdio 子进程 stderr 会写到用户 TTY,污染 prompt_toolkit。
**Hermes 重定向到**:`~/.hermes/logs/mcp-stderr.log`,带 server name 标签。

### Stdio Watchdog
`tools/mcp_stdio_watchdog.py`(7 KB)监控 stdio 子进程健康。

---

## OAuth 2.0

`tools/mcp_oauth.py`(40 KB)+ `tools/mcp_oauth_manager.py`(33 KB):
- 完整 OAuth 2.0 / 2.1 流
- Dynamic Client Registration(Linear 等)
- Token 持久化 + 刷新

---

## Cron 集成

每个 cron job 的工具集可叠加 MCP servers(`#cross-layer`)。

详见 `05-cron-scheduling.md`。

---

## Hermes 作 MCP Server(`mcp_serve.py`,36 KB)

Hermes 也可以**对外**作为 MCP server,把自己的工具暴露给其他 client:

```bash
# 启动 Hermes MCP server
hermes mcp serve --port 8080

# 其它 MCP client 配置连接到 Hermes
{
  "mcpServers": {
    "hermes": {
      "url": "http://localhost:8080/sse"
    }
  }
}
```

`agent/transports/hermes_tools_mcp_server.py` 实现。

---

## 可选 MCP 目录(`optional-mcps/`)

社区批准的内置 MCP servers:

- `linear/` —— Linear 项目管理(manifest.yaml 用 OAuth 2.1 + DCR)
- `n8n/` —— 工作流自动化
- `unreal/` —— Unreal Engine

**规则**:**只要在 `optional-mcps/` 下,就视为已批准**。

---

## 工具发现

每个 MCP server 的工具自动注册到 Tool Registry:

```
mcp_<server-name>_<tool-name>
```

示例:`mcp_github_create_issue`、`mcp_linear_list_projects`。

LLM 在 system prompt 中看到完整工具列表。

---

## 关键设计原则

1. **专用后台事件循环**:不阻塞主线程
2. **三种 transport**:stdio / HTTP / SSE 全覆盖
3. **Sampling 反向调用**:server 可主动用 LLM
4. **per-server 配置**:keepalive、idle、lifetime 精细控制
5. **OSV 预检**:防恶意 server
6. **stderr 重定向**:防 prompt_toolkit 污染
7. **OAuth 2.1 + DCR**:标准协议
8. **Watchdog**:stdio 健康监控
9. **双向 MCP**:既是 client 也是 server
10. **可选目录白名单**:简化用户决策

---

## 常见坑 / 面试考点

- Q:**MCP server 卡死怎么办?**
  A:Watchdog + idle_timeout + max_lifetime 自动回收
- Q:**stderr 污染 prompt 怎么办?**
  A:重定向到 `~/.hermes/logs/mcp-stderr.log`
- Q:**Sampling 是否安全?**
  A:`allowed_models` 白名单强制约束
- Q:**OSV 预检为什么有超时?**
  A:`#29184` —— 卡住的 SSL 握手会冻循环,12s 切断
- Q:**Hermes 自己可以作为 MCP server 吗?**
  A:可以,`mcp_serve.py`

详见 `18-interview-questions.md` 中"MCP"类题目。