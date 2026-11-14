# dsh-cc-dream-memory 架构与 DSH 集成手册

- 版本 **0.20.0**（2026-11-13）
- 定位：DSH 插件，**实验性、可审计**的 **auto memory（自写记忆）** 与 **Dream（后台整理）**；受 Claude Code 启发，不是复刻，也不声称达到或超过官方能力。
- 数据目录：`~/.dsh/cc-memory`（独立于插件安装位置，升级/卸载不丢数据）。

---

## 1. 架构总览

```
┌────────────────────────────── DSH Host (Cordis) ──────────────────────────────┐
│  tools  registry     systemPrompt  registry     commands  registry            │
│      ▲                    ▲                          ▲                        │
│      │ ctx.tools.register │ agent.ctx.systemPrompt   │ ctx.commands.register  │
│      │                    │ .context({text})         │                        │
│  ┌───┴────────────────────┴──────────────────────────┴────────────────────┐   │
│  │                     dsh-cc-dream-memory (Host half)                           │   │
│  │  index.js  apply(ctx, rawConfig)                                        │   │
│  │   ├─ config.js      row config 校验/clamp/冻结                          │   │
│  │   ├─ runtime.js     MemoryRuntime：项目上下文缓存 / overrides / rules /  │   │
│  │   │                 dream 入口 / 注入失效广播                            │   │
│  │   ├─ store.js       MemoryStore：MEMORY.md 索引 + topic 文件、原子写、    │   │
│  │   │                 预算、unicode slug、trash、audit/reconcile           │   │
│  │   ├─ state.js       ProjectState：dream 节奏/会话/提案/lastPlan           │   │
│  │   ├─ inject.js      会话级冻结注入（systemPrompt.context）                │   │
│  │   ├─ tools.js       4 个 memory_* 工具                                  │   │
│  │   ├─ commands.js    /memory、/remember 命令族                           │   │
│  │   ├─ scheduler.js   session/event(turn/end) → auto dream 闸门            │   │
│  │   ├─ dream.js       DreamEngine：校验→证据→备份→应用/回滚/undo            │   │
│  │   ├─ dream-*.js     转写 / 收集 / 单元分析 / 宿主校验 / 逐条合并/运行记录 │   │
│  │   ├─ recall.js      按用户消息附加相关记忆（agent/pre-step）              │   │
│  │   ├─ rules.js      可编辑注入规则（project/global/default 优先级）        │   │
│  │   ├─ http.js       静默 HTTP API（/api/cc-memory/* + token）             │   │
│  │   ├─ paths.js      项目身份（git root→slug）与全部路径                    │   │
│  │   └─ meta.js       VERSION / DATA_SCHEMA / health                       │   │
│  └───┬────────────────────────────────────────────────────────────────────┘   │
│      │ ctx.inject([webServer]) → 注册 /api/cc-memory 前缀                 │
│      ▼                                                                         │
│  ┌────────────────────────────── DSH Web UI ───────────────────────────────┐  │
│  │  client.js (browser half, window.__ModuleLoader__)                      │  │
│  │   ├─ conversation.view  id=cc-memory, order=40   「记忆」页              │  │
│  │   └─ conversation.composer.dock  id=cc-memory-status, order=50  状态 chip│  │
│  │  fetch → GET/POST /api/cc-memory/*（x-cc-memory-token）                 │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘
                    │ 只读/读写
                    ▼
      ~/.dsh/cc-memory/projects/<project-slug>/
        memory/MEMORY.md + topic .md     ← 模型可见的注入与工具读写面
        .state.json / .dream-log.md / .dreams/ / .pending/ / .trash/
```

**一句话数据流**：模型每次请求看到一份「规则 + MEMORY.md 索引」的尾部提示，用户消息明显相关时再附上那几条记忆；它通过 `memory_*` 工具读写 Markdown 记忆；turn 结束时调度 dreaming 在后台合并/纠错；人通过 `/memory` 命令或 Web「记忆」页查看、开关、编辑规则、审阅Dream结果。

---

## 2. 模块地图（Host 侧）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `index.js` | 插件入口：resolveConfig → MemoryRuntime → `mount()` 各能力；整体 try/catch；统一清理 | `apply`, `inject=['tools','systemPrompt']` |
| `src/config.js` | 行配置校验/默认值/clamp/冻结（不用 Schemastery，纯 JS） | `DEFAULTS`, `resolveConfig(raw)` |
| `src/runtime.js` | 项目上下文（按 **projectRoot** 缓存，repo/子目录共享）、会话→项目解析、运行时 overrides、rules 读写、dream 入口、注入失效广播 | `MemoryRuntime` |
| `src/store.js` | 记忆文件 CRUD、索引维护、预算截断、unicode 文件名、冲突后缀、软删除、索引一致性、中文 bigram 检索；单次操作内复用已解析正文（`_readContent`：stat 命中即复用，写后清空），`contentReads` 可统计真实读盘次数 | `MemoryStore`, `MEMORY_TYPES`, `slugify`, `normalizeScope`, `normalizeType`, `entryVersion` |
| `src/state.js` | 项目状态 JSON：lastDreamAt、sessionsSince、dreamProcessedSessions（水位线）、lastPlanPath、pendingProposal、连续失败数 | `ProjectState` |
| `src/inject.js` | 每 agent 注册 `systemPrompt.context`；加载 `MEMORY.md` 会话快照；按会话压缩、显式刷新、配置和规则变更重建 | `registerInjection`, `buildInjectionText`, `CONTEXT_NAME` |
| `src/write-review.js` | 正文合成：`STATUS: current` 标记、`## History` 的 `- Superseded:` 行、按章节切分；不再判断写入该不该审 | `memoryHash`, `splitMemoryBody`, `composeCorrection` |
| `src/policy.js` | 写入策略：重复/相反停止写入，其余 advisory | `evaluateWrite`, `loadPolicyEntries` |
| `src/tools.js` | 4 个 `memory_*` 工具（JSON Schema + output.render）；关闭态门控 | `registerTools` |
| `src/commands.js` | `/memory` 子命令族、`/remember`；纯函数解析器；JSON 输出 | `registerCommands`, `parseCommandLine`, `parseRememberInput` |
| `src/scheduler.js` | 监听 `session/event` 的 `turn/end`；auto dream 闸门（含退避）；v20 可选 auto-extract（写互斥 + 每 N 轮 + 5-turn 单次抽取）；跳过 subagent 会话 | `registerScheduler` |
| `src/dream.js` | 校验/应用/回滚/undo：计划校验→证据检查→备份→应用→回滚→changelog→state（`run` 已删除，运行由 `dream-pipeline.js` 负责） | `DreamEngine`, `validateDreamPlan` |
| `src/dream-input.js` | **纯读取**：只收集最近主线会话（短会话全文、长会话切块）+ `reads`；按水位线只读新增部分；subagent/探针过滤。记忆页由 `dream-pipeline.js` 的 `memoryPagesOf()` 一次性全读，不在这里重复读 | `gatherDreamInput`, `pruneProbeSessions` |
| `src/dream-session-text.js` | 会话事件 → 带来源标签的转写：过滤宿主注入、识别 `[user-pasted]`、工具调用/结果配对、日期标记、转义伪造的标签行、按字符切块 | `buildSessionTranscript`, `chunkTranscript`, `extractSessionText`, `isProbeSession` |
| `src/dream-run.js` | 运行目录与单元记录：`runId`、`.dreams/<runId>/manifest.json`、逐单元分析结果、状态/取消/续跑所需字段 | `newRunId`, `writeRunManifest`, `readUnitRecord`, `summarizeRun` |
| `src/dream-pipeline.js` | Dream v2 主路径：按单元分析→宿主校验→逐条合并（`dream-merge.js`）→证据门→复用 `DreamEngine.executePlan`；单元级断点与续跑 | `DreamPipeline` |
| `src/dream-merge.js` | 宿主合并：同一事实跨会话去重、`contradicts` 命中唯一行则替换并记历史、对象/量纲不符进 review、生成索引与 `Related:` | `mergeClaims`, `buildMemoryIndex` |
| `src/dream-analyzer.js` | analyzer 提示词与回复解析（claims/verify/patches） | `ANALYZER_SYSTEM_PROMPT`, `buildAnalyzerPrompt`, `parseAnalyzerReply` |
| `src/dream-verifier.js` | 宿主校验：引用回原文定位、丢弃无出处 claim、无引用的 verdict 降级为 unknown | `verifyAnalysis` |
| `src/dream-evidence.js` | 文本匹配工具：忽略大小写/空白/markdown/标点的比对、转写块解析与引用定位、正文行级增删对比、写入被拒时连带丢弃依赖的破坏性操作 | `normalizeForMatch`, `parseTranscriptBlocks`, `locateQuote`, `bodyLineChanges`, `dropDestructiveDependents` |
| `src/recall.js` | 自动召回：`recallMode` 只有 `model`（默认）/ `off`；model 每个用户输入最多一次廉价 selector 调用，失败或超时静默不附加；`agent/pre-step` 挂载但同 turn 的后续模型步跳过；每条每会话去重 | `selectRecallByModel`, `recallManifest`, `buildRecallText`, `attachRecall`, `RECALL_SOURCE_KIND` |
| `src/auto-extract.js` | v20 可选抽取：turn/end 后只读上次游标之后的转写，一次结构化 JSON 调用产出提案；只暂存到 Inbox，人工 accept 后才走 `memory_save` 门；不会创建 live Agent | `extractProposals`, `applyProposals`, `runAutoExtract` |
| `src/inbox.js` | 抽取提案的暂存目录 `<projectDir>/inbox/*.json`；人工 `/memory inbox accept` 后才进入主库 | `writeProposal`, `listProposals`, `readProposal`, `removeProposal` |
| `src/rules.js` | 注入规则文件读取（project > global > default）、保存/清除、8000 字符上限 | `DEFAULT_RULES`, `loadRules`, `saveRulesFile` |
| `src/http.js` | 静默 HTTP API：token 鉴权/持久化、loopback+Origin 校验、状态/文件/规则/Inbox/Dream 端点、plugin-disabled 门控 | `registerHttpApi`, `createHttpHandler`, `API_PREFIX` |
| `src/paths.js` | 项目根探测（向上找 `.git` 30 层）、slug（镜像 `~/.dsh/sessions` 命名）、全部路径 | `buildPaths`, `projectSlug`, `resolveProjectRoot` |
| `src/meta.js` | 版本（读 package.json）、`DATA_SCHEMA`、健康检查 | `VERSION`, `DATA_SCHEMA`, `buildHealth` |
| `src/frontmatter.js` | 无第三方 YAML 的 frontmatter 解析/序列化（v7 支持可选 provenance 字段） | `parseFrontmatter`, `stringifyFrontmatter` |
| `src/status.js` | **v7 共用服务层**：HTTP 与 commands 的唯一状态来源；status/file/rules/toggle/dream/delete/backups/trash/restore/metrics/inbox | `createStatusService` |
| `src/secrets.js` | **v7 机密扫描**：8 类规则 + 高熵 base64；warn/deny/off | `scanSecrets`, `secretScanMode`, `secretWarnings` |
| `src/metrics.js` | **v8 效果指标**：`.metrics.json`（注入/读写/search/dream 接受率/成本，跨进程合并） | `readMetrics`, `record*`, `metricsSummary` |
| `src/policy.js` | **v9 写入策略**：相似度、同主题极性冲突、低置信判定（allow/duplicate/possible-duplicate/conflict/low-confidence） | `textSimilarity`, `detectConflict`, `evaluateWrite` |
| `src/pending-writes.js` | **已删除（v24）**：模型写入直接落盘，没有待审队列（与 Claude Code auto memory 一致） | — |
| `src/identity.js` | **v9 项目身份**：config.projectId > workspace 标记 > git root > workspace | `resolveIdentity` |
| `src/readiness.js` | 自动 Dream 的准入与阻塞原因，供调度器、执行器和状态服务共用；另提供记忆健康度 | `dreamReadiness`, `memoryHealth` |
| `src/lock.js` | **v10 跨进程写锁**：`withFileLock`/`readLock`（wx + pid/ts、TTL 接管、失败降级） | `withFileLock`, `readLock` |
| `src/import-export.js` | **v10 Claude Code 互通**：导入 CC memory 目录、导出同款 layout + `.claude/rules` | `importClaudeMemory`, `exportClaudeMemory` |

### 关键内部关系

- **MemoryRuntime 是唯一的“项目事实源”**：所有模块都通过 `runtime.forAgent(agent)` / `runtime.forSessionId(id)` 拿 `ProjectContext = {workspaceDir, paths, store, state, agent, sessionId}`，保证 store/state/路径一致。
- **项目身份按 projectRoot 归一**：runtime 先 `buildPaths()` 解析出 git 根，再用它作为缓存键；`repo/` 与 `repo/pkg` 拿到**同一个** store/state 实例（避免并发写同一索引）。
- **`runtime.config` 是 getter**：返回「行配置 + 运行时 overrides」（冻结对象）。因此 `/memory plugin off`、UI 开关无需重载插件即可生效。
- **store 的写路径全部串行 + 原子**（临时文件 + rename + Windows 瞬时 EPERM 重试）；读路径只走白名单文件名与路径包含校验。
- **dream 的 LLM 调用只发生在 DreamEngine 内部**（`ctx.llm.stream`），工具/命令/UI 不会直接调模型。

---

## 3. 数据模型与磁盘布局

```
$DSH_HOME/cc-memory/                      # 默认 ~/.dsh/cc-memory（config.memoryRoot 可改）
├── .plugin-state.json                    # 运行时开关覆盖（enabled/autoMemoryEnabled/autoDreamEnabled）
├── .api-token                            # 静默 API token（0600，跨重载稳定）
├── memory-rules.md                       # 可选：全局注入规则覆盖
└── projects/<project-slug>/              # slug 形如 --C-Users-me-repo--
    ├── memory/                           # ★ 只有人类可读的记忆文件
    │   ├── MEMORY.md                     # 索引：一行一条 `- [name](file) — description`
    │   ├── user_user_language.md         # topic 文件：frontmatter + 正文
    │   └── ...
    ├── memory-rules.md                   # 可选：项目级注入规则覆盖
    ├── .memory-rules.log                 # rules 变更审计（scope/source/bytes/sha256）
    ├── .state.json                       # dream 节奏/待切换副本/成本摘要
    ├── .metrics.json                     # v8 效果指标（注入/读写/search/dream/成本，跨进程合并）
    ├── .dream-log.md                     # 每次 dream 的 changelog（追加）
    ├── .consolidate-lock                 # dream 并发锁（PID + startedAt，TTL 1h）
    ├── .dreams/<ts>/                     # 切换前的完整备份 + meta.json（撤销用）
    ├── .dreams/shadow/                   # Dream 写出的记忆副本（等你切换或丢弃）
    └── .trash/<ts>/                      # 软删除（含 .reason.txt）与回滚移出的文件
```

### topic 文件格式

```markdown
---
name: user_language
description: 用户以中文沟通，希望中文回复
type: user            # user | feedback | project | reference
modified: 2026-11-07T04:10:57.058Z
# v7 provenance（可选，旧文件没有也正常）：
created: 2026-11-07T04:10:57.058Z
source_session: session-…            # 写入它的会话 id
via: tool:memory_save                # tool:<name> | command:/remember | dream
---

正文（Markdown，按需 memory_read 读取）
```

- 文件名：`<type>_<slug(name)>.md`；slug 保留 `\p{L}\p{N}`（中文不塌缩），不同 name 撞同一 slug 时追加 `-<sha1前6位>`。
- 索引预算：注入时只取 **前 200 行 / 前 25600 字节**（先到者），超出部分不注入；超限时注入 `<budget-notice>`；达到 80% 时提前提醒。
- 类型语义：`user` 用户画像/偏好 · `feedback` 纠正与确认做法 · `project` 代码/git 推不出的进行中决策 · `reference` 外部信息在哪找。

### state.json 字段

```json
{
  "version": 1,
  "lastDreamAt": 0, "lastDreamAttemptAt": 0, "lastScanAt": 0,
  "lastDreamSessions": 0, "lastDreamOps": 0, "lastDreamFiles": 0,
  "lastDreamSummary": "", "lastDreamMode": "", "lastError": "",
  "sessionsSince": [{ "id": "session-…", "at": 1794… }],
  "dreamProcessedSessions": [{ "id": "session-…", "at": 1794…, "seq": 412, "partial": true }],
  "counters": { "dreams": 0, "skipped": 0, "failures": 0 },
  "pendingProposal": "deprecated（v24 已删）",
  "shadowPending": { "dir": "…/.dreams/shadow", "createdAt": 1794…,
                     "runId": "…", "summary": "…",
                     "counts": { "added": 0, "changed": 1, "removed": 0 },
                     "files": [{ "file": "user_role.md", "action": "changed" }] },
  "consecutiveFailures": 0
}
```

`shadowPending` 是「有一份副本等你切换或丢弃」的唯一指针；`null` 表示没有。切换成功后它被清空，`lastDreamMode` 记为 `shadow`。

`dreamProcessedSessions` 是水位线：`seq` 是已读到的最后一个事件，`partial` 表示还没读完。只有计划应用成功才写入。

损坏/未知字段：回退默认、忽略未知；`DATA_SCHEMA = 1` 与插件版本解耦。

### dream 副本与切换元数据

Dream 不再产出「计划 JSON」，而是把分析结果写进一份**记忆副本**（`.dreams/shadow/`），再与当前记忆逐文件比对：

```json
// state.json 的 shadowPending（见上）
{ "dir": "…/.dreams/shadow", "createdAt": 1794…, "runId": "…", "summary": "一句话",
  "counts": { "added": 0, "changed": 1, "removed": 0 },
  "files": [{ "file": "user_role.md", "action": "changed" }],
  "base": { "user_role.md": "<hash>" },
  "verifiedFiles": ["user_role.md"], "sessions": ["session-…"] }
```

切换（`DreamEngine.switchShadow`）先把当前记忆目录整目录备份到 `.dreams/<ts>/memory/`，然后逐文件写回、把副本里没有的文件 `trashEntry`、`refreshIndex`，并写：

```json
// .dreams/<ts>/meta.json
{ "kind": "dream-switch", "stamp": "…", "ts": "…", "appliedAt": 1794…,
  "runId": "…", "summary": "…", "sessions": ["session-…"],
  "counts": { "added": 0, "changed": 1, "removed": 0 },
  "files": ["user_role.md"], "rewritten": ["user_role.md"], "created": [], "removed": [],
  "operations": [{ "file": "user_role.md", "action": "changed", "hashAfter": "sha256:…" }],
  "hashes": { "user_role.md": "sha256:…" }, "backupDir": "…/.dreams/<ts>/memory" }
```

`listSwitches(paths)` 统一读取历史和撤销所用的 `dream-switch` 元数据。撤销还原 `rewritten`，把 `created` 移入回收站；文件切换后的哈希发生变化则整次返回 `conflict`。只有旧格式批次时返回 `no-undoable-batch`。

副本侧的操作仍然只有三种：`write`（`writeRawEntry`）、`delete`（仅在 `dreamAllowDelete` 时 `trashEntry`）、`index`（`writeIndex`），末尾统一 `refreshIndex()`。

---

## 4. Host 生命周期（Cordis / DSH 集成机制）

### 4.1 安装形态

插件是一个 **DSH bundle**：

```jsonc
// package.json
{
  "name": "dsh-cc-dream-memory",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },     // Host 行
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-ui-conversation",
                           "@deepseek-ai/dsh-client-locale",
                           "@deepseek-ai/dsh-api-remotes"] }
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: cc-dream-memory
      name: dsh-cc-dream-memory
      config:
        autoDreamEnabled: false
```

安装后：profile `package.json` 的 `dsh.profile.bundles` 追加 `dsh-cc-dream-memory`，`node_modules` 软链到插件目录（本地 bundle 安装）。插件随 Host 启动自动加载。

### 4.2 加载与依赖

- `export const inject = ['tools', 'systemPrompt']`：**只有这两个是硬依赖**。
- `commands`、`agents`、`workingDirectory` 是可选宿主能力。`webServer` 就绪时由 `ctx.inject` 挂载 HTTP 路由。
- `export function apply(ctx, rawConfig)`：整体 try/catch；每个能力单独 `mount()`，单点失败只 warn，不影响其它能力，也不向 Host 抛错。
- `createMemoryPlugin(ctx, rawConfig)`：同一套构建逻辑，额外返回**可等待的** `dispose()`（内部 `runtime.drain()` 等待后台写入）；测试与工具用它做确定性卸载，`apply()` 只是包一层 `ctx.effect`。
- 清理：所有注册返回 disposer，收集后挂在 `ctx.effect(() => () => cleanup())`，reload/卸载零残留。

### 4.3 在 DSH 里注册的扩展点

| DSH 扩展点 | 本插件用法 | 语义 |
|---|---|---|
| `ctx.tools.register(def)` | 4 个 `memory_*` 工具 | 模型可调用的记忆读写/Dream |
| `agent.ctx.systemPrompt.context({name:'cc-memory', order:850, required:false, text})` | 每个 agent 注册动态 runtime context | **DSH 会把该文本作为一条尾部 user 消息追加到请求**（`agent-loop`: `messages:[...claimed, context]`），文本不变时不会重复追加 |
| `ctx.on('agent/created')` | serial 事件，`await` 构建首版注入 | 保证**第一轮请求**就带上索引 |
| `ctx.on('agent/disposed')` | 清缓存 | 生命周期干净 |
| `agentCtx.on('agent/pre-step')` | 自动召回：用户消息相关时追加一条 `source.kind='plugin:cc-memory-recall'` 的消息 | 独立消息，不改 runtime context 快照（改快照会触发整份重发） |
| `ctx.on('session/event')` | `turn/end` → auto dream 检查；`compaction/*` → 刷新冻结快照 | 不动会话日志，只读观察 |
| `ctx.commands.register(def)` | `/memory`、`/remember` | 人类命令，不进模型历史 |
| `ctx.webServer.register({kind:'prefix', path})` | `/api/cc-memory/*` | 静默数据通道（loopback + token） |
| `GET /api/cc-memory/bridge` | 返回 `{ok,base,token}` | 页面启动时凭同源凭据发现 API |
| `ctx.agents` / `workingDirectory.ensure(agent)` | 会话 ↔ 工作目录解析 | 决定项目记忆目录 |
| `ctx.sessionQuery` | dream gather：`filterSessions` / `readSession` | 只读历史 transcript |
| `ctx.llm.stream` | 单元分析 `cc-memory-dream-analyze` | 只产出 claims/verify，不直接写盘 |
| `ctx.agentDefaultModel.currentSelection()` | dream 的 provider/model 回退 | 与当前会话模型一致 |
| `agent.session.header` | 识别 `parentSession` / `origin:'subagent'` | 子会话过滤/注入开关 |

### 4.4 项目身份（记忆目录如何映射）

1. 取会话工作目录（`workingDirectory.ensure(agent)`）；缺失时该会话记忆功能禁用，**不回退** `process.cwd()`。
2. 向上最多 30 层找 `.git`（目录或 worktree 的 `.git` 文件）；worktree 解析到共享主仓库，项目根归一化盘符大小写；没有则用工作目录本身。
3. `projectSlug()` 把绝对路径转成 `--C-Users-me-repo--`（与 `~/.dsh/sessions/<slug>` 同款命名）。
4. 记忆目录 = `<memoryRoot>/projects/<slug>/memory`；runtime 以 **projectRoot** 为缓存键，同仓库不同子目录共享 store/state。

---

## 5. 请求链路

### 5.1 会话开始 → 索引注入（默认 session 冻结模式）

```
DSH 创建 agent
  └─ agent/created (serial)
       └─ inject.attach(agent, {buildFirst:true})
            ├─ buildText(agent):
            │    runtime.forAgent(agent) → ProjectContext
            │    store.injectedIndex('project')      # 前 200 行/25KB，原文
            │    runtime.rulesFor(ctx)               # project > global > 无（默认不注入）
            │    buildInjectionText({memoryDir, index, rules, caution})
            └─ ensureRegistered(agent): agent.ctx.systemPrompt.context({
                   name:'cc-memory', order:850, required:false,
                   text: () => cache.get(sessionId) ?? ''
               })
                 record.built = true     # ★ 本会话快照从此冻结

第一次模型请求
  └─ DSH 组装：system sections + tools + runtime contexts
       └─ 本插件文本作为尾部 user 消息追加一次
```

**会话快照**

| 事件 | 对注入文本的影响 |
|---|---|
| 本会话 `memory_save` / dream | 不变（模型已在对话历史里知道） |
| 其他会话写入 | 不变（下个会话生效） |
| `compaction/*` 会话事件 | **刷新一次**（前缀本来就要重算） |
| 配置/规则显式变更（`invalidateInjection(reason='config'/'rules')`） | 强制刷新 |

> 已核对 DSH 源码：runtime context **不在 system prompt 前缀**，而是尾部的 user 消息，文本不变不会重复追加。冻结的主要收益是避免记忆变化不断往历史里追加新快照消息（token 增长），并让会话上下文稳定。

### 5.2 模型调用 `memory_*` 工具

```
模型 → tools.register 的 execute(args, exec)
  └─ runtime.forAgent(exec.agent) → ProjectContext
       ├─ memory_save / update（含 delete）→ 关闭态门控（auto-memory / plugin off）
       ├─ MemoryStore 原子写（tmp+rename；失败重试；权限/路径校验）
       ├─ 写后：重建 MEMORY.md 索引行、返回 JSON（含 index 预算/warning）
       └─ runtime.invalidateInjection(sessionId, 'memory-write')  # 冻结模式忽略
```

### 5.3 命令链路

```
用户输入 /memory …  → ctx.commands.register 的 handler({agent, rawInput})
  ├─ parseCommandLine(rawInput) 纯函数解析
  ├─ collectStatus(invocation)  收拢 项目/配置/状态/索引/规则/trash/changelog
  └─ 返回 {kind:'success'|'error', text}；/memory json 返回可机读 JSON
```

### 5.4 Web 视图链路（静默 API，不写会话日志）

```
用户打开「记忆」标签
  └─ client.js 组件挂载
       ├─ fetch GET /api/cc-memory/status?sessionId=…   (x-cc-memory-token)
       │     └─ Host: createHttpHandler → token 校验 → runtime.forSessionId → statusPayload
       ├─ 渲染：状态 pills / 索引 / 文件 / Dream / Rules / trash / changelog
       └─ 用户操作 → POST /toggle | /rules | /dream | /delete | GET /file
```

页面先从同源 `GET /api/cc-memory/bridge` 获取地址和令牌，再走 HTTP。桥接失败时显示服务不可用和刷新入口。

### 5.5 自动召回

```
agent/pre-step（异步瀑布）
  ├─ 先 await next()，拿到本步决策；被拒绝的步骤原样返回
  ├─ 取本步消息里用户手打的文本（source.kind 为空或 'user'）；没有就什么也不做
  ├─ 用最后一条 typed user message 的 id（无 id 时用内容哈希）识别 turn；同一 turn 的后续模型步直接跳过
  ├─ recallMode='off'：完全不附加
  └─ recallMode='model'（唯一选择器）：
        manifest 只含 name/description/type/modified（来自元数据目录，不读正文）
        → 每个用户输入一次廉价 selector 调用（候选 ≤5，附加受 autoRecallMaxFiles 默认 3 约束；
          recentTools 降噪；本会话已给过的不再给）
        → 超时、调用失败、JSON 无效或没有选中：本轮不附加，不跑第二套词面排序，也不在同 turn 重试
        → 选中项按当前页读取，正文受 autoRecallMaxChars 硬预算
        → 追加 {source.kind:'plugin:cc-memory-recall'} 消息（标明是背景、可能过时）
```

`autoRecall`、`autoRecallBody`、`recallMode:'lexical'` 已删除。Dream 的转写按 `source.kind` 过滤掉召回消息，所以召回内容不会被当成用户的话再写回记忆。计数在 `/memory metrics`。

### 5.6 与 Claude Code auto memory 的对照

基线：Claude Code 官方文档与系统提示（2026-11-13）。存储布局、索引预算、项目/worktree 共享这些「骨架」已对齐；v23 完成了单一路径清理：模型召回、Inbox-only 抽取、元数据目录、子代理枚举、Dream 输入预算与索引/历史硬上限。自动化程度、团队能力与 Dream 形态仍有差距，另有一些有意偏离。

| # | 维度 | 官方（2026-11） | 本插件（v23） | 差距 |
|---|---|---|---|---|
| 1 | 写入时机 | 每轮 query loop 后 forked agent 自动抽取；主 agent 本会话已写则跳过；按轮节流；5-turn 预算；只读最近消息、不验证 | 模型主动 `memory_save`/`memory_update`；可选 `autoExtract`（默认关）：turn/end、每 N 轮、本 turn 写过则跳过、单次结构化抽取、只进 Inbox；Dream 批量整理（默认关） | 中：自动路径仍 opt-in，且是单次调用而非官方 5-turn 工具循环 |
| 2 | 召回 | 每个用户输入一次 Sonnet selector：manifest（名称/描述/类型/时间）→ 最多 5 个文件自动附上；`recentTools` 降噪；失败静默空 | `recallMode:'model'`（唯一）：每个用户输入一次廉价 selector + 元数据 manifest + `recentTools` + 本会话去重，候选 ≤5、附加受 `autoRecallMaxFiles` 默认 3 约束；超时/失败静默空，无词面回退 | 低中：机制对齐，模型档位与提示词不是官方实现 |
| 3 | 写什么/怎么写 | 系统提示含完整 auto-memory 段：四类型与 private/team、保存/不保存清单、`**Why:**`/`**How to apply:**`、漂移核验 | 19 行紧凑手册：四类型、保存/不保存、`**Why:**`/`**How to apply:**`、绝对日期、推荐前核验；无 team 段 | 低中：覆盖了写入质量规则，仍是紧凑版 |
| 4 | 子代理记忆 | 主记忆不注入子代理（fork 例外）；子代理可用 frontmatter `memory` 拥有 user/project/local 目录，快照合并，Write/Edit 白名单 | 单一 `subagentMemory:'off'|'shared'|'own'`：`off` 不注入/不可写；`shared` 读写项目库；`own` 用 `agents/<preset>/memory`（`agentMemoryPresets` 可限制），只注入该子代理、只写自己目录；无快照合并 | 中：多代理可隔离，但没有官方多 scope/快照语义 |
| 5 | 团队记忆 | `team/` + 服务器同步 + secret scanner；类型带 private/team 默认 | 无 | 中（取决于 DSH 是否有团队场景） |
| 6 | Dream 形态 | 4 阶段 agent：grep transcript、对照代码库、CLAUDE.md 对账、直接落盘 | 分析器 JSON + 主机合并 + 引用核验 + shadow + 人工 `switch`；不读代码库；输入受 `dreamInputMaxChars` 约束，每个分析器单元的 memory 上限 12KB；索引由主机重建并 prune | 中：安全 vs 保真 |
| 7 | Dream 触发/应用 | Claude Code 的 [官方维护者说明](https://github.com/anthropics/claude-code/issues/39135) 描述后台自动整理及 `/memory` 开关 | 自动 Dream 默认关闭；启用后的 24 小时、5 会话是插件默认值。结果由用户切换或丢弃 | 本插件保留人工切换 |
| 8 | 配置 | `autoMemoryDirectory`（任意 settings scope）、`CLAUDE_CODE_PROJECT_DIR_NAME`、每项目开关；后台会话只能关不能开 | 全局 `memoryRoot`/`projectId`；子代理目录按 preset；`/memory on/off` + env；无 per-project 开关/目录 | 低中 |
| 9 | 文件工具 | 标准 Read/Write/Edit；记忆就是普通文件 | `memory_save`/`memory_update`/`memory_read`/`memory_search`（评估时另有 `memory_eval_dream`）；模型不直接用文件工具写 | 架构差异：可控 vs 通用 |
| 10 | UI/提示 | `Saved N`/`Recalled N`；`/memory` 列出所有记忆位置并打开目录 | 工具回执、`/memory metrics`、Memory 页、Inbox 页（抽取提案 accept/discard + 上次结果）、`/memory inbox` 命令；`memory_read` 超 30 天提示陈旧 | 低 |
| 11 | CLAUDE.md 侧 | 层级、`@import`、`.claude/rules`、AGENTS.md、`/doctor`、hook | DSH 用 `AGENTS.md` + 可选 `memory-rules.md`；有 import/export | 范围外（指令层由 `dsh-agent-instructions` 负责） |

**实现落点（与上表对应的细节）**

- 注入：`ctx.systemPrompt.context({name:'cc-memory', order:850})`，文本即 `store.injectedIndex('project')` 原文头（前 200 行 / 25KB，先到为准）。官方首轮同样只给索引；每个用户输入再由 selector 追加最多 5 个候选，实际附加受 `autoRecallMaxFiles`（默认 3）约束。
- 读取：`MemoryStore` 维护元数据目录（frontmatter 头 ≤8KB，按 mtime/size 失效），`listEntries` 不再读正文；`readEntry` 只按需读一个正文并回填元数据。官方让模型用标准 Read/Write/Edit 读写普通文件；插件用专用工具是**偏离**，换来的是一致性校验、预算与密钥扫描。
- 会话：`agent/created` 构建并冻结快照。会话压缩、显式刷新、配置或规则变更会重建。
- 共享：`resolveProjectRoot` 取最近 `.git`，worktree 解析到主仓库；一个 slug 一份记忆。
- 子代理：`shouldInject()` 对 `header.parentSession`/`origin:'subagent'` 在 `subagentMemory:'off'` 时返回 false。`own` 且 preset 在 `agentMemoryPresets`（空表 = 任意 preset）时，`runtime.forAgent` 返回 `agents/<preset>/memory` 的独立 `MemoryStore`，注入与写入都只走这份；非 allowlist 的 preset 仍按 `off` 处理（不注入、不可写）。官方默认同样不注入，但允许 frontmatter 声明多 scope 记忆并使用快照合并；插件没有这两项。
- 自动抽取：`scheduler.js` 在主线 `turn/end` 后，若 `autoExtract` 开启且本 turn 主 agent 没写过记忆，按 `autoExtractEveryTurns` 节流，调用一次 `extractProposals`（读 `sessionQuery.readSession` 中游标之后的事件，单次 JSON，不建 live Agent）。提案只写 `<projectDir>/inbox`；同一 session 的新提案按名称合并进已有提案，队列满 5 条时拒绝新 session 而不是驱逐未读；人工 `/memory inbox accept` 才调用 `memory_save`；没有 direct 模式。
- 开关：`/memory on/off`（运行时 live config）+ `resolveConfig(raw,{env})` 读 `CLAUDE_CODE_DISABLE_AUTO_MEMORY`。官方还有 per-project `autoMemoryEnabled`、`autoMemoryDirectory` 与 `CLAUDE_CODE_PROJECT_DIR_NAME`，插件没有。
- 回执：工具回执带 `version`/`bodyHash`；索引满时回执带 error 与「重写索引」提示（对齐官方「写入成功但要求重写索引」）。
- 提示词始终包含 `MEMORY_INSTRUCTIONS`，说明四种类型、保存规则、Why/How、绝对日期和核验。
- 扩展包括 `autoExtract` 的 Inbox 暂存、`subagentMemory` 及 Dream 副本与切换。

**有意保留、不要为了「对齐」丢掉的**：Dream 的人工 `switch` + shadow + 一键 undo；新增事实必须能回查 transcript 的引用核验；`user-explicit` 证据绑定；密钥扫描与 `.trash`；主机重建 `MEMORY.md`；Inbox 默认暂存而不是直接落盘。

> Claude Code 的索引加载、主题文件按需读取和 worktree 共享行为见[官方记忆文档](https://code.claude.com/docs/en/memory#auto-memory)。选择器、Inbox 和 Dream 准入参数在本文按插件实现描述。

---

## 6. Dreaming 详细流程

### 6.1 触发与闸门

- **手动**：`/memory dream run [--focus]`、UI 按钮 → `force=true`，仍保留 enabled、pending-switch 与 lock 检查。
- **自动**：`session/event` 的 `turn/end` → `scheduler.maybeAutoDream()`：

```
enabled && autoMemoryEnabled && autoDreamEnabled
  → 无 shadowPending（一份副本等你切换或丢弃时不跑）
  → 距 lastScanAt ≥ scanThrottleMs（默认 10min）
  → 距 lastDreamAt ≥ minHours（默认 24h）
  → 连续失败退避：min(scanThrottleMs·2^failures, 6h)
  → sessionsSince（主线、去重）≥ minSessions（默认 5）
  → 拿到 .consolidate-lock（PID+TTL 1h）
```

`sessionsSince` 只记录**主线会话**；`parentSession` / `origin:'subagent'` 的 teammate 会话直接跳过（不把 Lead 指令误当用户偏好）。

### 6.2 执行管线

```
DreamPipeline.run({force, trigger, noSessions, focus, runId, resume, inputId, inputRanges})
 1) 闸门 + 锁（open '.consolidate-lock','wx'，payload 带 runId；过期接管；续跑时可接管自己的锁）
 2) 建运行目录 .dreams/<runId>/ 并写 manifest.json（status:running, stage:prepare）
 3) gatherDreamInput({unboundedSessions:true, unitChars:24000})：纯读取会话
      sessions: state.sessionsSince 优先，不够时用 sessionQuery.filterSessions(cwd) 补齐；
              按水位线只读 seq 之后的事件；每 24000 字符一个单元并记 firstSeq/lastSeq
              首次读取没有人类发言或只有探针 → 跳过（进 droppedSessions）
      memoryPagesOf(store)：topic 文件正文只在这里读一次（全量）；读不到进 errors，覆盖不完整就不出副本
      带 inputId/inputRanges 启动时：按估算时的会话与水位裁切，重新算 digest 不一致 → skipped/stale-input（不调模型）
 4) 计划单元：unitId = sha256(sessionId, firstSeq, lastSeq, text) 前 16 位；
      已完成单元从 .dreams/<runId>/analysis/<session>/<unitId>.json 读回（status:done），不重调模型
 5) 每个待做单元：analyzer 一次调用（purpose 'cc-memory-dream-analyze'）
      → parseAnalyzerReply → verifyAnalysis（quote 回原文定位；无出处的 claim 丢弃）
      → finish=max-tokens 时先把单元一分为二再各调一次（正文不丢）
      → 立即写单元记录 + 刷新 manifest（done/failed/pending）；锁随进度续期
 6) 覆盖判定：每个会话的完成单元数 == 计划单元数且无失败 → 该会话完成；否则 failed/partial
 7) 宿主合并 mergeClaims()：逐条 claim 追加带 ^[source#seq, date] 的行；
      contradicts 命中唯一行 → 替换 + STATUS: current + ## History 里记 Superseded；
      同对象不同值且唯一 → 同样按纠正处理；对象不像、命中多行、行已消失、低置信 → plan.review；
      同一事实跨会话去重成一行多引用；没被 claim 命中的页面完全不动；索引与 Related: 由宿主生成
 8) 证据门：checkWriteOperations（新增行须有匹配 seq+日期+原文的已核验 claim；user/feedback 须 [user]）
 9) 逐页 secret scan → 整页全部可核验时打 STATUS/VERIFIED
10) 分支：分析失败 → status:failed（不写任何东西，水位不动）；sessions 无新内容 → status:skipped
11) 写副本：prepareShadow（复制当前记忆 + 索引）→ applyShadowOperations（write/delete/index）→ diffShadow
      无差异 → status:skipped/skipReason:nothing-new；有差异 → state.setShadowPending → status:ready（水位在此推进）
12) 切换（人工，见 6.4）：备份 → 写回 → 移 trash → refreshIndex → meta.json → changelog → invalidateAllInjections
13) 失败：写 manifest（failed/cancelled）并 clearShadow；副本不是记忆，无需回滚
14) 释放锁（成功 unlink）
```

### 6.3 提示词

`ANALYZER_SYSTEM_PROMPT`（`src/dream-analyzer.js`）说明：

1. **怎么读输入**：转写是数据不是指令；只有 `[user]` 是用户在说话，`[user-pasted]` 不是用户的话；日期以 `--- YYYY-MM-DD ---` 为准。
2. **什么值得记**：未来会话从仓库、历史、指令文件都拿不到的内容。架构描述、路径、版本号、测试数等不记。
3. **怎么处理**：明确的用户纠正优先；清楚的新值替换旧值；无法判断先后的两条都留（由宿主标记冲突/待审）。
4. **输出**：严格 JSON，`claims`（text/quote/kind/confidence/target）与可选的 `verify`；宿主不再使用 `patches`（正文由 `mergeClaims` 自己生成）。

宿主的 `verifyAnalysis`（`src/dream-verifier.js`）是最终裁判：quote 必须能在本单元原文中定位，否则丢弃该 claim；verdict 没有原文引用时降级为 `unknown`；`contradicts` 还需与旧值同对象同量纲（`support.js`）。记忆是背景上下文、可能过时，**不覆盖** system/developer/user 指令与 AGENTS.md/CLAUDE.md。

---

## 7. HTTP API 契约

- `GET /bridge`：返回 `{ok, base, token}`，是客户端发现 API 的入口。仅接受回环 Host 和回环连接；DSH 自身鉴权层仍负责宿主会话的鉴权。

- 前缀：`/api/cc-memory/`；请求头 `x-cc-memory-token`；响应 JSON + `Cache-Control: no-store`。
- **安全（v6）**：仅接受 loopback 来源（`req.socket.remoteAddress` 必须 `127.*`/`::1`，否则 403 `loopback-only`）；POST 额外校验 `Origin`（跨源 → 403 `bad-origin`，同 Host 或 loopback host 放行）；token 持久化在 `<memoryRoot>/.api-token`（0600，插件重载/进程重启后不变，已打开页面不会失效）；token 比对常量时间；DSH 自身鉴权层通常在此 handler 之前拦截未认证请求。
- 页面用带凭据的同源 GET 获取 token，桌面通过宿主协议转发请求。桥接失败或 API 返回 401 时，页面提供刷新入口。
- **rules 是持久提示面**：`POST /rules` 会写 `<projectDir>/memory-rules.log` 审计行（scope/source/bytes/sha256/preview），便于追溯 prompt 规则变更。
- `enabled:false` 时仅 `/status`、`/toggle` 可用，其余返回 `{ok:false,error:'plugin-disabled'}`。
- 备份/回收站（v7）：`GET /backups`、`GET /trash` → `{ok,items:[{id,at,files}]}`；`POST /restore {kind,id,file?}` → `{ok,restored,reconciled}`（只允许 `.dreams`/`.trash` 下单段路径，写入 changelog + reconcile）。
- dream 动作（v24 改为副本语义）：`POST /dream {action:'estimate'}` → `{ok,result:{estimatedTokens,limit,rough,inputId,ranges:[{id,lastSeq}]}}`；`{action:'start'|'run',inputId?,inputRanges?,focus?}` 统一启动后台任务；`run` 等待结果（钉定范围被改写时返回 `stale-input`）；`{action:'status',runId}`；`{action:'cancel'|'resume',runId}`；`{action:'switch'}` → `{ok,result:{ok:true,backupDir,counts}}`（运行期间有文件被改 → `{ok:false,error:'conflict',conflicts}`）；`{action:'discard'}`；`{action:'undo'}`。逐项审阅（`preview`/`apply-ops`/`dismiss`/`planId`/`opId`）在 v24 已删除。
- 指标（v8）：`GET /metrics` → `{ok,metrics}`（canonical summary：inject/reads/writes/searches/dreams/costs，另带 `injections` 别名）；`/status` 自带 `metrics`。

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|
| GET | `/status` | `?sessionId=` | `{ok,version,project,config,overrides,index,injection,entries,inbox,state,changelogTail,trashCount,rules,health}`；`inbox` 为 `{count,items}`，`state` 含 `lastExtract*` |
| GET | `/file` | `?sessionId&file` | `{ok,file,frontmatter,body,raw,version,expectedHash}` |
| GET | `/rules` | `?sessionId` | `{ok,rules}` |
| GET | `/log` | `?sessionId&lines=40` | `{ok,tail}` |
| GET | `/inbox` | `?sessionId=` | `{ok,count,items}`（抽取提案摘要，按时间倒序） |
| POST | `/rules` | `{sessionId?,scope:'project'\|'global',text}` | `{ok,rules}`（空 text=删除覆盖） |
| POST | `/toggle` | `{enabled?,autoMemoryEnabled?,autoDreamEnabled?,autoExtract?}` | `{ok,overrides,config}` |
| POST | `/inbox` | `{sessionId?,action:'list'\|'accept'\|'discard',id?}` | list 同 GET；accept `{ok,id,applied,failed,results}`；discard `{ok,id,discarded}` |
| POST | `/dream` | `{sessionId?,action:'estimate'\|'start'\|'status'\|'cancel'\|'resume'\|'switch'\|'discard'\|'undo'}` | `{ok,result}` |
| POST | `/delete` | `{sessionId?,file,scope?}` | `{ok,trashed,trashPath}`（需 `dreamAllowDelete`） |

错误约定：`{ok:false,error,message}`；坏 body→400 `bad-body`；未知 action→400 `unknown-action`；无 token→401。

- **编辑基线（v23）**：`GET /file` 返回 `version`（内容版本，回执/展示用）与 `expectedHash`（整文件 sha256，编辑基线）；`POST /file` 更新时必须带 `expectedHash`，存储写锁内比对，不一致返回 `{ok:false,error:'STALE_WRITE',message:'memory changed since this edit was proposed: <file>'}`，页面文本原样保留、客户端保留草稿；缺失基线或页面已被删除/重命名（含 `POST /file` 带基线但文件已不存在）返回 `{ok:false,error:'stale-write'}` 且**不会重建文件**。旧客户端必须先升级或重新读取，不做兼容。
- **默认只给当前值（v23）**：`GET /search` 与 `POST /file` 详情默认只返回正文的当前部分（`currentBody`），`?history=1` 才检索含历史段落的正文；`memory_read`/`memory_search` 工具同样只给当前值（读取按 `currentBody` 裁剪 + `status` 字段），旧值通过文件视图 / `/memory history` 显式查看。

---

## 8. Client 架构

> **UI 设计已冻结（2026-11-07 起，改动需维护者批准）**：`client.js`、`locale/en.json`、`locale/zh.json`、`icon.svg` 不得更改；任何 UI 改动需用户明确批准并运行 `node scripts/ui-freeze.mjs --update`，否则 `test/ui-freeze.test.mjs` 失败。见 [UI-FREEZE.md](../UI-FREEZE.md)。

- 加载形态：`window.__ModuleLoader__.load({ id:'dsh-cc-dream-memory', factory(require) })`；只能 `require('react')`；无构建步骤、无其它 client 包依赖。
- 注册：
  - `conversation.view`：`{id:'cc-memory', order:40, label:()=>t('view.title')}` → 「记忆」页。
  - `conversation.composer.dock`：`{id:'cc-memory-status', order:50}` → 输入框下方状态 chip（`记忆 N` + 待处理数，自带样式，60s 轮询、卸载清理）。
- 页面结构（v21 UI）：固定头部（标题 + 项目名/条数 + 「记忆 / 待确认 / Dream / 设置」四个标签 + 刷新）+ 可滚动内容。`MemoryView` 持有 status、busy、toast，并提供 `run(key, task, {check, success})`：同一时间只跑一个动作，成功/失败统一 toast，结束后重新拉 `/status`。
  - `MemoriesTab`：搜索 + 新建 → 类型筛选（+ 本项目/跨项目）→ 列表；详情/编辑器在右栏（sticky，最大高度为可视高度，内部滚动），窄屏替换列表。
  - `InboxTab`：合并 Dream 副本卡与自动抽取提案；每条提案显示条数与名称、可展开正文，「Accept all」走 `POST /inbox accept`，「Discard」走 `POST /inbox discard`；空状态区分「自动抽取关闭」与「全部处理完」，并显示上次抽取时间与结果。
  - `TidyTab`：无副本时是引导卡 + 「Estimate the run」→「Start the dream run」；有副本时展示「新增/修改/删除」计数与前 20 个文件，两个按钮「Switch to it」「Discard」；`/dream-history` 单独拉取，最新可撤销批次显示撤销（`undo`）。
  - `SettingsTab`：`/toggle` 四个开关（`enabled`/`autoMemoryEnabled`/`autoDreamEnabled`/`autoExtract`）、只读展示 `recallMode` 与 `subagentMemory`、rules 编辑、`/trash` `/backups` 懒加载 + `/restore`、记忆目录复制、使用情况一行。
- 记忆预览：内置的小型安全 Markdown 渲染器（标题/列表/代码块/引用/链接/粗斜体），不注入 HTML。
- 数据访问：统一 `fetch` + `x-cc-memory-token`；数据层（`normalize*`、`createBackend`）与 UI 分离；错误进 toast 或卡片文本，不炸 slot（外层还有 ViewBoundary）。
- 服务不可用或 token 已失效（401）时显示提示和刷新入口。插件或自动记忆关闭时，可从提示中开启。
- locale：`dsh-cc-dream-memory` 命名空间；客户端内联字典 en/zh 与 `locale/*.json` 一一对应（另有 `meta`）；测试会检查源码里每个字面量 `t('…')` 键在两种语言里都存在（键数随功能增长，写在这里的数字必然过时，故不再记录）。
- 测试钩子 `window.__CC_MEMORY_INTERNALS__`：数据层 normalize 函数 + UI 纯函数（`filterEntries`、`countByType`、`opKind`、`projectLabel`、`attentionCount`、`viaLabel`、`readinessText`）。

---

## 9. 配置参考（profile `cordis.patch.yml` 的 `cc-memory` 行）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件功能总开关（可被运行时 override 覆盖；不会阻止加载，便于从 UI 再开启） |
| `autoMemoryEnabled` | `true` | auto memory：注入 + 自动写入；`/memory on/off` 写这个 |
| `memoryRoot` | `''` | 记忆根目录，空 = `$DSH_HOME/cc-memory`；支持 `~/` |
| `recallMode` | `model` | 自动召回：`model`（唯一 selector）/ `off`；删除了 `lexical` 与旧 `autoRecall` 别名 |
| `recallProvider` / `recallModel` | `''` | selector 用的模型对；空 = 当前默认模型 |
| `recallTimeoutMs` / `recallMaxCandidates` | `4000` / `200` | selector 超时（超时静默空）/ manifest 最多候选条数 |
| `autoRecallMaxFiles` / `autoRecallMaxChars` | `3` / `3000` | 每条消息最多附加的记忆数 / 总字符数（硬预算） |
| `autoExtract` | `false` | turn/end 后自动抽取提案；只进 Inbox，人工 accept；默认关 |
| `autoExtractEveryTurns` | `3` | 每 N 个主线 turn 最多抽一次；本 turn 已写记忆则跳过 |
| `autoExtractMaxItems` / `autoExtractMaxChars` | `3` / `12000` | 单次提案上限 / 最近转写字符预算 |
| `autoExtractProvider` / `autoExtractModel` | `''` | 抽取用的模型对；空 = 当前默认模型 |
| `subagentMemory` | `off` | 子代理记忆唯一策略：`off`（不注入/不可写）/ `shared`（项目库读写）/ `own`（`agents/<preset>/memory`，只注入/只写自己） |
| `agentMemoryPresets` | `[]` | `own` 的 preset 白名单；空 = 任意有 preset 名的子代理 |
| `indexMaxLines` / `indexMaxBytes` | `200` / `25600` | 注入预算（官方 200 行/25KB） |
| `autoDreamEnabled` | `false` | 自动Dream |
| `minHours` / `minSessions` | `24` / `5` | 自动 dream 闸门 |
| `scanThrottleMs` / `lockTtlMs` | `600000` / `3600000` | 节流 / 锁 TTL |
| `dreamAnalyzerProvider` / `dreamAnalyzerModel` | `''` | 两项都填才指定模型；空则用宿主默认选择 |
| `dreamAllowDelete` | `true` | 允许删除（启用后仍只软删除到 `.trash/`；v11 默认开启） |
| `dreamInputMaxChars` | `96000` | 整理调用的会话字符预算 |
| `dreamMaxFileChars` / `dreamMaxToolChars` | `100000` / `4000` | 写入单文件正文上限 / 每块工具证据上限 |
| `dreamMapChunkChars` | `24000` | 收集阶段的默认分块大小；Dream 分析按自己的单元大小切分 |
| `dreamAnalyzerMaxTokens` | `8192` | Dream 分析单元的初始输出预算 |
| `tools` / `commands` / `ui` | `true` | 各面开关 |
| `contextOrder` | `850` | 注入 context 排序 |
| `maxContentBytes` | `131072` | 单条记忆正文上限 |
| `rulesMaxChars` | `8000` | 规则文件上限 |
| `secretScan` | `warn` | 写记忆/dream 写文件/rules 前的机密扫描：`warn`/`deny`/`off` |
| `dreamMaxTotalTokens` | `0` | dream 单次 total token 软上限（0=off）；超限 `costExceeded` 告警但照常应用 |

旧 profile 中完整的 `dreamProvider` / `dreamModel` 在加载时转成分析器配置。已填写的完整分析器配置优先。

运行时开关（不重启）：`<memoryRoot>/.plugin-state.json` 里的 `enabled/autoMemoryEnabled/autoDreamEnabled`；`/memory plugin on|off`、`/memory on|off`、UI pills 都会写这里。

---

## 10. DSH 侧如何使用（安装 / 启用 / 日常 / 更新 / 回滚）

### 10.1 安装（二选一）

- **插件管理器**（推荐）：`plugin_manager` `action=install_bundle target=<插件绝对路径>`。安装器会写 profile `package.json`、软链 `node_modules`、把 bundle 加入 `dsh.profile.bundles`，并尝试 HMR 激活（返回 `application: applied`）。
- **手工**（不推荐）：在 profile `cordis.patch.yml` 加：

```yaml
- insert:
    - id: cc-dream-memory
      name: dsh-cc-dream-memory
      config:
        autoDreamEnabled: false
```

启用后：新会话自动生效；已存在会话通过插件重载生效。

### 10.2 验证安装

- 会话工具表出现 4 个 `memory_*` 工具；
- 系统提示出现 `<system-reminder>Auto memory is enabled…` + `Rules:` + `<index>`；
- `/memory status`、`/api/cc-memory/status` 与 UI 返回 `version/health/config`；
- 会话标题栏出现「记忆」标签，输入框下方出现状态 chip。

### 10.3 日常使用

| 想做什么 | 方式 |
|---|---|
| 让模型记住 | 直接说「记住…」或「remember that…」（模型按规则调用 `memory_save`） |
| 手动记一条 | `/remember [--type=…] [--scope=…] <内容>` |
| 看/管记忆 | 「记忆」页；或 `/memory`、`/memory list`、`/memory show <file>`、`/memory index` |
| 改「什么值得记」规则 | 「记忆」页 Rules 卡（保存 project/global/重置）；或 `/memory rules`、`/memory rules reset`；或直接编辑 `<projectDir>/memory-rules.md` / `~/.dsh/cc-memory/memory-rules.md` |
| 关/开自动记忆 | 「记忆」页 auto memory pill；`/memory on` / `/memory off` |
| 关/开整个插件功能 | 「记忆」页 plugin pill；`/memory plugin on` / `/memory plugin off`（随时可开回） |
| 开自动Dream | `/memory dream on`（或配置 `autoDreamEnabled:true`），之后满足 24h+5 sessions 闸门自动跑 |
| 手动Dream | 「记忆」页 Estimate / Start；`/memory dream run [--focus]` |
| 切换 Dream | 副本就绪后选择切换或丢弃，也可用 `/memory dream switch\|discard`。 |
| 删一条记忆 | `/memory delete <file>`（软删除到 `.trash/`，需 `dreamAllowDelete:true`） |

### 10.4 更新（不炸的前提）

| 改动 | 生效方式 |
|---|---|
| 只改 `client.js` / `locale/*.json` | 刷新页面（客户端产物带 revision） |
| 改 Host 代码（`index.js`、`src/*.js`） | 重载该行：`plugin_manager set_plugin include:cc-dream-memory enabled=false → true`，或重启 App；数据不受影响 |
| 完整升级 | `plugin_manager install_bundle <路径>`；版本见 `package.json`，变更见 `CHANGELOG.md` |
| 更新后自检 | `/memory status` / `/api/cc-memory/status` 的 `version/health`；UI Memory 页 |

### 10.5 回滚 / 恢复 / 卸载

- **卸载**：Plugin Manager 移除 bundle（或 `remove_bundle`）→ 插件停止加载，**`~/.dsh/cc-memory` 数据保留**。
- **恢复默认开关**：删除 `~/.dsh/cc-memory/.plugin-state.json`。
- **恢复默认规则**：删除 `<projectDir>/memory-rules.md` 与/或 `~/.dsh/cc-memory/memory-rules.md`。
- **重置 dream 状态**：删除 `<projectDir>/.state.json`（会丢 dream 节奏/提案指针，不丢记忆）。
- **找回误删记忆**：`.trash/<ts>/` 里 move 回 `memory/` 并补索引；或从 `.dreams/<ts>/` 备份整体恢复。
- **清空记忆**：删除整个 `~/.dsh/cc-memory`（建议先备份 `.dreams` 与 `.trash`）。

### 10.6 排障速查

| 现象 | 排查 |
|---|---|
| 没有注入 | 查 `/memory status` 的开关和 `health.warnings`；用 `/memory refresh` 重建当前会话的快照 |
| 没有 `memory_*` 工具 | 插件行是否 active；`inject` 硬依赖 `tools/systemPrompt` 是否存在 |
| UI 显示服务不可用 | 刷新页面，确认插件已启用，并检查 `GET /api/cc-memory/bridge` 的响应状态。 |
| `/api/cc-memory/*` 401 | 刷新页面以重新通过 `/bridge` 获取 token。 |
| dream 不动 | `autoDreamEnabled`、闸门（24h/5 sessions/节流/退避）、是否有 `shadowPending` 阻止新跑；看 `.dream-log.md`/`state.lastError` |
| 索引有孤儿/悬空 | `health.warnings` 会提示；跑一次 dream apply 自动 `reconcileIndex` |

---

## 11. 安全、成本与已知限制

- **安全（v6/v7）**：HTTP 仅接受 loopback 来源 + POST Origin 校验 + token 持久化 `.api-token`（0600）；token 常量时间比对；API 不写会话日志；rules 写入审计 `.memory-rules.log`；**v7 起写入/dream/rules 前做机密扫描**（8 类规则 + 高熵 base64，`secretScan: warn|deny|off`，默认 warn，excerpt≤12 字符）。记忆是明文 Markdown，仍**无 HTTP 限流**。
- **成本（v8）**：plan/changelog/state/metrics 记录 `durationMs/inputChars/outputChars/usage`（usage 由 `ctx.llm.stream` 提供时）；`dreamMaxTotalTokens` 软上限超限告警（默认 off）；UI 展示最近成本与徽标；仍无硬性成本阻断。
- **已知限制**：
  1. 会话中的新写入在下个会话创建快照时可见。可用 `/memory refresh` 刷新当前快照。
  2. 非 git 工作区（如 default-workspace）按工作区聚合记忆，无关会话会混用同一份项目记忆（项目身份路线图）。
  3. 指标是“使用量/接受率”而非“回答质量价值”，仍需 A/B 或人工评估；neverRead 只反映当前索引文件的读计数。
  4. 自动召回由模型选取，结果可能漏掉相关笔记。证据检查核对引用是否存在，仍需审阅推断。
  5. 子代理不继承主会话记忆（`subagentMemory` 默认 `off`；`shared` 才注入），fork 子会话按父会话项目解析。
  6. 跨平台：Windows 路径/rename 重试专门处理过；v7 起 CI 覆盖 Windows+Ubuntu（Node 22/24），但仍无真实宿主 E2E 与浏览器 E2E。
  7. 切换只影响「这次真正改过 / 新建 / 删除」的文件：备份在 `.dreams/<ts>/memory`，`meta.json` 记每个文件切换后的哈希，undo 只动 `rewritten` 与 `created`；被切换改过的文件若之后又被人改过，undo 返回 `conflict` 并整次不执行。切换和丢弃均处理整份副本。估算返回 `inputId` 与 `ranges`，启动时提交它们：期间长出来的会话不进入本次运行，钉死范围内被改写则返回 `stale-input` 且不调模型。
  8. 机密扫描是启发式；无 HTTP 限流；本机多用户未隔离。
  9. 工作目录解析不到时（v6 起）该会话直接禁用记忆功能（工具返回 `no-project`）。

---

## 12. 扩展指南（二次开发）

- **加一个工具**：`src/tools.js` 里 `register({name, description, parameters, output, execute})`；execute 里 `projectFor(runtime, exec)` 拿上下文；写后 `invalidate(runtime, agent)`。
- **加一个命令**：`src/commands.js` 的 `register({name, description, input, handler})`；解析用 `parseCommandLine`。
- **加 UI 卡片/按钮**：`client.js` 组件内新增；数据走现有 `/status` 字段或新端点（`src/http.js` 加 route + 客户端 request）。
- **改 dream 行为**：analyzer 提示词在 `src/dream-analyzer.js`，宿主校验在 `src/dream-verifier.js`，合并规则在 `src/dream-merge.js`；校验/应用/回滚在 `src/dream.js`（`validateDreamPlan`、`executePlan`、`handleApplyFailure`）；运行与断点在 `src/dream-pipeline.js` / `src/dream-run.js`；输入收集在 `src/dream-input.js`，转写在 `src/dream-session-text.js`，证据在 `src/dream-evidence.js`。
- **加记忆类型**：`MEMORY_TYPES`（store.js）+ `rules.js` 默认规则 + 前端类型色点/locale。
- **加配置项**：`config.js` 的 `DEFAULTS` + `resolveConfig` 校验；需要时在 `http.js` 的 `CONFIG_FIELDS`、`tools.js` 的 `configSummary`、commands 状态里暴露。

---

## 13. 版本、测试与验证

- 版本：`package.json` **0.11.0**；语义化 + `CHANGELOG.md`。
- 测试：`test/*.test.mjs` 当前 **601 条断言 / 80 个文件**，`node --test "test/*.test.mjs"`；`node scripts/verify.mjs` PASS。只在 Windows + Node 24 上跑过，Ubuntu 与 Node 22 待 CI 确认。
- **0.11.0 待真机确认**：新 Dream 和自动召回用真实日志 + 脚本模型回放过，但未在真实宿主内运行，也未跑真实模型评测。
- 覆盖率（v7 前基线）：all files ≈ 79% line / 62% branch / 82% funcs；v7 起 `client.js` 已有入库测试（vm + React shim），scheduler/commands/tools 分支覆盖仍偏低。
- 真实宿主已验收（v4/v5/v6）：注入/冻结/中文名/长文件截断/subagent 过滤/dry-run→applyLastPlan/apply 回滚/索引一致性/UI 开关与 rules 编辑；Host 重启后自动加载且数据延续；v6 已在真实宿主确认 v0.5.0 + token 持久化。
- **v7 待真机确认**：客户端新增的 diff/恢复 UI 需页面刷新后目视确认（仓库内已有 vm+shim 测试，但不是浏览器 E2E）。

## 14. 文档与版本

- 本文件只描述**当前行为**（当前版本）；每轮修复与版本历史见 [CHANGELOG.md](CHANGELOG.md)。
- 已知边界：`.write.lock` 与 `.consolidate-lock` 都是 **best-effort 跨进程锁**，不是严格 mutex（等待 2s 超时后降级运行、30s TTL 可接管但会先检查持有进程是否存活）；模型覆写保留历史（`.history/`）；dream apply 的失败回滚只处理 touched 文件并按应用后哈希校验，不丢弃并发写入。


## 0.11.1 可靠性边界修订

模型 save/update 的执行边界统一到 write-review.js；底层 policy 提供按语句的词面评估，工具边界将冲突放入待审队列，不将 advisory 当成写入授权。更新与待审批准使用存储写锁内的 SHA-256 比较保护并发编辑。

Dream 的 evidence 使用操作级引用；兼容旧 `{statement,quote}`，来源位置由宿主输入确定，包含短会话和长会话笔记的 sessionId/seq。检查证明引用存在，不证明语义蕴含。自动 Dream 的语义修改先进入提案；纯机械修改才直接应用。既有用户类原句可以搬运，改写转审阅；每次预览列出正文删行，已有提案阻止后续生成覆盖。`POST /dream {action:'estimate'}` 和 `/memory dream estimate` 只读估算输入、不调用模型；界面在付费 dry-run 前展示估算并要求确认。

## 0.12.1 首轮可见性与可续跑 Dream

- **显式写入进首轮**：`/remember`、面板保存、`/memory edit`（`src/status.js` 的 `writeFile`）都是用户亲手提交的字节，写入成功后由 `recordUserConfirmedSave` 统一记一次写入指标并把写入时的确切版本记进台账（`source: 'user-explicit'`）；`memory_save`、`memory_update` 在用户原话通过 `verifyUserEvidence` 后走同一台账，人工批准的待审写入也一样。台账按**字段**记录名称、简介、正文三份指纹（`fieldHashes`，正文忽略宿主标记），只覆盖当初写入的字节；只有整页哈希的旧记录不能说明用户确认过哪条简介，首轮一律只显示名称。读-改-写按台账文件串行，两个并发的核验都会留下。工具自己写的 STATUS/VERIFIED 不能升级任何页面；模型推断的写入仍先进待审队列。
- **首轮索引取自 `MEMORY.md` 原文**：注入 `store.injectedIndex('project')` 的头部，默认以 200 行和 25 KB 中先到的限制为准。笔记正文可用 `memory_read` 按需打开。
- **写入回执带版本与核验状态**：`memory_save`/`memory_update`/`/remember`/面板保存都返回 `version`（内容指纹，无变更时不翻新）与 `verification: 'recorded'|'pending'`；`pending` 表示字节已落盘但台账没更新，首轮索引暂时只列名称，无需重写。
- **Dream 运行可观测、可续跑**：每次运行在 `.dreams/<runId>/` 先落 `manifest.json`（runId、项目、模型、输入会话与单元范围、计数、用量、错误、状态），每个单元通过解析与证据校验后写 `analysis/<session>/<unitId>.json`。同一项目同时只有一个 worker，锁由 runId 持有并在每个单元后续期；`/memory dream status|cancel|resume` 与 `POST /dream {action:'status'|'cancel'|'resume', runId}` 操作同一个运行。重启、取消或失败后 `resume` 只补齐缺失单元，已完成单元不再调用模型。
- **输入按单元切分，不再静默截断**：v2 路径按 `unitChars`（24k）切分会话，分析调用次数、单会话字符上限与 claim/patch 上限不再截断输入；一次输出被 max-tokens 截断时把该单元对半拆开重试，拆不开才记为失败并保留范围与原因。
- **默认由宿主合并逐条结论（0.12.2）**：默认路径不再调用终场 organizer（也不再有 organizer 可选）。`dream-merge.js` 用 analyzer 已核验的 claims/verify 直接构造页面：新事实追加一行带 `^[source#seq, date]` 的引用行；`contradicts` 命中唯一一行时替换它、写入 `STATUS: current` 并把旧值记入 `## History`；没有 verdict 但页面已有一行同对象不同值的唯一测量时，同样按纠正处理；同一事实跨会话去重成一行多引用；没有 claim 命中的页面完全不动。对象/量纲对不上、命中多行、行已消失或低置信的 claim 仍进 `plan.review` 不写盘，但**当页面里留着具体旧值时，冲突会以 `- CONFLICT: "<旧>" vs "<新>" — the sources disagree; a person has to pick one. ^[cite]` 写进页面**，让人看得见分歧（标记行不带 Claim、不参与证据校验，重复运行不会叠加）。索引是**扁平**列表（`- [名字](文件) — 说明`），与 Claude Code 的 `MEMORY.md` 一致；`Related:` 行由宿主追加。analyzer 可以要求 `retire: [{file, target}]`：目标必须是本轮存在的页面、该页本轮没被改写、且不能自己搬到自己，满足时宿主删除该页并在索引留 `- [名字](旧文件) — MOVED TO [[目标]]`，否则只进 review。整库重写、页面合并与 SKILL 已被移除：重复页面靠写入时去重或手动 `/memory merge`。
- **应用前比对基线哈希**：claim 合并产出的 write 操作带 `baseHash`；`DreamEngine.executePlan` 在备份前重读每个目标文件，哈希不一致直接返回 `conflict`，运行记为失败（可 `resume`），不会覆盖审阅期间的用户编辑。
- **Wiki 构建不再静默截断（0.12.2）**：`splitPageBody` 按行/标题边界把超过 `wikiMaxPageChars` 的页面拆成 `x.md`/`x-2.md`…（`normalizeWikiWrites` 不再 `slice`）；organizer 超出 `wikiOrganizerMaxChars` 时在提示词中列出被略过的页面并写入 `manifest.warnings`，这些页面保持不变；extractor 丢弃的 claim 数也进警告。`POST /wiki {action:'build'}` 在正式发布成功后调用 `invalidateAllInjections('wiki-build')`，与命令路径一致；dry-run 与失败不刷新。
- **宿主收口 Wiki 的主题、链接与冲突（0.12.3）**：发布前 `mergeWikiTopics` 把名字归一后相同的页面合成一页（逐行去重，保留每一行的引用与较全的描述），`repairWikiLinks` 把只能指向一页的悬空 `[[链接]]` 改到该页，无法唯一确定时保留并写入警告。同一句话在不同来源里出现不同数字时两条都保留，较旧的一条之后插入 `> 上一条数值已被较新的来源取代（<新日期>：<新值>）`（`markSupersededFacts`）；标记行不带引用、不参与证据校验。`manifest.pages.merged`、`manifest.links.repaired`、`manifest.superseded` 与 `manifest.conflicts` 记录本轮结果。查询侧 `validateWikiAnswer` 拒绝只引用被取代行的答案（要求同时说出新值与日期），`wikiQueryPrompt` 要求回答冲突时说明两条来源及哪条更新。
- **构建标识与已挂载能力（0.12.3）**：`/status` 返回 `build`（`src/build-id.js` 对 package.json、index.js、client.js、cordis.patch.yml 及 status/http/inject/dream-run/wiki-build 九个文件取 sha256，汇总为 12 位 id，并附 `packageVersion`、安装路径与逐文件摘要）和 `capabilities`（`dreamPipeline`、`dreamRuns`、`claimMerge`、`wiki`、`explicitSaveLedger`）。面板显示构建 id；`UI_API` 升到 3，新面板连旧 Host 时给出升级提示。
- **长文档提取可以中断续做（0.12.3）**：`src/wiki-build.js` 在 extract 阶段把每份文档按 `wikiChunkChars` 分段，每段完成后将 `{digest, claims}` 写入当前代的 `.claims/<sourceId>.parts.json`（同目录，键为整份文档的 `sha256`）；重跑时只对摘要不匹配的分段调用 extractor，`manifest.stages[extract].partsReused` 记录复用段数。整份文档完成后再写 `.claims/<sourceId>.json`（供后续构建按整份摘要复用）并删除分段进度。失败的构建不会切换 GENERATION，已写入的分段进度留在当前代目录，下一次构建直接接上。

## 0.12.0 Dream v2

- **Dream v2**（默认且唯一路径）：`dream-pipeline.js` 导出 transcript → 按单元切分 → analyzer（`dream-analyzer.js`）→ host 校验（`dream-verifier.js`）→ 宿主合并（`dream-merge.js`）→ 生成副本，待用户切换时备份，切换后可撤销。运行状态与单元记录写在 `.dreams/<runId>/`（`dream-run.js`），`manifest.json` 记录 expected/processed/failed/partial 与每单元范围；不完整批次不移动水位线。配置：`dreamAnalyzerConcurrency`、`dreamAnalyzerProvider/Model`、`dreamAnalyzerMaxTokens`。
- **应用前比对基线哈希**：见 0.12.1；`dream-pipeline` 把 executePlan 的 `conflict` 返回当失败处理（可 resume）。
- **旧引擎已移除**：`DreamEngine.run`/`estimate`、`dream-prompt.js`、`dream-map.js`、`dream-organizer.js` 及 `dreamPipeline`、`dreamOrganizerMode`、`--pipeline`、`--maintenance` 都不再存在。
- **共享 wiki 格式**：`wiki-core.js` 提供 `[[slug]]`、citation、index、SKILL、validation；`wiki-store.js` 提供独立 `wiki/` 根、原子写、search、link audit、build manifest。`memory/` 继续由 `MemoryStore` 管理，新增 `SKILL.md`（保留名）。
- **Knowledge Wiki build**：`wiki-build.js` 支持 `.txt/.md` 文档 → source manifest → extractor → analyzer → organizer → `_index.md`/`SKILL.md`；入口 `/memory wiki build <dir>` 与 `POST /api/cc-memory/wiki`。PDF/Office 需先转文本。
- **Read-only query**：`wiki-query.js` + `wiki-tools.js` 注册 `wiki_search`、`wiki_read`、`wiki_links`、`wiki_answer`；没有任何 wiki 写工具，`wiki_answer` 由 host 校验 page/quote。
- **注入**：存在 `memory/SKILL.md` 时注入前 24 行；存在 `wiki/_index.md` 时注入一行只读 wiki 提示。UI 仍冻结。

## 未发布：移除 Knowledge Wiki

- 删除 `wiki-build.js`、`wiki-query.js`、`wiki-store.js`、`wiki-tools.js`，以及四个只读 wiki 工具、`/memory wiki` 命令、`POST /wiki` 接口、首轮的 wiki 提示和记忆页的 Wiki 标签（UI-FREEZE 变更）。所有 `wiki*` 配置项一并移除；`paths` 不再给出 `wikiDir` 等路径。
- `wiki-core.js` 保留（`indexText`/`citationToken`/`buildIndex` 等纯函数仍被 Dream 书写路径使用）；wiki 构建、查询与工具已删除。
- 下文 0.12.x 小节里关于 Wiki 的条目只是历史记录，不再描述当前行为。
