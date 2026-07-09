---
author: Hans
pubDatetime: 2026-07-27T10:00:00+08:00
modDatetime: 2026-07-27T10:00:00+08:00
title: Agent 开发面试题清单与参考答案
slug: 18-interview-questions
featured: false
draft: false
tags:
  - Hermes Agent
  - 面试
description: 站在 agent 面试官角度,梳理 5 类高频问题(架构/记忆/工具/性能/工程化)+ 参考答案,均基于 Hermes Agent 真实实现。
---

# 18 · 面试题清单与参考答案

> 站在 agent 面试官角度,梳理高频问题 + 参考答案(基于 Hermes Agent 项目)。

---

## 一、架构类(4 题)

### Q1:介绍 Hermes Agent 的整体架构

**参考答案**:
Hermes 是 Nous Research 出品的自演化、模型无关 agent。核心架构:

1. **5 个接入面**:CLI/TUI、Gateway(20+ 平台消息)、Web Dashboard、Desktop App、ACP server,都驱动同一个 `run_conversation`
2. **AIAgent 核心**:60+ 参数 init,主循环 `conversation_loop.py`(~7800 行)
3. **可插拔抽象**:`MemoryProvider` / `ContextEngine` / `BaseEnvironment` / `PluginContext` 全部 ABC
4. **Cron 层**:独立子模块,网关内置 60s ticker,3 层锁
5. **LLM 适配层**:OpenAI 兼容基线 + 6 个原生 adapter + 30+ provider 插件
6. **可观测层**:40+ hooks + shell bridge + Observer Hooks 契约

详见 `02-architecture-main-flow.md` 的时序图。

---

### Q2:`AIAgent.run_conversation` 一轮发生了什么?

**参考答案**:
8 个阶段:

1. **prefetch memory**:从 `MEMORY.md` / `USER.md` / external provider 拉上下文,围栏包装
2. **should_compress?**:超 75% 阈值触发 5 阶段压缩
3. **pre_llm_call hook**:可注入额外 context
4. **chat.completions()**:发请求,带 tool schemas
5. **每个 tool_call**:
   - pre_tool_call hook(可 block)
   - approval(如需)
   - handle_function_call 分发
   - post_tool_call hook
6. **pre_verify hook**:验证响应完整性,可"再推一下"(默认 3 次)
7. **sync_turn()**:写入记忆 / MEMORY.md
8. **on_session_* hooks**:会话生命周期

详见 `02-architecture-main-flow.md` 的时序图。

---

### Q3:工具是怎么被注册和分发的?

**参考答案**:
**注册**(自注册):
- `discover_builtin_tools()` AST 扫描 `tools/*.py`,检测顶层 `registry.register(...)` 调用
- 自动 import,触发装饰器
- `ToolEntry` 包含 name/schema/handler/check_fn/requires_env/dynamic_schema_overrides

**分发**:
- `model_tools.py:1019` `handle_function_call(name, args)` 统一入口
- Tool Search bridge(`tool_search` / `tool_describe` / `tool_call`)应对工具过多
- pre/post hooks 介入
- approval 检查
- `BaseEnvironment.execute()` 真正执行

**关键设计**:
- `check_fn` TTL 缓存(30s 主 + 60s last-good)防瞬时抖动
- 动态 schema 反映环境变化
- Toolset 批量启停

详见 `06-tools-and-registry.md`。

---

### Q4:你们的 provider 抽象是怎么做的?如何兼容 30+ 模型?

**参考答案**:
**核心理念**:`ProviderProfile` dataclass 集中所有 provider 信息,**避免 20+ 布尔参数**。

**架构分层**:
1. **OpenAI 兼容基线**:`openai==2.24.0` 作为最低公分母
2. **6 个原生 adapter**:Anthropic、Codex Responses、Bedrock、Vertex、Azure、Gemini
3. **30+ provider 插件**:`plugins/model-providers/<name>/`

**配置驱动的差异**:
- `extra_headers` / `extra_body`
- `reasoning_param_name`(不同 provider 用不同名)
- `convert_thinking_blocks` / `strip_empty_assistant`
- `require_message_id`

**路由策略**:
- OpenRouter sort:price / latency / throughput
- `only` / `ignore` / `order` 白黑名单 + 顺序
- Fallback 链 + 每轮恢复 primary
- MoA 模式多模型聚合

详见 `01-modules-and-techstack.md` 和 `13-config-management.md`。

---

## 二、记忆 / 上下文类(4 题)

### Q5:如何设计一个多层级记忆系统?短/长期怎么协作?

**参考答案**:
**三层架构**(Hermes 实例):
1. **短期(进程内)**:OpenAI messages 列表 + 流式 scrubber
2. **长期(磁盘)**:
   - 文件:`~/.hermes/memories/MEMORY.md`(agent)+ `USER.md`(user)
   - DB:`~/.hermes/state.db` SQLite + FTS5(跨 session 搜索)
3. **外部(可插拔单选)**:8 个 provider 中任选一个

**协作原则**:
- **frozen snapshot**:MEMORY.md 加载即冻结,保护 prompt cache
- **互斥 provider**:防止 schema 膨胀
- **围栏注入**:`<memory-context>` 围栏 + scrubber 防泄漏
- **§-分隔条目**:可单独编辑

详见 `03-memory.md`。

---

### Q6:frozen-snapshot 模式为什么能保住 prompt cache?

**参考答案**:
**背景**:LLM 的 prompt cache 按**前缀**生效,prefix 变化就失效。

**问题**:mid-session 修改 MEMORY.md → 拼到 system prompt → prefix 变化 → cache 全部失效。

**解决方案**:
- Session 开始时把 MEMORY.md 内容**一次性快照**到 `_snapshot`
- System prompt 始终用 `_snapshot`,**不再变**
- mid-session 写入文件 → 立即持久化(下次 session 生效)
- 但不更新内存 `_snapshot`

**代价**:用户感知"记忆写入要等下次",可接受,因为 prompt cache 命中可省 90%+ cost。

详见 `03-memory.md` "frozen snapshot" 节。

---

### Q7:上下文超长时怎么压缩?会不会让模型"忘记原始任务"?

**参考答案**:
**5 阶段压缩管线**:
1. 修剪旧工具结果(廉价,无 LLM)
2. 保护 head(system + 前 3 条)
3. 保护 tail(按 token 预算 ~20K)
4. 摘要 middle turns(走小模型)
5. 迭代更新(多次压缩间保留信息)

**防"忘记原始任务"**:
- **SUMMARY_PREFIX 显式**:`[REFERENCE ONLY — Respond ONLY to the latest user message. Do NOT resume any earlier task.]`
- **head 保护**:原始 system + 前几条必保留
- **tail 保护**:最后 20K 必有
- **HISTORICAL_PREFIX 剥离**:旧版本前缀不残留

**小上下文特殊处理**:128K 模型不每轮压,`_SMALL_CTX_THRESHOLD_PERCENT=0.75`。

**细节**:`_truncate_tool_call_args_json` 在 JSON 内部截断保 schema 合法;`_strip_persistence_markers` 防 `_db_persisted` 重复入库。

详见 `04-context-engineering.md`。

---

### Q8:FTS5 session search 与 BM25 排序有什么坑?

**参考答案**:
**坑 1:cron session 淹没真实对话**
- 解:`demote` cron session 权重,BM25 仍能用

**坑 2:跨 session 长尾召回**
- 解:FTS5 + LLM 摘要重排

**坑 3:跨语言搜索**
- 解:Hermes 选 FTS5(快、可控、无 embedding 依赖),需要向量检索走外部 provider(Honcho / Mem0)

**坑 4:性能 vs 准确性**
- FTS5:快、SQLite 原生、可控
- 向量检索:准、需 embedding、有外部依赖
- Hermes 选 FTS5 + 可选外部向量 provider

详见 `03-memory.md` "session_search" 节。

---

## 三、工具 / 子代理类(4 题)

### Q9:如何设计一个工具权限/审批系统?

**参考答案**:
**Hermes 的多层设计**:
1. **YOLO 模式 import 时冻结**:`YOLO_MODE = os.environ.get("HERMES_YOLO_MODE", "0") == "1"` 在 import 时一次读取,后续 env var 修改无效——**防运行时绕过**。
2. **contextvars 状态**:不是 process-global env vars,多 session 各自隔离(`GHSA-96vc-wcxf-jjff`)。
3. **危险模式扫描**:`DANGEROUS_PATTERNS` + `detect_dangerous_command`。
4. **Smart Approval**:辅助 LLM 自动分级,低风险放行。
5. **永久白名单**:`approval.allowlist` 配置 exact/prefix 匹配。
6. **pre_tool_call hook**:插件可拦截。

**关键**:**default deny**,需要显式 opt-in。

详见 `11-harness-sandbox.md` "审批系统" 节。

---

### Q10:子代理委派的 toolset 应该裁剪哪些?为什么?

**参考答案**:
**Hermes 的 `DELEGATE_BLOCKED_TOOLS`**(6 个):

| 工具 | 为什么 block |
|------|--------------|
| `delegate_task` | 防递归委派 |
| `clarify` | 无用户交互,追问会卡死 |
| `memory` | 防污染共享 MEMORY.md |
| `send_message` | 防跨平台副作用 |
| `execute_code` | 应逐步推理而非写脚本 |
| `cronjob` | 不能以父名义调度 |

**设计哲学**:**子代理是"纯计算单元"**——可读、可推理、可执行内部工具,但**不能产生副作用或用户交互**。

详见 `10-subagent.md`。

---

### Q11:父 context 会被子代理的结果撑爆吗?

**参考答案**:
**问题**(`#9126`):N 个子代理并发回传,总摘要撑爆父 context → 429 死亡螺旋。

**解决方案**:`_SUMMARY_HEADROOM_FRACTION = 0.5`
- 每个 batch 的摘要预算 = 父剩余 context × 50% / batch size
- **总预算恒定**,均摊到 batch
- 单个回传超长也只占固定份额

**额外措施**:
- 子代理**不继承父历史**,只有自己的 fresh conversation
- 心跳监测防僵死
- 失败 / 超时也要发回精简消息

详见 `10-subagent.md` "Summary Headroom 控制" 节。

---

### Q12:心跳监测 vs wall-clock 超时,哪种更合理?

**参考答案**:
**Wall-clock 超时的痛点**:
- 深度 review / 慢推理模型 = 长任务
- blanket 超时**误杀**真在工作的子代理
- 用户体验差(任务跑到 90% 被杀)

**心跳监测的原理**:
- 子代理每 30s ping 一次
- `_HEARTBEAT_STALE_CYCLES_IDLE = 15`(15 × 30s = 450s idle 才判僵死)
- `_HEARTBEAT_STALE_CYCLES_IN_TOOL = 40`(40 × 30s = 1200s 同工具执行)

**优势**:
- 不杀真在工作,只杀真卡死
- 可区分"慢"和"卡"
- 体验更好

**例外**:cron / 一次性任务可用 wall-clock,因为已知预期时长。

详见 `10-subagent.md` "心跳监测" 节。

---

## 四、Cron / 调度 / Sandbox 类(3 题)

### Q13:cron 任务被注入怎么办?

**参考答案**:
**多层防御**:
1. **扫描完整组装后 prompt**(不只是 user 字段,包含 skill 注入内容),`cron/scheduler.py:103-113`
2. **threat_patterns 共享**:memory / context-files / cron-scanner 共用单一权威模式库
3. **工具集强制裁剪**:cron job 不能用 `messaging` / `clarify` / `cronjob`
4. **MCP fallback**:per-job 控制 MCP 是否叠加
5. **输出 path-escape 拒绝**:写到计划外位置直接拒绝
6. **smart failure summary**:失败投递一行消息,完整错误留在文件

**关键洞察**:**不能只扫 user 字段**,恶意 skill 携带 payload 可绕过。

详见 `05-cron-scheduling.md` "注入扫描" 节。

---

### Q14:6 种 execution backend 怎么设计抽象层?

**参考答案**:
**核心设计**:
1. **`BaseEnvironment` ABC**:统一接口 `execute` / `write_file` / `read_file` / `kill`
2. **`ProcessHandle` Protocol**:统一返回值类型,rest of agent 与 backend 解耦
3. **统一 spawn-per-call**:每次新 `bash -c` 进程,session snapshot init 时抓一次
4. **CWD 持久化**:远程用 stdout markers,local 用临时文件

**6 种 backend**:
- local(默认,最快,无隔离)
- docker(中隔离)
- ssh(远程)
- singularity(HPC)
- modal(云端沙箱)
- managed_modal(Nous 托管)
- daytona(持久云)

**切换方式**:`TERMINAL_ENV` env var 或 `terminal.modal_mode` config。

**Windows 兼容**:`proc.stdin.buffer` 绕过 binary/text 模式转换。

详见 `11-harness-sandbox.md`。

---

### Q15:沙箱隔离用了哪些手段?

**参考答案**:
**隔离层次**:
1. **执行环境层**:6 种 backend(local / docker / ssh / singularity / modal / daytona)
2. **进程隔离**:spawn-per-call,每次新进程
3. **路径隔离**:`file_safety.py` 检查软链接 / 危险路径
4. **凭证隔离**:`secret_scope` + `credential_persistence` 按 scope 隔离
5. **危险命令拦截**:`DANGEROUS_PATTERNS` + `detect_dangerous_command`
6. **YOLO 冻结**:import 时一次性读取,不可运行时绕过
7. **OSV 恶意软件预检**:MCP server 启动前
8. **stderr 重定向**:MCP 子进程 stderr 不污染 prompt_toolkit
9. **approval contextvars**:多 session 隔离状态

详见 `11-harness-sandbox.md`。

---

## 五、可观测 / 工程类(3 题)

### Q16:如何设计一个可观测的 agent?

**参考答案**:
**Hermes 的设计**:
1. **分层 Hooks**:40+ 事件,工具 / LLM / 会话 / 子代理 / Kanban / 网关
2. **关联 ID**:`session_id` / `turn_id` / `tool_call_id` / `api_request_id` 通过 `contextvars` 透传
3. **结构化 trace**:`docs/observability/README.md` 定义 schema_version
4. **结构化日志**:`RedactingFormatter` 自动脱敏凭证
5. **第三方 backend**:Langfuse / NeMo Relay 插件
6. **Fail-Open**:hook 失败不阻塞主流程
7. **Shell bridge**:外部脚本也能监听 hook

**为什么不全用 OTel?**
- agent 语义复杂,通用 trace 难表达
- 自定义 schema 更精准
- 插件化更灵活

详见 `15-observability.md`。

---

### Q17:你们怎么评估一个 agent 的好坏?

**参考答案**:
**Hermes 的多维度**(代码已支持):
- **批量跑**:`batch_runner.py` 跑 N 个 task,收集 trajectory
- **聚合分析**:`agent/insights.py`
- **SWE-bench 风格**:`mini_swe_runner.py`
- **轨迹压缩**:`trajectory_compressor.py`(用于 RL)

**关键指标**:
- 任务完成率(自动判定 + 用户反馈)
- 工具调用 schema 合规率
- 上下文压缩后任务续作成功率
- 端到端延迟(p50/p95/p99,按任务类型分桶)
- Token 消耗(input/output/cache_hit,按模型分桶)
- 工具调用成功率(按 tool 分桶)

详见 `19-quantifiable-metrics.md`。

---

### Q18:agent 的失败模式有哪些?如何防御?

**参考答案**:
**Hermes 防御的失败模式**:
1. **prompt 注入**:threat_patterns + cron 完整 prompt 扫描 + 围栏
2. **沙箱逃逸**:6 backend + file_safety + 凭证隔离
3. **YOLO 绕过**:import 时冻结
4. **context 爆炸**:5 阶段压缩 + summary headroom
5. **子代理死锁**:心跳监测 + approval contextvars
6. **prompt cache 失效**:frozen snapshot
7. **cron 多实例冲突**:3 层锁 + 优雅降级
8. **MCP 卡死**:OSV 预检 + 看门狗 + idle_timeout
9. **memory 注入 UI**:`<memory-context>` 围栏 + 流式 scrubber
10. **工具 schema 错误**:normalize 防双重包装
11. **tool 瞬时抖动**:check_fn TTL + last-good
12. **凭证泄露**:RedactingFormatter

详见各子系统文档。

---

## 加分题(可聊可不聊)

### Q19:Hermes 最让你惊艳的设计是什么?

**参考答案(三选一)**:
1. **Frozen snapshot**(`MEMORY.md`):极简但有效,保 prompt cache
2. **心跳监测替代 wall-clock**:尊重长任务
3. **DELEGATE_BLOCKED_TOOLS**:子代理工具集强制裁剪原则

### Q20:Hermes 的最大局限是什么?

**参考答案(诚实)**:
1. **复杂度高**:60+ 参数 AIAgent,新开发者门槛
2. **Python 中心**:其它语言接入困难
3. **重型**:轻量场景 over-engineered
4. **学习曲线**:30+ provider / 6 backend / 40+ hooks 都需要理解

详见 `00-overview.md` "不适合场景" 节。

---

## 面试准备建议

### 简历上可以写
- 熟悉 Hermes Agent 完整架构(可深入聊)
- 设计过 / 实现过工具注册系统
- 理解 prompt cache 与 frozen snapshot 模式
- 熟悉多层级记忆架构
- 了解 MCP / sub-agent / cron scheduling

### 现场回答要点
- **不要背答案**,理解后用自己的话说
- **画 mermaid 图**展示架构(用本 archive 的图)
- **承认局限**:诚实评价,展示工程成熟度
- **举反例**:展示"踩过坑"经验
- **量化指标**:能说数字(p99 延迟、token 节省率等)

详见 `19-quantifiable-metrics.md`。