# 自动抽取：向 Claude Code 官方形态靠拢

日期：2026-11-15
范围：`autoExtract` 从“可选、单次 JSON、只进 Inbox”改为“默认开启、5-turn 工具循环、直接写记忆”。
未范围：Dream 的 agent 化。

## 1. 目标

用户指出四处与 Claude Code 官方不一致：

1. 官方只给模型路径 + session id，由模型自己 grep/读文件；插件把未读对话切块推给模型。
2. 官方按需搜索、每次最多约 50 行结果；插件把每个未读 session 的所有 user 消息、上一条回复和错误都塞进去。
3. 官方模型自己读索引和需要的页；插件每个 chunk 只给索引，验证时只读相关页。
4. 官方只记一个时间边界（lock 文件 mtime）；插件记 per-session event cursor。

结论是 80–90% 的行为可以复刻，其中自动抽取和 Dream 是两个真正的缺口。本次先改自动抽取。

## 2. 改了什么

### 2.1 新增进程内工具循环 `src/tool-loop.js`

`runToolLoop({ ctx, model, system, prompt, tools, executeTool, maxTurns=5, maxTokens, purpose, signal })`

- 直接调用宿主 `llm.stream`，传入 `tools`；
- 收集 `tool-call-delta` 与 `block-end` 里的 `tool-call`；
- 追加 assistant 消息（含 tool-call block）和 tool 消息，进入下一轮；
- 最多 5 轮，单轮输出上限 2,000 tokens，单个工具结果截断 12,000 字符；
- 不创建 live Agent、不创建 session，因此不会从 `turn/end` 递归触发 scheduler。

这是官方 forked agent 的最小等价物：同样的“模型 + 少量工具 + 5 轮”形状，但复用当前进程，代价是模型档位/工具隔离不如官方完整。

### 2.2 `src/auto-extract.js` 改为直写

- 删除单次 JSON 抽取和 Inbox 暂存分支；
- 工具集合：`memory_read`、`memory_search`、`memory_save`、`memory_update`；
- 读取 `sessionQuery.readSession` 后，只保留 `seq > runtime.extractCursors.get(sessionId)` 的事件；
- 只把最近 `autoExtractMaxChars`（默认 12,000 字符）的转写给模型，附上当前索引头（4,000 字符）；
- `runToolLoop` 最多 5 轮；
- 每个 save/update 强制 `basis:'inference'`、`confidence:'low'`、`force:false`，并打上 `exec.internal:true`，避免抽取器自己的写入触发下一轮互斥；
- 最多写入 `autoExtractMaxItems`（默认 5）条，达到上限后工具返回 `limit-reached`，不会先写再报错；
- 只有成功写入才推进 cursor；没有写入时推进 cursor 并返回 `no-writes`，避免下一轮重复读同一段；
- 总超时 `autoExtractTimeoutMs`（默认 60 秒）。

`applyProposals` 保留，仅给 Inbox 里人工暂存的旧提案使用；自动抽取不再产生 Inbox 提案。

### 2.3 默认值与调度

- `autoExtract: true`（原来 false）
- `autoExtractEveryTurns: 1`（原来 3）
- `autoExtractMaxItems: 5`（原来 3）
- `autoExtractTimeoutMs: 60_000`（原来 30_000）
- `scheduler.js` 的 `turn/end` 逻辑不变：主线、非 delegated、本 turn 主 agent 没写记忆、按 `autoExtractEveryTurns` 节流；结果写入 `lastExtract*` state。

### 2.4 测试与文档

- 重写 `test/auto-extract-v20.test.mjs`：真实 tool-call 脚本、直写、互斥、节流、Inbox 人工 accept 保留；
- `test/config.test.mjs`、`test/status-v7.test.mjs` 更新默认值；
- 文档同步：`docs/ARCHITECTURE.md` §5.6 / 配置表、`docs/manual.zh.md`、`README.md`、`README.zh.md`、`docs/commands.md`、`CHANGELOG.md`。

## 3. 为什么这样做

- **直写而不是 Inbox**：官方 forked agent 的写入直接走 `memory_save`；Inbox 是插件的产品化安全层，但它让“自动抽取”和“人工确认”变成两条写路径。改为直写后只剩一条写入门，符合“一个功能一套逻辑”。
- **进程内循环而不是 forked Agent**：`llm.stream` 已经支持 `tools`，`dsh-agent-loop` 本身就是这个循环。创建 live Agent 会在 `turn/end` 里递归产生 session/事件，调度器会再次被触发；进程内循环没有这个问题，代价是不能像官方那样给 extractor 独立 session/工具权限。
- **per-session cursor 而不是文件 mtime**：DSH 的 `SessionHeader` 没有稳定 agent name，`sessionQuery` 是唯一稳定接口；event seq 比文件 mtime 更精确，也不会被 compaction/重写误判。mtime 最多做候选发现，不作为读边界。
- **保留 `memory_save` 门禁**：官方 extractor 写入也会走记忆系统；插件的重复/冲突/密钥/预算门禁是既有安全边界，直接绕过会引入新的双逻辑。

## 4. 没有改的部分（重要）

**Dream 仍是原来的 chunked analyzer pipeline，不是官方那种 agent。**

原因：Dream 现有 1,500 行 pipeline 包含 gather → analyzer → quote 校验 → check → merge → shadow → 人工 switch/undo，20+ 个测试依赖这个契约。把它替换成 `session_search`/`session_read` + `memory_read` 的 agent，需要同时重写验证、coverage、manifest、undo 和测试；半替换会出现“新 agent 写 shadow、旧校验不认”的双逻辑，比不改更危险。

因此本次只交付自动抽取，Dream 的 agent 化留作下一项独立改动。当前 Dream 仍然有：

- 每次 analyzer unit 重复带最多 12KB 记忆；
- 读取完整 session 后再分块（`readSession` 没有 range 参数）；
- 只能 append/replace，不能独立 prune 页面；
- shadow/undo 与人工 switch 是安全边界。

## 5. 验证

- `npm test`：602 tests / 601 pass / 1 pre-existing skip / 0 fail（约 11 秒）
- `node scripts/verify.mjs`：PASS（79 test files / 601 assertions；structure 2/2，syntax 1/1）
- `git diff --check`：仅既有 CRLF 提示，无空白错误

## 6. 生效方式

当前运行的 Host 已报告新默认值（`autoExtractEveryTurns:1`、`autoExtractMaxItems:5`），说明新源码已被加载。此前 live 测试留下的运行时 override 把 `autoExtract` 置成了 `false`；已通过 `POST /toggle` 改回 `true`。

最后一次 `src/tool-loop.js`/`src/auto-extract.js` 的收尾（消息 id、写入条数硬上限、60 秒超时）发生在 Host 加载之后，因此仍建议重启 DSH Host（或重载 profile）以加载最终版本。重启后：

- 自动抽取默认开启，每轮回写；
- `memory_save` 走当前源码的直写路径，不再 `.pending/writes` 排队；
- 旧的 `.pending/writes/1794611781977-c2tzrl.json` 已删除。

## 7. 下一步

1. Dream agent 化：`session_search`/`session_read`/`memory_read` 工具 + 一个 agent 产出 claims，保留下游引用校验、shadow、switch/undo；删除旧 chunk analyzer。
2. `sessionQuery` 若仍无 range read，至少按 `seq` 做 transcript cache，避免每轮重放整个 session。
3. 继续删剩余双路径：`injectionMode`/`injectHotOnly`/`compactionDigest`、`.history` 快照 vs inline history、`.trash`/`.dreams` GC、legacy `basis`/`dreamCostMode:'review'`。
