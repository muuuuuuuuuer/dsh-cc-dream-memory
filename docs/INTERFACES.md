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
| `src/dream.js`, `src/dream-prompt.js`, `src/dream-input.js` | dream-engine |
| `src/commands.js`, `client.js`, `locale/*.json`, `icon.svg` | ui-commands |
| `test/*.test.mjs`, `scripts/*.mjs` | verifier |

## Config（`src/config.js`，Lead 提供）

`resolveConfig(raw)` 返回冻结对象：

```js
{
  enabled: true,            // auto memory 总开关
  memoryRoot: '',           // 空 => $DSH_HOME/cc-memory；支持 ~/ 前缀
  userMemoryEnabled: false, // 是否启用 user scope（跨项目）
  injectIndex: true,
  indexMaxLines: 200,
  indexMaxBytes: 25600,
  autoDreamEnabled: false,
  minHours: 24,
  minSessions: 5,
  scanThrottleMs: 600000,
  lockTtlMs: 3600000,
  dreamMode: 'apply',       // 'apply' | 'review'
  dreamProvider: '',        // 空 => 用 agentDefaultModel.currentSelection()
  dreamModel: '',           // 与 dreamProvider 成对
  dreamAllowDelete: false,
  dreamMaxOps: 40,
  dreamInputMaxChars: 60000,
  sessionLookback: 8,
  tools: true,
  commands: true,
  ui: true,
  contextOrder: 850,
  maxContentBytes: 131072,  // 单条记忆正文上限
  llmMaxTokens: 16384,      // dream 输出预算；max-tokens 截断时双倍重试一次
}
```

## `src/paths.js`（Lead）

```js
export function projectSlug(absPath): string      // '--C-Users-me-x--' 形式（复刻 ~/.dsh/sessions 命名）
export function resolveProjectRoot(workspaceDir): string  // 向上找 .git（最多 30 层），否则返回 workspaceDir
export function defaultMemoryRoot(homeDir): string        // <homeDir>/cc-memory
export function buildPaths({ memoryRoot, homeDir, workspaceDir }): Paths
// Paths = { root, projectRoot, projectDir, memoryDir, indexFile, stateFile, lockFile,
//           changelogFile, dreamsDir, pendingDir, userMemoryDir, userIndexFile }
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
  async listEntries(scope='project'): Promise<EntryMeta[]>
  async readEntry(file, scope='project'): Promise<{
    file, scope, frontmatter: {name,description,type,modified}, body: string, raw: string, bytes: number
  }>
  async saveEntry({ scope='project', name, type='user', description='', content }): Promise<SaveResult>
  async updateEntry(file, { scope='project', content, description }): Promise<SaveResult>
  async writeRawEntry(file, { scope='project', type, name, description, body }): Promise<SaveResult>
  async writeIndex(text, scope='project'): Promise<IndexBudget>
  async deleteEntry(file, scope='project'): Promise<{ deleted: boolean, file: string }>
  async search(query, { scope='project', limit=20 } = {}): Promise<SearchHit[]>
  async status(scope='project'): Promise<StoreStatus>
  async writeChangelog(text): Promise<void>        // 追加到 .dream-log.md
  async listBackups(): Promise<{ name: string, at: number, files: number }[]>
}
// EntryMeta = { file, name, description, type, modified, bytes, lines }
// IndexBudget = { lines, bytes, maxLines, maxBytes, overflow, warning?: string }
// SaveResult = { ok:true, file, name, type, created:boolean, description, index: IndexBudget, warning?: string }
// SearchHit = { file, name, description, type, snippet }
// StoreStatus = { dir, indexFile, index: IndexBudget, entries: EntryMeta[], userScope: {enabled, dir, entries} }
```
规则：
- 文件命名 `${type}_${slug(name)}.md`；slug = 小写、`[^a-z0-9]+`→`_`、去首尾 `_`，空则 `memory`。
- 索引行格式：`- [${name}](${file}) — ${description}`（description 单行、≤160 字符）。
- frontmatter 字段顺序：`name, description, type, modified`；解析/序列化必须稳定。
- 路径安全：file 只允许 `^[A-Za-z0-9._-]+\.md$`，不得含 `/`、`\`、`..`；resolve 后必须 `memoryDir` 内，否则抛 `code='PATH_ESCAPE'`。
- 写后自动重建索引：若索引缺该条目则追加；更新时替换对应行；删除时移除行。
- 索引超预算：写入仍成功，`warning` 说明「index is over budget (N lines/M bytes), merge or move details into topic files and rewrite index」。
- 错误对象带 `code`：`INVALID_NAME`, `INVALID_TYPE`, `NOT_FOUND`, `PATH_ESCAPE`, `SCOPE_DISABLED`, `CONTENT_TOO_LARGE`。
- 所有文件操作原子写（临时文件 + rename），不跟随符号链接。
- 不做网络/LLM 调用。
- 需要支持 `scope='user'`：仅当 `config.userMemoryEnabled`；否则 saveEntry 抛 `SCOPE_DISABLED`，list/read 返回空/抛 NOT_FOUND。

## `src/inject.js`（memory-core）

```js
export function registerInjection(ctx, runtime): () => void
```
- 对当前存活 agent（`ctx.agents?.list?.() ?? []`）与 `agent/created` 事件注册。
- **缓存由本模块拥有**：`Map<sessionId, string>`；注册前 await `runtime.forAgent(agent)` 构建首版文本；`agent.ctx.systemPrompt.context({ name:'cc-memory', order: config.contextOrder, required:false, text: () => cache.get(agent.id) ?? '' })`；disposer 同时归 plugin effect 与 agent 生命周期（用 `ctx.effect` + Map 记录）。
- 失效刷新：`runtime.onInvalidate(...)` 收到后重建该 agent 文本（异步，避免并发重入）；另加 30s 定时器兜底重建所有存活 agent 的缓存（context text 同步函数只能读缓存）。
- 注：`agent/created` 是 serial 事件，可 await；构建失败时缓存空串并记录 console.warn，不要抛出。
- 注入文本模板（英文为主，稳定、可缓存）：

```
<system-reminder>
Auto memory is enabled for this project. Memory directory: <memoryDir>

MEMORY.md is an index of durable notes written by you in earlier sessions. Topic files load only when you read them.

Rules:
- Save only durable knowledge that is NOT derivable from the codebase/git history or from CLAUDE.md/AGENTS.md.
- Type "user": who the user is, preferences. "feedback": corrections and confirmed approaches. "project": ongoing work, goals, decisions not in code. "reference": where external information lives.
- Do not save secrets, credentials, or content already in the repository.
- Keep MEMORY.md index lines short (<160 chars); move details into topic files; merge duplicates and delete stale entries.
- Use the memory_* tools to read and write memory.

<index>
...MEMORY.md head...
</index>
<budget-notice>index is over budget ...</budget-notice>   // 仅超限时
</system-reminder>
```
（中文用户也接受中文模板；二选一，保持稳定。）

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
工具集：
1. `memory_save {name, type, description, content, scope?}` → saveEntry；超限 warning 放返回值。
2. `memory_search {query, scope?, limit?}` → search。
3. `memory_list {scope?}` → entries + budget（不含正文）。
4. `memory_read {file, scope?}` → raw。
5. `memory_update {file, content?, description?, scope?}` → updateEntry。
6. `memory_delete {file, scope?, confirm:true}` → 若 config.dreamAllowDelete 为 false 返回错误对象 `{ok:false,error:'delete-disabled'}`（不抛）。
7. `memory_status {}` → runtime 状态 + 用 `store.injectedIndex()` 现场生成的注入预览 + config 摘要（供调试/模型自查，不依赖 inject 缓存）。
8. `memory_dream {dryRun?, reason?}` → 调用 `runtime.dream({agent, force:true, dryRun})`（由 Lead 在 runtime 上挂 `dream` 方法；若不存在返回 `{ok:false,error:'dream-unavailable'}`）。返回 run 摘要。
- `exec.agent` 用于 `runtime.forAgent`。
- 保存后调用 `runtime.invalidateInjection(exec.agent.id)`。

## `src/dream.js`（dream-engine）

```js
export class DreamEngine {
  constructor({ ctx, runtime, config })
  // pctx 由 runtime 提供（含 paths/store/state/workspaceDir；agent 可能为 undefined，例如自动触发）
  async run({ pctx, agent, force = false, dryRun = false, trigger = 'auto', signal, reason }): Promise<DreamRunResult>
  // review 模式产出的提案审批后应用
  async applyPending({ pctx, agent, plan, proposalPath }): Promise<{ applied: boolean, summary?: string, filesTouched?: number, error?: string }>
}
// DreamRunResult = { ran, skipped?, skipReason?, applied, mode:'apply'|'review', dryRun,
//                    summary, operations, filesTouched, sessionsReviewed, proposalPath?,
//                    backupDir?, error?, startedAt, finishedAt }
```
职责：
- 闸门（`force` 时只保留 enabled/lock）：enabled → lastDreamAt+minHours → sessionsSince≥minSessions → lastScanAt 节流 → 锁。
- 锁：`pctx.paths.lockFile` 即 `<projectDir>/.consolidate-lock`（与 memory 目录平级），`open(path,'wx')` 写入 `{pid, startedAt}`；已存在且 mtime 在 `lockTtlMs` 内 → skip `lock`；过期则接管。失败/异常时把 mtime 回滚为上次 dream 时间（`utimes`）。
- gather：调用 `gatherDreamInput()`。
- LLM：`ctx.llm.stream({ provider, model, messages:[{role:'user', content:[{type:'text', text: prompt}]}], system: DREAM_SYSTEM_PROMPT, maxTokens: config.llmMaxTokens, signal, purpose:'cc-memory-dream' })`；收集 `text-delta`；`finish.reason.kind==='error'|'aborted'` 抛错。provider/model 来自 `ctx.get('agentDefaultModel')?.currentSelection?.()`，缺失或调用失败 → `{ran:false, skipReason:'llm-unavailable'}`（不抛）。
- 解析：从文本中提取第一个 ```json 代码块或首个 `{` 到末个 `}`；`JSON.parse`；校验（见下）。
- 校验（纯函数 `validateDreamPlan(plan, {config, existingFiles})`，单独导出便于测试）：
  - `operations` 数组、≤ dreamMaxOps；
  - op ∈ write/delete/index 之一；
  - write/delete 的 `file` 必须匹配 `^[A-Za-z0-9._-]+\.md$` 且不属于保留文件（`MEMORY.md`, `.dream-log.md`）；
  - delete 需 `config.dreamAllowDelete`，否则丢弃该操作并记入 `notes`；
  - write 的 `content`/`body` ≤ config.maxContentBytes；
  - `type` ∈ user|feedback|project|reference；
  - 返回 `{ ok, plan: normalized, dropped: string[] }`。
- 应用：先备份当前 memory 目录全部文件到 `pctx.paths.dreamsDir/<ts>/`；`dryRun` 时只写 `<dreamsDir>/<ts>/plan.json` 不应用；`mode==='review'` 时写 `pctx.paths.pendingDir/<ts>.json` + 返回 proposalPath；`apply` 时写文件、写索引、写 changelog（`pctx.paths.changelogFile`）、更新 state、清 sessions。
- changelog 条目格式：
```
## 2026-11-06T23:10:00.000Z
- trigger: auto|manual, sessions: 3, ops: 4 (write 3, delete 0, index 1), backup: .dreams/2026-11-06T23-10-00
- summary: ...
```
- 幂等：失败后释放锁并回滚 mtime；下一轮重新整理。

## `src/dream-input.js`（dream-engine）

```js
export async function gatherDreamInput({ ctx, store, config, workspaceDir, state }): Promise<{
  memory: { index: string, files: {file,type,modified,description,body}[] },
  sessions: { id, title?, at, excerpt }[],
  chars: number, truncated: boolean
}>
```
- session 来源：优先 `state.snapshot().sessionsSince` 中的 id；不足 `sessionLookback` 时用 `ctx.get('sessionQuery')?.filterSessions([{kind:'cwd', values:[workspaceDir]}])` 补齐（取 header.createdAt 最新）。
- 每个 session：`readSession(id)` → `events`，抽取 `user/message` 文本与 `assistant/message` 文本（`message.content` 里 `type==='text'` 的 `text`），按顺序合并，单 session ≤4000 字符；总字符 ≤ `dreamInputMaxChars`。
- 任何 session 读取失败跳过并记录。

## `src/dream-prompt.js`（dream-engine）

导出 `DREAM_SYSTEM_PROMPT` 与 `buildDreamPrompt(input)`；包含：
- 标题 `Dream: Memory Consolidation`；
- 四阶段 Orient/Gather/Consolidate/Prune；
- 规则：合并重复、纠正矛盾、相对日期转绝对、不臆造、不得编辑 CLAUDE.md/AGENTS.md、索引一行一条且 <200 行/~25KB、细节下沉到 topic 文件；
- 输出严格 JSON schema：
```json
{"summary":"...","operations":[
 {"op":"write","scope":"project","type":"user","name":"user_role","description":"...","body":"..."},
 {"op":"delete","scope":"project","file":"old.md","reason":"..."},
 {"op":"index","content":"- [user_role](user_role.md) — ...\n"}
],"notes":"..."}
```
- 只输出 JSON（可包在 ```json 代码块内），不要解释。

## `src/commands.js`（ui-commands）

```js
export function registerCommands(ctx, runtime): () => void
export function parseCommandLine(rawInput): { verb, args }   // 纯函数，便于测试
```
`/memory` 子命令：`json`、`list`、`show <file>`、`index`、`on`/`off`、`dream on|off`、`dream status`、`dream run [--dry-run]`、`dream apply`、`delete <file>`。`/remember [--type=..] [--scope=..] <text>`。
- 返回 `{kind:'success', text}` 或 `{kind:'error', text}`；`json` 返回可被 `JSON.parse` 的文本。
- 开关状态持久化：`/memory on|off` 与 `/memory dream on|off` 需要写回插件配置。用 `ctx.fiber.entry` + `ctx.get('configEditor')` 按 host-plugin.md 的方法改行 config；若 editor/entry 不可用，返回 error 说明「cannot persist」。改完提示「takes effect after plugin reload」。
- `/memory dream run` 调用 `runtime.dream({agent, force:true, dryRun, trigger:'manual'})`；`apply` 调用 `runtime.applyPendingDream({agent})`（Lead 提供）。JSON 输出用于 UI。

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
  5. Dream 卡片：状态（lastDreamAt/error/pendingProposal）、按钮「立即整理（dry-run）」「应用提案」、`.dream-log.md` 最近 20 行。
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

`MemoryRuntime` 会懒加载 `src/dream.js` 的 `DreamEngine`（动态 `import()`，避免循环依赖），并在 `src/runtime.js` 暴露：
```js
async dream({ agent, force, dryRun, trigger, reason }): Promise<DreamRunResult>
async applyPendingDream({ agent }): Promise<{ applied, summary, error? }>
```
`tools.js` 与 `commands.js` 只调用这两个方法。
