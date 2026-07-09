---
author: Hans
pubDatetime: 2026-07-28T10:00:00+08:00
modDatetime: 2026-07-28T10:00:00+08:00
title: Agent 系统的可量化指标:性能/质量/安全/可靠性/可维护
slug: 19-quantifiable-metrics
featured: false
draft: false
tags:
  - Hermes Agent
  - 量化
  - 质量评估
description: 梳理 agent 系统质量评估的可量化指标,用于上线前的自检、线上监控、A/B 实验,五大维度各给出 5-8 个具体指标。
---

# 19 · 可量化指标

> 哪些指标可以量化测试 / 监控?用于辅助 agent 系统质量评估。

---

## 一、性能指标

### 1.1 端到端延迟

| 指标 | 分桶 | 目标 |
|------|------|------|
| p50 latency | 按任务类型 | < 5s(简单任务) |
| p95 latency | 按任务类型 | < 30s |
| p99 latency | 按任务类型 | < 120s |
| TTFT(time to first token) | 按模型 | < 1s |
| 工具调用端到端 | 按工具 | < 2s(local) / < 10s(remote) |
| 子代理完成 | 按 role | < 5min(leaf) / < 15min(orchestrator) |

**采集方式**:`pre_*` / `post_*` hook + 关联 ID

```python
duration_ms = (post - pre) * 1000
log_metric("tool.duration_ms", duration_ms, tags={"tool": name})
```

### 1.2 Token 消耗

| 指标 | 分桶 | 目标 |
|------|------|------|
| input tokens | 按模型 / 按任务 | 越小越好(cache 命中优先) |
| output tokens | 按模型 / 按任务 | - |
| cache hit tokens | 按 provider | 最大化 |
| cache miss tokens | 按 provider | 最小化 |
| cost (USD) | 按 provider / 按 task | < $0.10 简单任务 |

**关键洞察**:Hermes 用 **frozen snapshot** 让 `MEMORY.md` 的 cache 命中率最大化。

### 1.3 工具调用

| 指标 | 目标 |
|------|------|
| 工具调用成功率(按 tool 名) | > 95% |
| 工具调用 P50/P95/P99 | 监控趋势 |
| check_fn 抖动率 | < 5%(影响 subagent 体验) |
| 工具 schema 合规率 | > 99%(normalize 防 400) |

### 1.4 子代理并发

| 指标 | 目标 |
|------|------|
| 每分钟完成的 task 数 | 监控 |
| 平均并发度 | < `max_concurrent_children` |
| 父 context 占用比例 | < 50%(summary headroom) |

---

## 二、质量指标

### 2.1 任务完成

| 指标 | 采集方式 |
|------|----------|
| 任务完成率(用户标记 success) | `/approve` + `/deny` 计数 |
| 自动判定(SWE-bench style) | `mini_swe_runner.py` |
| 多轮续作成功率 | 压缩后 task 重启是否能继续 |

### 2.2 工具调用合规

```python
# 工具调用后,parse args 用 schema 校验
try:
    validate(args, schema)
    return "ok"
except ValidationError:
    return "schema_invalid"
```

| 指标 | 目标 |
|------|------|
| JSON 解析失败率 | < 0.5% |
| 必需参数缺失率 | < 0.1% |
| 参数类型错误率 | < 0.5% |

### 2.3 压缩质量

| 指标 | 采集 |
|------|------|
| 压缩后 token 节省率 | (orig - compressed) / orig |
| 压缩后任务续作成功率 | 同 task 跨压缩后是否能继续 |
| SUMMARY_PREFIX 误触率 | 弱模型把摘要当新任务的概率 |

### 2.4 多轮一致性

| 指标 | 采集 |
|------|------|
| 50 轮对话无 context loss 率 | 跑标准 fixture |
| 跨 session 召回准确率 | 用户搜"上次 X" |
| memory 注入正确性 | MEMORY.md 写入是否生效 |

---

## 三、安全指标

### 3.1 命令拦截

| 指标 | 目标 |
|------|------|
| 危险命令拦截率(召回) | > 99% |
| 假阳性率(误拦正常命令) | < 5% |
| `DANGEROUS_PATTERNS` 覆盖率 | 持续扩充 |

**测试**:`tests/safety/` 有 dangerous command fixture。

### 3.2 Prompt 注入

| 指标 | 目标 |
|------|------|
| cron 注入扫描召回率 | > 95% |
| skill 注入扫描召回率 | > 95% |
| memory 围栏泄漏率 | 0%(scrubber 应 100% 覆盖) |

**测试**:`tools/skills_ast_audit.py` + 注入 fixture。

### 3.3 Sandbox Escape

| 指标 | 目标 |
|------|------|
| docker sandbox escape 测试 | 0 成功 |
| ssh 越权测试 | 0 成功 |
| 凭证跨 scope 访问 | 0 成功 |

### 3.4 YOLO 模式

| 指标 | 目标 |
|------|------|
| YOLO 运行时绕过尝试 | 0 成功(import 时冻结) |
| `subagent_auto_approve` 误用 | 0 生产环境启用 |

---

## 四、可靠性指标

### 4.1 MCP 子进程

| 指标 | 目标 |
|------|------|
| stdio uptime | > 99% |
| stdio 重启次数 | 监控 |
| stderr 重定向泄漏 | 0 |
| OSV 预检超时 | < 12s |
| Watchdog 触发准确率 | > 95% |

### 4.2 Provider Fallback

| 指标 | 目标 |
|------|------|
| fallback 命中率 | 监控 |
| fallback 链恢复率 | > 95%(失败后回到 primary) |
| 全链失败率 | < 0.1% |

### 4.3 Cron Ticker

| 指标 | 目标 |
|------|------|
| 心跳丢失率 | < 0.01% |
| 任务跳过率 | < 0.1% |
| 任务延迟触发率 | < 1% |
| 三层锁降级次数 | 监控(应为 0) |

### 4.4 子代理

| 指标 | 目标 |
|------|------|
| 心跳失活检测准确率 | > 95% |
| 误杀率(真在工作被判定卡死) | < 1% |
| 父 context 占用 | < 50% |

### 4.5 长会话

| 指标 | 目标 |
|------|------|
| 1000 轮对话成功率 | > 90% |
| 10K 轮 session stability | 监控 |
| context 压缩次数 | 监控趋势 |

---

## 五、可维护性指标

### 5.1 Skill Curator

| 指标 | 目标 |
|------|------|
| 合并前后 skill 数量变化 | -30%~+10% |
| 归档 skill 复活率 | > 5% |
| umbrella 技能被引用率 | > 50% |

### 5.2 Hook 异常

| 指标 | 目标 |
|------|------|
| Hook 异常率 | < 0.1%(不影响主流程) |
| Hook 延迟 P95 | < 50ms |

### 5.3 资源占用

| 指标 | 目标 |
|------|------|
| 进程 RSS | < 500MB(单 agent) |
| 子代理 RSS | < 200MB(单个) |
| 启动时间 | < 5s |
| Provider adapter 加载时间 | < 1s |

### 5.4 日志

| 指标 | 目标 |
|------|------|
| 日志异常率 | < 0.1% |
| 凭证泄漏次数 | 0(RedactingFormatter) |
| 日志大小 | 监控(rotating) |

---

## 六、成本指标

### 6.1 单任务成本

```python
cost = (
    input_tokens * input_price +
    output_tokens * output_price -
    cache_hit_tokens * cache_price
)
```

| 任务类型 | 目标 |
|----------|------|
| 简单 chat | < $0.01 |
| 代码生成(单文件) | < $0.10 |
| 深度 review | < $1.00 |
| 长会话(100 轮) | < $5.00 |

### 6.2 缓存命中率

| 指标 | 目标 |
|------|------|
| prompt cache 命中率 | > 70%(普通场景) |
| MEMORY.md 命中率 | > 90%(frozen snapshot) |
| tool schema 命中率 | > 80%(stable) |

### 6.3 多账户 / Fallback

| 指标 | 目标 |
|------|------|
| 账户轮转均匀度 | 监控 |
| 单账户失败率 | < 1% |
| 全账户失败率 | < 0.01% |

---

## 七、用户体验指标

### 7.1 TUI

| 指标 | 目标 |
|------|------|
| 启动到首 token | < 2s |
| interrupt-redirect 响应 | < 100ms |
| 自动补全 P95 延迟 | < 50ms |
| 流式输出卡顿率 | < 0.1% |

### 7.2 Gateway

| 指标 | 目标 |
|------|------|
| 平台消息 P95 投递 | < 5s |
| 多平台并发吞吐 | 监控 |
| 鉴权失败率 | < 0.1% |

### 7.3 Web / Desktop

| 指标 | 目标 |
|------|------|
| 首屏加载 | < 2s |
| API 调用 P95 | < 500ms |

---

## 八、监控实施

### 8.1 关键埋点

```python
# post_tool_call hook
{
    "event": "post_tool_call",
    "session_id": "...",
    "turn_id": "...",
    "tool_call_id": "...",
    "tool_name": "terminal",
    "duration_ms": 1234,
    "status": "ok",  # ok / error / blocked
    "input_tokens": 500,
    "output_tokens": 200,
    "error_type": null,
    "error_message": null,
}
```

### 8.2 关键指标聚合

```python
# agent/insights.py
{
    "period": "1h",
    "total_turns": 1234,
    "avg_latency_ms": 5432,
    "p95_latency_ms": 12345,
    "total_cost_usd": 12.34,
    "tool_calls_by_name": {"terminal": 567, "file_tools": 234, ...},
    "error_rate": 0.012,
    "fallback_count": 3,
}
```

### 8.3 告警阈值(建议)

| 指标 | 阈值 |
|------|------|
| P99 延迟 | > 5min 告警 |
| 错误率 | > 5% 告警 |
| Fallback 全失败 | > 0.1% 告警 |
| Cron ticker 心跳丢失 | > 1% 告警 |
| 凭证泄漏尝试 | 任何都告警 |
| YOLO 绕过尝试 | 任何都告警 |
| 内存增长 | > 1GB 告警 |

---

## 九、评测 Benchmarks

### 9.1 SWE-bench 风格

```python
# mini_swe_runner.py
def run_swe_task(task):
    """单 task 端到端"""
    trajectory = agent.run(task)
    return {
        "task_id": task.id,
        "completed": trajectory.completed,
        "duration_s": trajectory.duration_s,
        "tool_calls": len(trajectory.tool_calls),
        "tokens": trajectory.total_tokens,
        "cost": trajectory.cost,
    }
```

### 9.2 批量跑

```python
# batch_runner.py
def run_batch(tasks: List[Task]) -> List[Result]:
    """批量跑 + 聚合"""
    results = parallel_run(tasks)
    return aggregate(results)
```

### 9.3 轨迹分析

```python
# trajectory_compressor.py
def compress_trajectory(traj):
    """压缩轨迹,提取关键决策点"""
    return TrajectorySummary(
        decisions=traj.decisions,
        tool_failures=traj.failures,
        retry_count=traj.retries,
        compress_quality=traj.compress_metrics,
    )
```

---

## 十、面试中如何"量化回答"

### 模板

> "我们这个指标,**正常状态是 X,告警阈值是 Y**。通过 [具体方式] 采集,出现过 [具体案例],通过 [具体改进] 解决了。"

### 实例

> "任务完成率:目标是 > 90%,采集方式是 batch_runner 跑 N 个 task 算比例。曾经因为 SUMMARY_PREFIX 不够强,模型把摘要当新任务继续做,完成率掉到 70%。后来加 _HISTORICAL_SUMMARY_PREFIXES 剥离旧前缀 + 强化 SUMMARY_PREFIX,回到 92%。"

---

## 附录:指标速查表

| 维度 | 关键指标 | 目标 |
|------|----------|------|
| 性能 | P99 latency | < 120s |
| 性能 | Token 消耗 | 监控 |
| 性能 | Cache 命中率 | > 70% |
| 性能 | 工具调用成功率 | > 95% |
| 质量 | 任务完成率 | > 90% |
| 质量 | Schema 合规率 | > 99% |
| 质量 | 压缩续作率 | > 85% |
| 安全 | 危险命令拦截召回 | > 99% |
| 安全 | Prompt 注入召回 | > 95% |
| 安全 | 沙箱逃逸 | 0 |
| 可靠 | MCP uptime | > 99% |
| 可靠 | Fallback 命中 | 监控 |
| 可靠 | Cron 心跳丢失 | < 0.01% |
| 可靠 | 子代理误杀 | < 1% |
| 成本 | 单任务成本 | < $0.10 |
| 成本 | Cache 命中 | > 70% |
| 可维护 | Hook 异常 | < 0.1% |
| 可维护 | 内存增长 | < 1GB |

---

详见 `18-interview-questions.md` 中"如何评估"题。