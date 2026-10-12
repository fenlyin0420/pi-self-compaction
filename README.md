# pi-self-compaction

> **English** — A Pi extension that hands context control to the model: it appends a usage notice
> every few tool calls, then lets the model compact the conversation on its own schedule through
> the `compact_context` tool, instead of waiting for Pi's forced threshold compaction.
>
> Chinese documentation below.

让模型自己管上下文：每隔几次工具调用追加一条用量通知，模型在自己的边界上调 `compact_context`
压缩上下文，而不是等 Pi 到了阈值强制压。

## 为什么

Pi 内置的自动压缩是**客户端强制**的：

- 触发条件是 `contextTokens > contextWindow - reserveTokens`（默认 `reserveTokens` 16384、
  `keepRecentTokens` 20000）。检查点在每次请求前、run 结束/新 prompt 之前，另有一次
  overflow/length 恢复重试。
- 模型全程不知道自己用了多少：`getContextUsage()` 只暴露给 TUI 状态栏和扩展 API，system prompt
  里没有任何 token 字段。

于是模型往往在任务中间被强制压缩——改到一半的文件、刚起的测试——而它对此毫无准备。

## 工作原理

| 时机 | 动作 |
|---|---|
| 每 5 次顶层工具调用 | 追加一条隐藏通知：`[context] 62.3% of the 200,000 token window used. 5 tool calls since the previous notice.`（超过 60% 时多一行，提示现在该压） |
| 模型调用 `compact_context` | 只记录请求，并让本轮工具批次到此结束（`terminate: true`），不就地压缩 |
| `turn_end` | 本轮 tool results 全部落盘后执行压缩（走 manual 路径，`/compact` 的钩子与 session tree 显示照旧） |
| 压缩完成 | 在压缩后的上下文上自动起一轮新 run 续跑；失败或被取消也续跑 |

通知是持久的 `custom_message`（`display: false`：不进 TUI 记录，但参与模型上下文），纯尾部追加，
不使前缀缓存失效。策略写在工具的 `promptGuidelines` 里，进默认 system prompt 的 Guidelines 段，
同样是静态文本。

内置阈值压缩保持开启，作为模型判断失准时的兜底；两者不冲突。

## 安装

```bash
# git 安装（推荐）
pi install git:github.com/fenlyin0420/pi-self-compaction

# 或直接放一个文件到用户扩展目录
cp index.ts ~/.pi/agent/extensions/self-compaction.ts

# 或单次试用
pi -e ./index.ts
```

## 调参

`index.ts` 顶部两个常量：

| 常量 | 默认 | 含义 |
|---|---|---|
| `USAGE_NOTICE_INTERVAL` | `5` | 每多少次顶层工具调用追加一次用量通知 |
| `COMPACT_HINT_PERCENT` | `60` | 通知里开始建议模型压缩的用量百分比 |

## 工具

`compact_context({ instructions?: string })`

`instructions` 给摘要一个侧重方向，例如 `keep the exact API contract and the failing test output`。
调用后本轮结束，压缩在边界执行，随后任务自动续跑。

## 设计说明（为什么这么绕）

- **不能在工具里直接 await 压缩。** `session.compact()` 第一件事是 `await abort()`，而 `abort()`
  会 `await waitForIdle()`（`isIdle = !_isAgentRunActive && !isCompacting`）。在 run 内部 await
  它 = 工具等 run 结束、run 等工具返回，永久卡死。所以压缩放在 `turn_end`，且 fire-and-forget：
  让 abort 自然收掉这一轮，压缩在 run settle 之后才真正开始。
- **工具结果带 `terminate: true`。** 否则工具批次结束后核心循环还会再起一轮 assistant 请求，而那一轮
  的 stream 会被 abort，以“操作被中止”的样子出现在会话里。让批次在此结束，就没有活着的 stream 可中止。
- **失败也续跑。** 压缩可能因为 “Nothing to compact (session too small)” 或被取消而失败，此时当前 run
  已经因 abort 结束，不续跑就等于静默丢掉任务。

## 已知限制

- 只统计顶层工具调用；codemode 等嵌套调用算在其父调用上。
- 用量来自最近一次 assistant 响应的 usage，其后的工具结果是字符估算，越接近阈值越粗。
- 通知是快照：切换模型后按新模型的 `contextWindow` 计算，历史通知里的数字属于旧模型。
- 上下文窗口未知（`contextWindow <= 0`，例如未声明窗口的 virtual model）时通知会跳过，并在下一次
  工具调用时重试。

## License

MIT
