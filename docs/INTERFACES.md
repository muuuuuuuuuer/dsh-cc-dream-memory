# dsh-cc-dream-memory 内部接口契约 v1（所有 teammate 必读）

## 硬约束

1. **Host 侧纯 ESM，只允许 Node 内置模块**（`node:fs/promises`、`node:path`、`node:crypto`、`node:os`）。**禁止** import 任何 `@deepseek-ai/*`、`zod`、`schemastery` 等裸包（本地 bundle 解析不到）。
2. **Client 侧**：`window.__ModuleLoader__.load({ id:'dsh-cc-dream-memory', factory(require){ ... } })` 形式；只能 `require('react')`；不写 DOM 到 body、不引其他 Harness client 包。
3. **不修改**别人的文件（见每个任务的 write scope）。不运行 `plugin_manager`（只有 Lead 安装）。
4. 所有异步函数要能容错：缺失服务（`ctx.get('x') === undefined`）时优雅降级，不抛到宿主。
5. 注释与文档用中文/英文均可；代码标识符英文。
6. 文件必须 UTF-8，无 BOM；行宽不强制。

## 目录与所有权

| 文件 | 负责人 |
|---|---|
| `package.json`, `cordis.patch.yml`, `index.js`, `src/config.js`, `src/paths.js`, `src/runtime.js`, `src/state.js`, `src/scheduler.js` | Lead |
| `src/frontmatter.js`, `src/store.js`, `src/inject.js`, `src/tools.js` | memory-core |
| `src/dream.js`, `src/dream-agent.js`, `src/dream-shadow.js`, `src/dream-run.js`, `src/tool-loop.js` | dream-engine |
| `src/commands.js`, `client.js`, `locale/*.json`, `icon.svg` | ui-commands |
| `test/*.test.mjs`, `scripts/*.mjs` | verifier |

## Config（`src/config.js`，Lead 提供）

`resolveConfig(raw)` 返回冻结对象：

```js
{
  enabled: true,            // auto memory 总开关
  memoryRoot: '',           // 空 => $DSH_HOME/cc-memory；支持 ~/ 前缀
  indexMaxLines: 200,
  indexMaxBytes: 25600,
  autoDreamEnabled: false,
  minHours: 24,
  minSessions: 5,
  scanThrottleMs: 600000,
  lockTtlMs: 3600000,
  dreamAnalyzerProvider: '',        // 与 dreamAnalyzerModel 成对；都填才指定模型
  dreamAnalyzerModel: '',
  dreamAllowDelete: true,
  dreamMaxTasks: 10,        // 子智能体 Dream：一次最多提供几个候选会话，其余留给下次
  wikiPageMaxChars: 8000,   // wiki 页面（Dream 专写）：单页字符上限
  wikiTotalMaxChars: 40000, // 所有 wiki 页面合计的字符预算
  dreamYieldToSubagents: false, // true: 用户子智能体在跑时先等待；开始后跑完不停
  autoExtract: true,        // 每 turn 直接写入；无 Inbox staging
  autoExtractSkipExternal: false, // true: 窗口里有 mcp__* / web_search / web_fetch 工具调用则跳过
  userMemory: 'global',     // 'global'|'project'：type user 笔记存 <memoryRoot>/user/memory，所有项目共享
  archiveHintDays: 60,      // 这么久没读没召回的笔记列为归档候选（只提示，不删除）
  tools: true,
  commands: true,
  ui: true,
  contextOrder: 850,
  maxContentBytes: 131072,  // 单条记忆正文上限
}
```

## `src/paths.js`（Lead）

```js
export function projectSlug(absPath): string      // '--C-Users-me-x--' 形式（复刻 ~/.dsh/sessions 命名）
export function resolveProjectRoot(workspaceDir): string  // 向上找 .git（最多 30 层），否则返回 workspaceDir
export function defaultMemoryRoot(homeDir): string        // <homeDir>/cc-memory
export function buildPaths({ memoryRoot, homeDir, workspaceDir }): Paths
// Paths = { root, projectRoot, projectDir, memoryDir, indexFile, stateFile, lockFile,
//           changelogFile, dreamsDir, pendingDir }
export function buildUserPaths({ memoryRoot, homeDir }): Paths   // <root>/user：用户层，memoryDir = <root>/user/memory
```
所有路径均为绝对路径；`memoryDir` 必须位于 `root` 内。

## `src/state.js`（Lead）

```js
export class ProjectState {
  constructor(paths)
  async load()                                  // 读 stateFile；缺失/损坏 => 默认值
  snapshot(): StateSnapshot
  ensureSession(sessionId, at = Date.now())     // sessionsSince 去重追加
  consumeSessions(count): string[]              // 取最近 count 个 id（不删除）
  clearSessions(ids)                            // dream 成功后移除已处理
  markDreamStart()                              // lastDreamAttemptAt
  markDreamDone({ sessions, ops, files, summary })
  markDreamFailed(reason)
}
// StateSnapshot = { lastDreamAt, lastDreamAttemptAt, lastScanAt, lastDreamSessions,
//                   lastDreamOps, lastDreamSummary, lastError, sessionsSince:[{id,at}],
//                   counters:{dreams, skipped} }
```

## `src/runtime.js`（Lead）

```js
export class MemoryRuntime {
  constructor(ctx, config)
  async forAgent(agent): Promise<ProjectContext>   // 解析 workspaceDir（ctx.workingDirectory.ensure(agent)），缓存
  async forSessionId(sessionId, cwdHint): Promise<ProjectContext | undefined>
  async storeFor(workspaceDir): Promise<{ paths, store, state }>
  invalidateInjection(sessionId)                   // 通知 inject.js：该 session 的记忆缓存失效
  onInvalidate(listener: (info: { sessionId, agent? }) => void): () => void
}
// ProjectContext = { agent?, sessionId?, workspaceDir, paths, store, state }
```
`ctx.workingDirectory.ensure(agent)` 返回 workspace 绝对路径；没有该服务时用 `ctx.get('workingDirectory') === undefined` 降级到 `process.cwd()`。

## `src/store.js`（memory-core）

```js
export class MemoryStore {
  constructor({ paths, config })
  get paths() / get config()

  async ensure()                                   // mkdir -p 记忆目录，初始化 MEMORY.md（''）

  async indexText(scope='project'): Promise<string>
  async injectedIndex(scope='project'): Promise<{
    text: string, lines: number, bytes: number, truncated: boolean, overflow: boolean,
    maxLines: number, maxBytes: number
  }>                                              // 前 indexMaxLines 行且前 indexMaxBytes 字节；超出时截断
  async listEntries(): Promise<EntryMeta[]>
  async readEntry(file): Promise<{
    file, frontmatter: {name,description,type,modified}, body: string, raw: string, bytes: number
  }>
  async saveEntry({ name, type='user', description='', content }): Promise<SaveResult>
  async updateEntry(file, { content, description }): Promise<SaveResult>
  async writeRawEntry(file, { type, name, description, body }): Promise<SaveResult>
  async writeIndex(text): Promise<IndexBudget>
  async deleteEntry(file): Promise<{ deleted: boolean, file: string }>
  async search(query, { limit=20 } = {}): Promise<SearchHit[]>
  async status(): Promise<StoreStatus>
  async writeChangelog(text): Promise<void>        // 追加到 .dream-log.md
  async listBackups(): Promise<{ name: string, at: number, files: number }[]>
}
// EntryMeta = { file, name, description, type, modified, bytes, lines }
// IndexBudget = { lines, bytes, maxLines, maxBytes, overflow, warning?: string }
// SaveResult = { ok:true, file, name, type, created:boolean, description, index: IndexBudget, warning?: string }
// SearchHit = { file, name, description, type, snippet }
// StoreStatus = { dir, indexFile, index: IndexBudget, entries: EntryMeta[] }
```
规则：
- 文件命名 `${type}_${slug(name)}.md`；slug = 小写、`[^a-z0-9]+`→`_`、去首尾 `_`，空则 `memory`。
- 索引行格式：`- [${name}](${file}) — ${description}`（description 单行、≤160 字符）。
- frontmatter 字段顺序：`name, description, type, modified`；解析/序列化必须稳定。
- 路径安全：file 只允许 `^[A-Za-z0-9._-]+\.md$`，不得含 `/`、`\`、`..`；resolve 后必须 `memoryDir` 内，否则抛 `code='PATH_ESCAPE'`。
- 写后自动重建索引：若索引缺该条目则追加；更新时替换对应行；删除时移除行。
- 索引超预算：写入仍成功，`warning` 说明「index is over budget (N lines/M bytes), merge or move details into topic files and rewrite index」。
- 错误对象带 `code`：`INVALID_NAME`, `INVALID_TYPE`, `INVALID_SCOPE`, `NOT_FOUND`, `PATH_ESCAPE`, `CONTENT_TOO_LARGE`。
- 所有文件操作原子写（临时文件 + rename），不跟随符号链接。
- 不做网络/LLM 调用。
- 只有一个作用域（项目级，对齐 Claude Code 每个项目一份记忆）：所有方法仍保留 `scope` 形参作为唯一校验点，`normalizeScope()` 只接受 `'project'`/空，传 `'user'` 抛 `code='INVALID_SCOPE'`。

## `src/inject.js`（memory-core）

```js
export function registerInjection(ctx, runtime): () => void
```
- 对当前存活 agent（`ctx.agents?.list?.() ?? []`）与 `agent/created` 事件注册。
- **缓存由本模块拥有**：`Map<sessionId, string>`；注册前 await `runtime.forAgent(agent)` 构建首版文本；`agent.ctx.systemPrompt.context({ name:'cc-memory', order: config.contextOrder, required:false, text: () => cache.get(agent.id) ?? '' })`；disposer 同时归 plugin effect 与 agent 生命周期（用 `ctx.effect` + Map 记录）。
- 失效刷新：配置、规则、会话压缩或手动刷新时重建对应会话快照。注入函数同步读取快照。
- 注：`agent/created` 是 serial 事件，可 await；构建失败时缓存空串并记录 console.warn，不要抛出。
- 注入文本模板（英文为主，稳定、可缓存）：

```
<system-reminder>
Auto memory is enabled for this project (managed by the dsh-cc-dream-memory plugin).

MEMORY.md is an index of durable notes written by you in earlier sessions. Topic files load only when you read them.
Save with memory_save (new note) or memory_update (existing note); search with memory_search; read with memory_read. Skip anything the repository already records.

<instructions>…</instructions>    // MEMORY_INSTRUCTIONS
<rules>…</rules>                  // 仅当用户写了 memory-rules.md

<index>
...MEMORY.md 原文（头部 maxLines/maxBytes）...
</index>
<budget-notice>…</budget-notice>   // 仅超限或接近预算时
</system-reminder>
```
（中文用户也接受中文模板；二选一，保持稳定。）

索引对齐 Claude Code：`<index>` 里是 `MEMORY.md` **原文**（手工行、损坏行都原样进上下文），插件不再按台账重渲染条目行，也不再藏起未核验笔记的简介。

## `src/tools.js`（memory-core）

```js
export function registerTools(ctx, runtime): () => void
```
用 `ctx.tools.register(definition)`（在插件 ctx 上，全局可用；`ctx.inject(['tools'], ...)` 由 index.js 的 `inject` 声明保证）。
每个 definition：
```js
{
  name, description,           // 英文 description，简洁说明何时用
  parameters: { type:'object', properties:{...}, required:[...], additionalProperties:false },
  output: { schema: {type:'object',...}, render(args, value){ return [{type:'text', text: typeof value==='string'?value:JSON.stringify(value,null,2)}] } },
  async execute(args, exec) { ... return JsonValue }
}
```
工具集（v11 起固定四个；`memory_list`/`memory_delete`/`memory_dream`/`memory_status` 已移除，由 `/memory …` 命令承担）：
1. `memory_save {name, type, description, content, sources?, citations?}` → saveEntry；`citations: [{quote, seq?}]` 由宿主核验（引文存在于本会话的非注入事件，回执 `citations: [{seq, role}]`；不成立的写入 `citationProblems`，写入照常进行）；含 `user` 角色的已核验引文时写 `STATUS: current` 并记台账；重复/同主题反义只在回执里以 `advisory`/`candidates`/`conflicts` 报告，不停写；旧的 `basis`/`evidence`/`confidence`/`force` 参数被忽略；type 与落盘共用 `normalizeType`；超限 warning 放返回值；回执带 `version` 与 `verification`（`recorded`：台账已记；`pending`：字节已落盘、台账未更新；`not-applicable`：没有已核验的用户引文）。
2. `memory_search {query, limit?, type?}` → `store.search(..., {currentOnly:true})`，只命中正文的当前部分；返回 `{ok,query,count,items}`。
3. `memory_read {file}` → 当前正文（`currentBody`）+ `status`；旧值通过文件视图或 `/memory history` 显式查看，不会作为当前内容返回。
0. wiki 页面只读：`memory_save` 的 type 为 `wiki`、`memory_update`（含 delete 与改名）作用于 `wiki_*` 页面，都返回 `WIKI_READONLY`；`memory_read`/`memory_search`/召回可读。`memory_save`/`memory_update` 的正文若会使页面第一条 `STATUS:` 变为 `stale/superseded/disputed/review-needed/retired`，返回 `STATUS_HIDES_PAGE`（没有覆盖参数；退役用 `delete`）。
4. `memory_update {file, content?, old_text?, description?, name?, sources?, expectedHash?, delete?, citations?}` → updateEntry（改名走 renameEntry）；`old_text` 加 `content` 只替换正文里唯一的那一段（找不到 `OLD_TEXT_NOT_FOUND`、多处 `OLD_TEXT_AMBIGUOUS`），被替换的旧段落留在 `## History`（与 Dream 的 `edit` 共用 `replacePassage`）；回执同样带 `version` 与 `verification`。
- `exec.agent` 用于 `runtime.forAgent`。
- 保存后调用 `runtime.invalidateInjection(exec.agent.id)`。

## `src/dream.js`（dream-engine）

```js
export class DreamEngine {
  constructor({ runtime })
  // pctx 由 runtime 提供（含 paths/store/state/workspaceDir）
  // 模型运行与运行状态见 src/dream-agent.js；这里只管副本的人工收尾
  async pendingSwitch(pctx): Promise<null | { dir, createdAt, runId, summary, counts, files, base, links }>
  async switchShadow({ pctx, agent, reject = [], defer = [], confirm = [], runId = '' }):
    Promise<{ ok: true, backupDir, outputDir, counts, rejected, deferred, confirmedWithoutSource }
           | { ok: true, discarded: true, decision: 'deferred', rejected, deferred }
           | { ok: false, error: 'no-project'|'no-pending'|'stale-dream'|'evidence-required'|'conflict', conflicts?, files? }>
  async discardShadow({ pctx, runId = '' }): Promise<{ ok: boolean, error?: 'no-project'|'no-pending'|'stale-dream' }>
  async undoLastDream({ pctx, agent }):
    Promise<{ ok: true, batch, restored, trashed, backupDir }
           | { ok: false, error: 'no-project'|'no-undoable-batch'|'conflict'|'undo-partial', conflicts?, partial?, restored?, trashed?, failed?, backupDir? }>
}
export async function listSwitches(paths)
```
职责：
- **不含计划校验**：`validateDreamPlan` / `executePlan` 已随旧引擎删除；页面级改动由 `diffShadow` 给出，切换按 `pending.base` 求差。无证据的通过项须列在 `confirm` 里，否则整次返回 `evidence-required`。
- **副本**：Dream 只写 `.dreams/shadow/`（当前记忆的完整副本），与真实记忆逐文件比对得出 `added/changed/removed`；副本存在期间不再跑新的 Dream。
- **切换**：先把当前记忆目录整体备份到 `.dreams/<ts>/memory/`，再写回、把副本里没有的笔记移入回收站、把副本的 `MEMORY.md` 写到 live 后 `refreshIndex`（`MOVED TO` 退休桩会保留），写 `meta.json`（`kind:'dream-switch'`、`counts`、`files`、`rewritten`、`created`、`removed`、`hashes`、`backupDir`）与 changelog。运行期间有人改过笔记 → 整次返回 `conflict`，记忆不动。
- **撤销**：由 `listSwitches(paths)` 读取切换记录。只还原 `rewritten` 并把 `created` 移入回收站；若切换后被改过则整次返回 `conflict`。旧格式批次跳过。
- **验证**：切换时把可核验笔记写进字段级台账；首轮索引始终取自 `MEMORY.md` 原文。
- changelog 条目格式：
```
## 2026-11-06T23:10:00.000Z
- switch: 4 files (added 1, changed 3, removed 0), backup: .dreams/2026-11-06T23-10-00
- summary: ...
```
- 幂等：失败时写 `manifest.json`（`status:'failed'`）并释放锁；没有续跑，失败或取消后用 `start` 重新运行。

## `src/dream-agent.js` / `src/dream-run.js` / `src/dream-shadow.js`（dream-engine）

```js
export class DreamAgent {
  async start({ pctx, agent, force, trigger, reason, signal, noSessions, focus, runId })
  async status(pctx, runId)     // 读 manifest：running/ready/failed/cancelled/skipped/unknown
  async cancel(pctx, runId)
  async estimate({ pctx, noSessions })
}
```

- 唯一路径：`runtime.dream()` 始终委托 `DreamAgent`；旧 `DreamPipeline`/`dream-input/analyzer/merge/verifier` 已删除。
- 执行：每轮启动一个子智能体。父级是当前项目的在线对话。插件在 `agent/created` 时挂载该子会话专用的 Dream 工具并限制继承工具。prompt 给出目的说明、当前索引与笔记清单、可疑笔记清单（被纠正、召回中被标“不相关”、来源失效、久未读取）和候选会话（id、日期、事件数、字数与失败的工具结果数，加标题；没有标题时用首条用户消息预览），候选总数不超过 `dreamMaxTasks`，其中可疑笔记 `source_session` 指向的已整理会话最多占一半，只用于查证。支持 `dreamYieldToSubagents` 等待用户子智能体结束后再启动。
- 整段只有可识别的问候、致谢，或者仅含命令、工具事件且没有对话文本时，普通 Dream 在本地结算。全部入选会话都符合条件时，省去影子副本和模型调用。后续有新发言时从原进度继续。显式 `--memory-only` 仍可整理已有笔记。
- `dream_read_session({session_id, from_seq?, limit?})` 返回候选会话的转写：用户消息（`[user]` 或 `[user-pasted]`）、助手消息、每次工具调用（`[tool-call] 名称 参数`，参数截断）和工具结果（`[tool-result]`，失败时 `[tool-error]`；保留头尾，`[stderr]`、`[exit code: N]` 等尾部标记不丢），每块带事件 `seq`，宿主注入内容已过滤，凭据已替换。不传 `from_seq` 时从第一条未整理的事件开始（仅供查证的会话从头开始）。回复头部含 `next_from_seq`，非 null 时继续读。只有候选集合内的会话可读。
- 宿主能搜索（`ctx.sessionQuery` 有 `searchSessions`、`searchEvents`、`readEvent`）时再提供三个工具，搜索范围是本项目允许的会话（同一项目含 worktree 与子目录，排除 `learn off`、git 忽略目录、委托会话与 Dream 子会话；宿主注入的事件不出现；片段含凭据则替换），否则不挂载，prompt 说明搜索不可用。`dream_search_sessions({query, since?, until?})` 按创建时间过滤并返回最多 10 个会话的最佳命中（`session_id`、`date`、`title?`、`offered`、`seq`、`type`、`snippet`）；`dream_search_events({session_id, query})` 返回该会话最多 20 个命中；`dream_read_event({session_id, seq, before?, after?})` 返回该事件及前后各最多 20 个事件（默认 2 与 4），渲染方式与 `dream_read_session` 相同。读过的事件可被引用，但不计入“已整理”；已整理只看候选会话。
- 有具体候选事实时，用 `dream_list_notes(query)` 在笔记文件名、标题和简介中检索。每次返回最多 12 条元数据和 `next_offset`。收到 `empty_catalog: true` 时可直接结束查找，非空目录查无匹配时可设置 `include_body` 查正文，或省略查询浏览目录。知道文件名时可直接调用 `dream_read_note` 核对原文。
- 自动维护可在待复查对话不足 `minSessions` 时单独运行。宿主提供纠正笔记和失效来源的定位信息。笔记原文按连续分页实际交付后，宿主才记录该版本已读。完成的未改动目标按笔记和来源版本去重，同批有其他提案时也可保存这一结果。
- Wiki 页面（`src/wiki.js`）：Dream 用同样的 `dream_submit` 操作写 `wiki_<slug>.md`（`type` 由文件名决定，新页面必须有 `description`），引用规则与笔记相同；正文用 `[[文件名]]` 链接页面与笔记。宿主在一次提交应用前检查：新页面文本中的每个链接在整批应用后都能解析，被删除的文件不能还被页面链接，否则整批退回并列出（`ERROR: no change in this call was applied.`）；写入时检查单页 `wikiPageMaxChars` 与总预算 `wikiTotalMaxChars`。每次 `dream_submit` 的回复末尾带 `Wiki: N page(s), X of Y chars used; one page holds at most Z chars.`。改动可带 `retire: true`：页面的第一条 `STATUS:` 若会让当前页面变成 `stale/superseded/disputed/review-needed/retired`，没有 `retire: true` 就被拒（对笔记和页面都适用；退役请用带 `moved_to`/`merges` 的 delete，旧值放 `## History`）。待审记录 `shadowPending.wiki` 为 `{pages:[前,后], chars:[前,后]}`。
- `dream_submit({changes, skipped_sessions?, done})` 提交改动，可多次调用，`done: true` 结束本轮。改动沿用 `write`/`add`/`edit`/`delete`、`merges`/`moved_to`、`version`/`old_text` 语义，另可带 `sources`（仓库相对路径或 路径#符号，最多 10 个，经 `normalizeSources` 校验，省略则保留原值）和既有写入检查（凭据扫描、路径与名称、版本、影子副本、检查点）。每个改动至少一条引用：`{session_id, seq, quote}` 或 `{memory_file, quote}`。宿主只核对存在与角色：会话必须在候选集合内（或是本轮用 `dream_read_event` 读过其事件的本项目其他允许会话），该 `seq` 的事件存在且不是宿主注入，`quote`（忽略大小写、空白与标点）是事件文本的子串，并记录事件角色（`user`、`user-pasted`、`assistant`、`tool-call`、`tool-result`；`memory_*` 工具的调用与结果不可引用）；笔记引用要求 `quote` 在该笔记当前正文（不含 History）里，笔记可以是 live 或本轮已在副本里创建。同一次提交里任何改动没有有效引用，整次提交都不应用，回复列出原因，模型可在同一轮修正后重交。宿主不比对陈述与引用的语义。`skipped_sessions` 声明已筛过、没有可复用内容的候选会话。
- Dream 按已选范围完成任务，记录用量和耗时。模型调用采用供应商的请求限制。锁为 `<projectDir>/.consolidate-lock`，已有待切换副本时暂停新运行。
- 收尾：`diffShadow({base})` 只算 agent 相对快照的改动（运行期间或之后 live 新建的笔记不算删除）；`shadowConflicts` 只对 agent 改过的页面生效 → `state.setShadowPending`；无差异返回 `{skipped:true, skipReason:'nothing-new'}`；人工 `switch`/`discard`/`undo` 仍由 `dream-shadow.js`/`dream.js` 执行，`switch` 同样按 `pending.base` 求差。
- 副本隔离：shadow 的回收站在 `.dreams/shadow/.trash`，shadow 写入不记 live `.history`。
- 会话读到末尾（`dream_read_session` 的回复已完整交付，且从第一条未整理事件起连续）或列入 `skipped_sessions` 才算本轮已整理，并随检查点保存；其余会话保持待整理。有未解决的写入失败时，它所引用的会话不结算。会话增长超过标记后可重新入选。`runtime.dreamCoverage(pctx)` / 状态里的 `dreamTasks` 列出本工作区每个对话的状态：`done`/`new`/`review`/`partial`/`todo`/`excluded`。
- 否决：`pending.proposals` 为每个改动文件一行可读描述；`discard`/部分否决写入 `dreamRejected`，下次 Dream 的 prompt 列出最近 20 条，要求无新证据不得再提。
- 运行状态：`<runId>/manifest.json` 记录 `status`（running/ready/failed/cancelled/skipped）、`stage`、模型、用量、最近错误。
- 证据：核对结果只做标记，不阻止切换；证据随 pending 交给人工，UI/`dreamDiff` 展示 `session #seq — quote` 和 `verified`。每页判定记作 `citation`、`preserved`、`description` 或 `missing`：事实不变而只改 `description` 记作 `description`，与 `preserved` 一样无需引文。

## `src/commands.js`（ui-commands）

```js
export function registerCommands(ctx, runtime): () => void
export function parseCommandLine(rawInput): { verb, args }   // 纯函数，便于测试
export function parseRememberInput(rawInput): { type, text, force? }
```
`/memory` 收拢为五个高频子命令：`status`（默认）、`search <query>`、`dream <status|run|estimate|resume|cancel|diff|switch|discard>`、`undo`、`session [status|use on|off|learn on|off]`，外加 `/remember [--type=..] [--force] <text>`。
- 返回 `{kind:'success', text}` 或 `{kind:'error', text}`。
- `/memory dream run` 调用 `runtime.dream` / `startDream`；`switch` 调 `switchDream`；`discard` 调 `discardDream`；`/memory undo` 调 `undoLastDream`。

## `client.js`（由 `web/*.js` + `locale/*.json` 经 `npm run build` 打包）

- 结构：
```js
window.__ModuleLoader__.load({
  id: 'dsh-cc-dream-memory',
  factory(require) {
    const React = require('react');
    // ... components, styles as React elements
    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) { ... }
    };
  },
});
```
- `apply` 内：`const t = ctx.locale.bind('dsh-cc-dream-memory')`，注册 locale 字典（若 bind 前需 register：沿用 `ctx.locale.register('dsh-cc-dream-memory', 'en', {...})` / `'zh'`，注意 find 实际可用签名；不可用时直接内联中英文按 `ctx.locale.getLocale()` 选择）。
- 注册：
  - `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name:'conversation.view', id:'cc-memory', order:40, label: () => t('view.title') }, MemoryView))`
- `MemoryView(props)`：props 含 `sessionId`（`SessionId`）；用 `execute(sessionId, line)` 封装：
```js
async function exec(line) {
  const r = await ctx.remote.commands.execute(sessionId, line, []);
  if (!r.ok) throw new Error(r.error?.message ?? 'command failed');
  if (r.value === undefined) throw new Error('unknown command');
  if (r.value.result.kind !== 'success') throw new Error(r.value.result.text || 'command failed');
  return r.value.result.text ?? '';
}
```
（实际 RemoteResult 包装可能不同：`{ok:true,value:{result:{kind,text}}}`；写防御性解包，兼容 `value.result` 或 `value`。）
- UI 组成（保持简单、主题化，用 `--dsw-alias-*` CSS 变量或继承宿主样式）：
  1. 头部：标题 + 记忆目录 + 刷新按钮；
  2. 开关行：Auto memory（on/off）、Auto dream（on/off）、Dream 模式（apply/review）——调用 `/memory on|off`、`/memory dream on|off`；
  3. 索引卡片：`MEMORY.md` 行数/字节预算进度 + 文本；
  4. 文件列表：点击加载 → 显示/编辑（textarea）→ 保存（`/memory json` 不含正文，需用 existing command `/memory show <file>` 拿原文；保存用 `/memory` 的 JSON 无法传内容——因此 client 写文件时用 `ctx.remote.commands.execute` 调 `/memory save-file <file> <base64>`？）
  
  **简化**：UI 只读浏览 + 开关 + 手动 dream/dry-run + 历史日志；编辑通过 `/memory show <file>` 只读展示，并提供「复制到输入框」提示。若时间允许再加编辑（新增命令 `/memory write <file>` 走 `extraInput` 传文本，但 command 输入长度有限，故不做）。在交付说明中注明「编辑请在聊天中使用 memory_update 工具或 /memory 命令」。
  5. Dream 卡片：状态（lastDreamAt/error/是否有待切换副本）、按钮「Estimate the run」「Start the dream run」、副本就绪后的「Switch to it」「Discard」、`.dream-log.md` 最近 20 行。
- 每次操作后重新拉 `/memory json`。
- 不调用未挂载的 Remote；只用 `remote.commands`。
- 组件不得抛错导致 slot 空白：所有 async 包 try/catch，错误显示为文本。

## 测试与验证（verifier）

- `node --test test/`（Node 24 内置 test runner），测试文件 `test/*.test.mjs`。
- 最低覆盖：
  1. `frontmatter` 解析/序列化往返；
  2. `store`：save→list→read→update→delete、索引行重建、超预算 warning、路径逃逸拒绝、scope 禁用；
  3. `config`：默认值、clamp、非法类型回退；
  4. `dream` 计划校验：合法计划、非法路径、删除禁用、op 超限、JSON 提取（代码块/裸对象）；
  5. `commands`：`parseCommandLine` 语法；
  6. `paths`：slug、git root 探测、路径包含关系。
- `scripts/verify.mjs`：一次性跑上述断言并打印 PASS/FAIL 摘要，exit code 非 0 表示失败；也可 `node --check` 所有 JS。
- 测试用临时目录（`node:os` tmpdir），不碰真实 `~/.dsh`。
- 完成后运行并把真实输出贴进任务完成说明。

## Lead 在 runtime 上提供的 dream 入口

`MemoryRuntime` 直接使用 `DreamAgent`（运行）与 `DreamEngine`（人工 switch/discard/undo）。后台启动统一经过 `startDream`。需要等待结果的调用方使用返回的 `done`。调度、执行和状态服务共用 `dreamReadiness`。
```js
async startDream(pctx, options)
async dream({ pctx, agent, trigger, reason, focus, noSessions, runId, resume }): Promise<DreamRunResult>
async estimateDream(pctx, { noSessions }): Promise<{ estimatedTokens, limit, rough, costMode }>
async pendingSwitch(pctx): Promise<null | { dir, createdAt, runId, counts, files }>
async switchDream({ agent }): Promise<{ ok, backupDir?, counts?, error?, conflicts? }>
async discardDream({ agent }): Promise<{ ok, error? }>
async undoLastDream({ agent }): Promise<{ ok, batch?, restored?, trashed?, error?, conflicts? }>
```
`tools.js` 与 `commands.js` 只调用这些方法。
