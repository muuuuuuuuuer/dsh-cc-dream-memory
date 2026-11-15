# Dream 变成 agent：自己搜会话、按需读记忆

日期：2026-11-15
范围：`DreamAgent` 成为唯一 Dream 路径；保留人工 `switch` / `discard` / `undo`。
不在范围：官方 team memory、CLAUDE.md 层级。

## 1. 目标

用户要求：

> Dream 变成 agent（自己搜会话、读记忆）人工 switch/undo 还是要留；记忆按需读、不整包推。

对应 Claude Code 官方的 Dream 形态：给模型 session 路径/ID，模型自己 grep / 定点读取；记忆只给索引，正文由模型按需读；最后写回。

## 2. 改了什么

### 2.1 新增 `src/dream-agent.js`

一次 Dream = 一次进程内工具循环，不再由宿主切 transcript、拼 analyzer 单元。

- 候选会话：`sessionQuery.filterSessions([{kind:'cwd', values:[workspaceDir]}])`，跳过 subagent，跳过已完整处理的会话，按创建时间从旧到新，最多 `sessionLookback` 个。
- 初始 prompt 只有：
  - `MEMORY.md` 头部（8 KB）；
  - 候选 session 的 id / 创建时间；
  - focus（可选）。
  - **不包含任何记忆正文，也不包含 transcript。**
- 工具（全部经 `runToolLoop` 暴露给模型）：
  - `memory_index`：索引 + 每条笔记的元数据（name/type/description），不含正文；
  - `memory_read(file)`：读 shadow 里的一页正文；
  - `memory_search(query)`：只返回短 snippet + 文件名；
  - `memory_write` / `memory_delete`：只写 shadow；
  - `session_list`：候选会话；
  - `session_search(session_id, query)`：`sessionQuery.searchEvents`，窄查询；
  - `session_read(session_id, seq, before, after)`：`sessionQuery.readEvent`，固定小窗口。
- 工具结果统一截断 12,000 字符；每次 session 读取记录已读到的最大 seq。
- 最多 14 轮，每轮输出 2,000 tokens；不创建 live Agent、不创建 session，因此不会从 `turn/end` 递归触发 scheduler。

### 2.2 写 shadow，不写 live

- 开始时 `prepareShadow` 复制当前记忆到 `.dreams/shadow`。
- 结束时 `diffShadow` 对比；无变化 → 清 shadow，`nothing-new`。
- 有变化 → `state.setShadowPending`，与旧路径相同的 `.dreams/shadow` + `meta.json` 契约。
- 人工 `switch` 时才备份 live 并写回；`undo` 仍由 `switchShadow` 写入的批次元数据恢复。
- 运行期间 live 页面被改 → `shadowConflicts` 返回 conflict，拒绝切换（与旧路径一致）。

### 2.3 接线

- `src/runtime.js` 始终 `new DreamAgent(...)`；旧 `DreamPipeline` 与 `dreamAgent` 开关已删除。
- `src/dream-agent.js` 的 `start`/`cancel`/`status`/`resume`/`estimate` 保持现有 Dream 服务接口；`estimate` 只做粗估（索引 + 候选数），不再有旧 pipeline 的 pin/range 细节。
- `test/dream-agent-v25.test.mjs`：
  1. agent 搜会话、按需读记忆、只写 shadow；首个 prompt 不含正文；switch 后 live 生效；undo 恢复。
  2. 无变化 → 无 shadow，返回 `nothing-new`。
  3. 写入带 citation 时，pending/`dreamDiff` 返回 session/seq/quote 证据。

### 2.4 与官方一致 / 有意保留

一致：

- 模型自己决定读哪些 session、读哪一页；
- 记忆正文不整包推送；
- 结果先落副本，不是模型直接改 live。

有意保留（不是官方原样）：

- 人工 `switch` / `discard` / `undo`：官方 Dream 可直接落盘；本插件保留人工确认，避免模型误改用户记忆。
- 初始 prompt 仍带 `MEMORY.md` 头部和候选 session id：官方是给路径/ID 让模型自己查；DSH 的 `sessionQuery` 不暴露文件路径，给 id 是等价且更稳定的边界。

## 3. 为什么这样做

- **不再由宿主切块**：旧路径把 transcript 切块后每块重复带最多 12 KB 记忆，成本随单元数线性增长；agent 只在需要时读一页。
- **不创建 live Agent**：`llm.stream` 本身支持 tools；`dsh-agent-loop` 就是这个循环。创建 live Agent 会在 `turn/end` 里产生新 session/事件，scheduler 会再次被触发；进程内循环避免递归。
- **保留 shadow + 人工 switch**：这是对“模型写记忆”的唯一可靠闸门；官方直接写，插件选择更安全的产品形态。
- **保留 per-session seq**：DSH 没有稳定的 agent name，`sessionQuery` 是唯一稳定接口；event seq 比文件 mtime 精确，也不会被 compaction 误判。

## 4. 验证

- `npm test`：**477 tests / 476 pass / 1 pre-existing skip / 0 fail**。
- `node scripts/verify.mjs`：**PASS**（64 test files / 476 assertions）。
- `node --check src/dream-agent.js` 通过。
- 未做真实 Host 的 Dream agent 运行：当前 Host 仍加载改动前的模块，需要重启/重载 profile 才会用 `DreamAgent`。

## 5. 已知缺口（下一步）

1. **`resume` 语义**：当前只是以同一 runId 重新开始，没有单元级续跑；UI 的 “Continue” 需要后续对齐或移除。
2. **引用证据**：已记录并展示 session/seq/quote 给人工审阅，但不做自动 quote gate（这是有意选择）；`memory_delete` 可删除任意 shadow 页，仍靠人工 switch。
3. **成本/续跑/估算**：`dreamMaxTotalTokens` 未强制；`estimate` 是粗估。
4. **锁竞争**：Dream 使用 `waitMs:2000, strict`；竞争者会收到 `LOCK_BUSY`。
5. **文档**：`docs/ARCHITECTURE.md` 的 6.2/6.3 已标为历史；其余历史报告不再更新。

## 6. 生效

需要重启 DSH Host / 重载 desktop profile，让 `src/dream-agent.js` 被加载。之后：

- `/memory dream run` 或 Dream 页 Start → agent 自己搜会话、读记忆；
- 结果仍是副本 → 人工 switch / discard；
- switch 后 `/memory dream undo` 仍可用。
