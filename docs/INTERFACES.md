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
| `src/dream.js`, `src/dream-pipeline.js`, `src/dream-run.js`, `src/dream-merge.js`, `src/dream-analyzer.js`, `src/dream-input.js` | dream-engine |
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
  dreamAnalyzerProvider: '',        // 空 => 用 agentDefaultModel.currentSelection()
  dreamAnalyzerModel: '',   // 与 dreamAnalyzerProvider 成对
  dreamAllowDelete: true,
  dreamInputMaxChars: 96000,
  tools: true,
  commands: true,
  ui: true,
  contextOrder: 850,
  maxContentBytes: 131072,  // 单条记忆正文上限
  dreamAnalyzerMaxTokens: 8192, // Dream 分析单元的初始输出预算
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
1. `memory_save {name, type, description, content, basis?, evidence?, force?}` → saveEntry；type 与落盘共用 `normalizeType`；超限 warning 放返回值；回执带 `version` 与 `verification`（`recorded`：首轮能显示简介；`pending`：字节已落盘、台账未更新）。
2. `memory_search {query, limit?, type?}` → `store.search(..., {currentOnly:true})`，只命中正文的当前部分；返回 `{ok,query,count,items}`。
3. `memory_read {file}` → 当前正文（`currentBody`）+ `status`；旧值通过文件视图或 `/memory history` 显式查看，不会作为当前内容返回。
4. `memory_update {file, content?, description?, name?, basis?, evidence?}` → updateEntry（改名走 renameEntry）；回执同样带 `version` 与 `verification`。
- `exec.agent` 用于 `runtime.forAgent`。
- 保存后调用 `runtime.invalidateInjection(exec.agent.id)`。

## `src/dream.js`（dream-engine）

```js
export class DreamEngine {
  constructor({ runtime })
  // pctx 由 runtime 提供（含 paths/store/state/workspaceDir）
  // 运行与续跑见 src/dream-pipeline.js；分析结果写进副本，不直接改记忆
  async pendingSwitch(pctx): Promise<null | { dir, createdAt, runId, summary, counts, files }>
  async switchShadow({ pctx, agent }): Promise<{ ok: true, backupDir, counts } | { ok: false, error: 'conflict'|'no-changes'|'no-project', conflicts?: {file,reason}[] }>
  async discardShadow({ pctx }): Promise<{ ok: boolean }>
  async undoLastDream({ pctx, agent }): Promise<{ ok: true, batch, restored, trashed, backupDir } | { ok: false, error: 'no-project'|'no-undoable-batch'|'conflict', conflicts? }>
}
```
职责：
- **副本**：Dream 只写 `.dreams/shadow/`（当前记忆的完整副本），与真实记忆逐文件比对得出 `added/changed/removed`；副本存在期间不再跑新的 Dream。
- **切换**：先把当前记忆目录整体备份到 `.dreams/<ts>/memory/`，再写回、把副本里没有的笔记移入回收站、把副本的 `MEMORY.md` 写到 live 后 `refreshIndex`（`MOVED TO` 退休桩会保留），写 `meta.json`（`kind:'dream-switch'`、`counts`、`files`、`rewritten`、`created`、`removed`、`hashes`、`verifiedFiles`、`backupDir`）与 changelog。运行期间有人改过笔记 → 整次返回 `conflict`，记忆不动。
- **撤销**：由 `listSwitches(paths)` 读取切换记录。只还原 `rewritten` 并把 `created` 移入回收站；若切换后被改过则整次返回 `conflict`。旧格式批次跳过。
- **验证**：切换时把可核验笔记写进字段级台账；首轮索引始终取自 `MEMORY.md` 原文。
- changelog 条目格式：
```
## 2026-11-06T23:10:00.000Z
- switch: 4 files (added 1, changed 3, removed 0), backup: .dreams/2026-11-06T23-10-00
- summary: ...
```
- 幂等：失败时写 `manifest.json`（`status:'failed'`）并释放锁；`resume` 只重跑未完成的单元。

## `src/dream-input.js`（dream-engine）

```js
export async function gatherDreamInput({ ctx, config, workspaceDir, state }): Promise<{
  sessions: { id, at, lastAt, chunks: {text, firstSeq, lastSeq}[], baseSeq, maxSeq, chars }[],
  droppedSessions: string[], deferredSessions: string[],
  chars: number, truncated: boolean, skippedSessions: string[], errors: string[]
}>
```
- 只读会话，不读记忆：topic 文件正文由 `dream-pipeline.js` 的 `memoryPagesOf(store)` 读一次全量（返回 `{ pages, errors }`），读失败进 `errors`；有 errors 时这一轮不算完整覆盖，不出副本。
- 会话来源：优先处理 `state.snapshot().sessionsSince` 中的会话，再从同一工作目录补充未处理的主线会话。
- 每个会话通过 `readSession(id)` 读取。按水位取新事件，保留来源与顺序，再分为分析单元。总输入超出 `dreamInputMaxChars` 时，当前会话记入 `deferredSessions`。
- 任何 session 读取失败跳过并记录。

## `src/dream-pipeline.js` / `dream-run.js` / `dream-merge.js`（dream-engine）

```js
export class DreamPipeline {
  async run({ pctx, agent, force, trigger, reason, signal, noSessions, focus, runId, resume, inputId, inputRanges })
  async start(options)          // 立即返回 { ok, started, runId, status:'running' }
  async status(pctx, runId)     // manifest 摘要；无记录 { status:'none' }；未知 { ok:false, error:'unknown-run' }
  async cancel(pctx, runId)
  async resume(pctx, runId, options)
  async settled(pctx, runId)    // 等待正在结束的运行，避免测试/退出竞态
  async estimate(pctx, { noSessions, focus })
}
export function mergeClaims({ analyses, memoryPages, indexText, title })
export function buildMemoryIndex(pages, title)
```
- 输入规划：`gatherDreamInput({ unboundedSessions: true, unitChars: 24000 })`，每个会话按事件边界分块，不因调用数或长度上限静默丢弃。
- 单元：`unitId = sha256(sessionId, firstSeq, lastSeq, text)`；`<dreamsDir>/<runId>/analysis/<session>/<unitId>.json` 按单元落盘；单次 max-tokens 截断时把该单元对半拆成两个单元重跑；`resume` 只补未完成单元。
- 锁：`<projectDir>/.consolidate-lock` 记录 `{pid, startedAt, runId}`，运行中按进度 `utimes` 续期，`resume` 可接管同一 runId 的过期锁。
- 合并：`mergeClaims` 只产出逐字保留的原有行、带引用（`^[session#locator, date]`）的新事实行和元数据/标题；唯一匹配的旧行被推翻时替换并把旧值写进 `## History`；对象/数量不一致、位置不唯一、低置信进 `plan.review`；页面里留着具体旧值时另写一行 `- CONFLICT: "<旧>" vs "<新>" — the sources disagree; a person has to pick one. ^[cite]`；`retire: [{file, target}]` 在目标存在且本轮未被改写时删页并留 `MOVED TO [[target]]` 索引桩；未提及的页面不动。索引为扁平列表（`- [名字](文件) — 说明`）。
- 运行状态：`<runId>/manifest.json` 记录 `status`（running/ready/failed/cancelled/skipped）、`stage`、输入会话与单元区间、模型、用量、最近错误。
- 收尾：合并 + 证据门 + 逐页核验 → 写入影子 store（`prepareShadow` / `applyShadowOperations`）→ `diffShadow` → `state.setShadowPending(...)` 并返回 `{ok:true, ran:true, ready:true, counts, files}`；无差异返回 `{ready:false, skipped:true, skipReason:'nothing-new'}`。

## `src/commands.js`（ui-commands）

```js
export function registerCommands(ctx, runtime): () => void
export function parseCommandLine(rawInput): { verb, args }   // 纯函数，便于测试
```
`/memory` 子命令：`json`、`list`、`show <file>`、`index`、`on`/`off`、`dream on|off`、`dream status [runId]`、`dream cancel|resume [runId]`、`dream run [--focus]`、`dream switch`、`dream discard`、`dream undo`、`delete <file>`。`/remember [--type=..] [--scope=..] <text>`。
- 返回 `{kind:'success', text}` 或 `{kind:'error', text}`；`json` 返回可被 `JSON.parse` 的文本。
- 开关状态持久化：`/memory on|off` 与 `/memory dream on|off` 需要写回插件配置。用 `ctx.fiber.entry` + `ctx.get('configEditor')` 按 host-plugin.md 的方法改行 config；若 editor/entry 不可用，返回 error 说明「cannot persist」。改完提示「takes effect after plugin reload」。
- `/memory dream run` 调用 `runtime.dream({agent, force:true, trigger:'manual', focus})`；`switch` 调 `runtime.switchDream({agent})`，`discard` 调 `runtime.discardDream({agent})`。JSON 输出用于 UI。

## `client.js`（ui-commands）

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

`MemoryRuntime` 直接使用 `DreamEngine` 与 `DreamPipeline`。后台启动统一经过 `startDream`。需要等待结果的调用方使用返回的 `done`。调度、执行和状态服务共用 `dreamReadiness`。
```js
async startDream(pctx, options)
async dream({ pctx, agent, force, trigger, reason, focus, inputId, inputRanges }): Promise<DreamRunResult>
async estimateDream(pctx, { focus }): Promise<{ estimatedTokens, limit, rough, inputId, ranges }>
async pendingSwitch(pctx): Promise<null | { dir, createdAt, runId, counts, files }>
async switchDream({ agent }): Promise<{ ok, backupDir?, counts?, error?, conflicts? }>
async discardDream({ agent }): Promise<{ ok, error? }>
async undoLastDream({ agent }): Promise<{ ok, batch?, restored?, trashed?, error?, conflicts? }>
```
`tools.js` 与 `commands.js` 只调用这些方法。
