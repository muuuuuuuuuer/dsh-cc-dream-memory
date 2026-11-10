# dsh-cc-dream-memory 架构与 DSH 集成手册

- 版本：**0.11.1**（2026-11-08）
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
│  │   ├─ dream.js       DreamEngine：收集→分块分析→整理→校验→证据→备份→应用   │   │
│  │   ├─ dream-*.js     转写 / 收集 / 分块分析 / 证据检查 / 提示词            │   │
│  │   ├─ recall.js      按用户消息附加相关记忆（agent/pre-step）              │   │
│  │   ├─ rules.js      可编辑注入规则（project/global/default 优先级）        │   │
│  │   ├─ http.js       静默 HTTP API（/api/cc-memory/* + token）             │   │
│  │   ├─ paths.js      项目身份（git root→slug）与全部路径                    │   │
│  │   └─ meta.js       VERSION / DATA_SCHEMA / health                       │   │
│  └───┬────────────────────────────────────────────────────────────────────┘   │
│      │ webServer.register(prefix) + index-inject(注入 token)                       │
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
| `src/store.js` | 记忆文件 CRUD、索引维护、预算截断、unicode 文件名、冲突后缀、软删除、索引一致性、中文 bigram 检索 | `MemoryStore`, `MEMORY_TYPES`, `slugify` |
| `src/state.js` | 项目状态 JSON：lastDreamAt、sessionsSince、dreamProcessedSessions（水位线）、lastPlanPath、pendingProposal、连续失败数 | `ProjectState` |
| `src/inject.js` | 每 agent 注册 `systemPrompt.context`；会话级冻结/live 两种模式；compaction 刷新；子会话开关 | `registerInjection`, `buildInjectionText`, `CONTEXT_NAME` |
| `src/write-review.js` | 模型写入的共用边界：低置信/confirm/冲突待审，force 仅绕过重复 | `reviewWrite`, `memoryHash` |
| `src/tools.js` | 4 个 `memory_*` 工具（JSON Schema + output.render）；关闭态门控 | `registerTools` |
| `src/commands.js` | `/memory` 子命令族、`/remember`；纯函数解析器；JSON 输出 | `registerCommands`, `parseCommandLine`, `parseRememberInput` |
| `src/scheduler.js` | 监听 `session/event` 的 `turn/end`；auto dream 闸门（含退避）；跳过 subagent 会话 | `registerScheduler` |
| `src/dream.js` | DreamEngine：闸门→锁→收集→分块分析→整理→JSON 解析→计划校验→证据检查→备份→应用/review/dry-run→回滚→changelog→state | `DreamEngine`, `validateDreamPlan`, `extractJsonPlan` |
| `src/dream-input.js` | **纯读取**：记忆快照 + 最近主线会话（短会话全文、长会话切块）+ `reads`；按水位线只读新增部分；截断文件标记；subagent/探针过滤 | `gatherDreamInput`, `pruneProbeSessions` |
| `src/dream-session-text.js` | 会话事件 → 带来源标签的转写：过滤宿主注入、识别 `[user-pasted]`、工具调用/结果配对、日期标记、转义伪造的标签行、按字符切块 | `buildSessionTranscript`, `chunkTranscript`, `extractSessionText`, `isProbeSession` |
| `src/dream-map.js` | 长会话分块分析：每块一次模型调用，引用回原文核对，按预算/token/首次失败停止；记录读到的 `seq` | `analyzeLongSessions`, `plannedAnalysisChars` |
| `src/dream-evidence.js` | 写入证据检查、过度收缩检查、记忆中失效路径的收集 | `checkPlanEvidence`, `buildEvidenceCorpus`, `collectStaleReferences` |
| `src/dream-prompt.js` | 整理调用的 system prompt（来源标签、什么值得记、证据要求）+ user prompt 构造 | `DREAM_SYSTEM_PROMPT`, `buildDreamPrompt` |
| `src/recall.js` | 自动召回：词面选择（纯函数）+ `agent/pre-step` 挂载；每条每会话一次 | `selectRecall`, `buildRecallText`, `attachRecall`, `RECALL_SOURCE_KIND` |
| `src/rules.js` | 注入规则文件读取（project > global > default）、保存/清除、8000 字符上限 | `DEFAULT_RULES`, `loadRules`, `saveRulesFile` |
| `src/http.js` | 静默 HTTP API：token 鉴权/持久化、loopback+Origin 校验、8 端点、plugin-disabled 门控 | `registerHttpApi`, `createHttpHandler`, `API_PREFIX` |
| `src/paths.js` | 项目根探测（向上找 `.git` 30 层）、slug（镜像 `~/.dsh/sessions` 命名）、全部路径 | `buildPaths`, `projectSlug`, `resolveProjectRoot` |
| `src/meta.js` | 版本（读 package.json）、`DATA_SCHEMA`、健康检查 | `VERSION`, `DATA_SCHEMA`, `buildHealth` |
| `src/frontmatter.js` | 无第三方 YAML 的 frontmatter 解析/序列化（v7 支持可选 provenance 字段） | `parseFrontmatter`, `stringifyFrontmatter` |
| `src/status.js` | **v7 共用服务层**：HTTP 与 commands 的唯一状态来源；status/file/rules/toggle/dream/delete/backups/trash/restore/metrics | `createStatusService` |
| `src/secrets.js` | **v7 机密扫描**：8 类规则 + 高熵 base64；warn/deny/off | `scanSecrets`, `secretScanMode`, `secretWarnings` |
| `src/metrics.js` | **v8 效果指标**：`.metrics.json`（注入/读写/search/dream 接受率/成本，跨进程合并） | `readMetrics`, `record*`, `metricsSummary` |
| `src/policy.js` | **v9 写入策略**：相似度、同主题极性冲突、低置信判定（allow/duplicate/possible-duplicate/conflict/low-confidence） | `textSimilarity`, `detectConflict`, `evaluateWrite` |
| `src/pending-writes.js` | **v9 待审写入队列**：`.pending/writes/<id>.json` list/queue/approve/reject（approve 走正常 store 写入） | `listPendingWrites`, `queuePendingWrite`, `approvePendingWrite` |
| `src/identity.js` | **v9 项目身份**：config.projectId > workspace 标记 > git root > workspace | `resolveIdentity` |
| `src/readiness.js` | **v9 dream 就绪/健康度**：闸门与 nextEligibleAt、0–100 健康分与 suggestions、pending TTL 归档 | `dreamReadiness`, `memoryHealth`, `expireStaleProposal` |
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
├── user/memory/                          # 可选：跨项目 user scope（userMemoryEnabled）
│   └── MEMORY.md
└── projects/<project-slug>/              # slug 形如 --C-Users-me-repo--
    ├── memory/                           # ★ 只有人类可读的记忆文件
    │   ├── MEMORY.md                     # 索引：一行一条 `- [name](file) — description`
    │   ├── user_user_language.md         # topic 文件：frontmatter + 正文
    │   └── ...
    ├── memory-rules.md                   # 可选：项目级注入规则覆盖
    ├── .memory-rules.log                 # rules 变更审计（scope/source/bytes/sha256）
    ├── .state.json                       # dream 节奏/待审提案/lastPlan/成本摘要
    ├── .metrics.json                     # v8 效果指标（注入/读写/search/dream/成本，跨进程合并）
    ├── .dream-log.md                     # 每次 dream 的 changelog（追加）
    ├── .consolidate-lock                 # dream 并发锁（PID + startedAt，TTL 1h）
    ├── .dreams/<ts>/                     # dry-run 的 plan.json / apply 前的完整备份
    ├── .pending/<ts>.json                # review 模式待审提案
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
- 索引预算：注入时取 **前 200 行 / 前 25600 字节**（先到者）；超限时保留最早 + 最新条目，并注入 `<budget-notice>`；达到 80% 时提前提醒。
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
  "pendingProposal": "", "lastPlanPath": "", "consecutiveFailures": 0
}
```

`dreamProcessedSessions` 是水位线：`seq` 是已读到的最后一个事件，`partial` 表示还没读完。只有计划应用成功才写入。

损坏/未知字段：回退默认、忽略未知；`DATA_SCHEMA = 1` 与插件版本解耦。

### dream 计划 JSON（plan.json / pending proposal）

```json
{
  "createdAt": "...", "trigger": "manual|auto", "mode": "apply|review", "dryRun": true,
  "applied": false, "provider": "…", "model": "…",
  "summary": "一句话", "notes": "…",
  "operations": [
    { "op": "write", "scope": "project", "type": "user",
      "file": "user_role.md", "name": "user_role", "description": "…", "body": "完整正文",
      "evidence": ["从原文照抄的短引用"] },
    { "op": "delete", "scope": "project", "file": "old.md", "reason": "…" },
    { "op": "index", "scope": "project", "content": "- [..](..) — ..\n" }
  ],
  "dropped": ["operation #N: 原因"],
  "truncatedFiles": ["reference_long.md"],
  "sessions": ["session-…"],
  "reads": [{ "id": "session-…", "seq": 412, "complete": false }],
  "droppedSessions": ["探针会话，读过且无需再读"],
  "input": { "chars": 32717, "truncated": true, "files": 6, "sessions": 8,
             "skippedSessions": ["…"], "errors": [] }
}
```

应用规则：`write` 走 `store.writeRawEntry`；`delete` 仅在 `dreamAllowDelete` 时走 `store.trashEntry`（软删除）；`index` 走 `store.writeIndex`，随后 `reconcileIndex()` 修补孤儿/悬空行。

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
- `commands` / `agents` / `workingDirectory` / `webServer` 全部 `ctx.get(name)` 可选解析，缺失时各自降级（无命令 / 无 per-agent 缓存 / cwd 回退 / UI 降级命令模式）。
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
| `ctx.on('webserver/index-inject', (table, peer) => …)` | 向 index 注入结构化 `{kind:'global', name:'__CC_MEMORY_API__', value:{base:'/api/cc-memory', token}}`（仅 owner Peer；web fallback 渲染、桌面 Electron boot 前应用同一 row） | 让 Web/桌面客户端拿到 API 地址与进程内随机 token；liveshare viewer 不注入 |
| `ctx.agents` / `workingDirectory.ensure(agent)` | 会话 ↔ 工作目录解析 | 决定项目记忆目录 |
| `ctx.sessionQuery` | dream gather：`filterSessions` / `readSession` | 只读历史 transcript |
| `ctx.llm.stream` | 整理调用 `cc-memory-dream` + 长会话分块分析 `cc-memory-dream-analysis` | 只产出计划或笔记，不直接写盘 |
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
            │    store.injectedIndex('project')      # 前 200 行/25KB
            │    runtime.rulesFor(ctx)               # project > global > 默认
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

**冻结语义（`injectionMode:'session'` 默认）**

| 事件 | 对注入文本的影响 |
|---|---|
| 本会话 `memory_save` / dream | 不变（模型已在对话历史里知道） |
| 其他会话写入 | 不变（下个会话生效） |
| 30s 定时器 | 只补建“尚未构建”的会话，已冻结的不动 |
| `compaction/*` 会话事件 | **刷新一次**（前缀本来就要重算） |
| 配置/规则显式变更（`invalidateInjection(reason='config'|'rules')`） | 强制刷新 |
| `injectionMode:'live'` | 旧行为：每次变化/定时器都刷新 |

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

旧版通过 `ctx.remote.commands.execute` 取数已移除；仅在 `window.__CC_MEMORY_API__` 缺失时降级为命令模式（页面有 banner 提示）。

### 5.5 自动召回

```
agent/pre-step（异步瀑布）
  ├─ 先 await next()，拿到本步决策；被拒绝的步骤原样返回
  ├─ 取本步消息里用户手打的文本（source.kind 为空或 'user'）；没有就什么也不做
  ├─ selectRecall：与索引的 name/description 做词面匹配
  │     通常需 2 个独立命中（user 类 3 个），连续重叠中文 bigram 合为一组；名称中的具体词或连续强短语可触发普通条目
  │     超过 400 字符的长消息仍要求覆盖率 ≥ 0.4；用户空间启用后同时检索并以 scope:file 去重
  │     本会话已附加过的不再附加；压缩后清空重新计算
  └─ 追加 {source.kind:'plugin:cc-memory-recall'} 消息（标明是背景、可能过时）
```

不调模型，失败不影响步骤。Dream 的转写按 `source.kind` 过滤掉这条消息，所以召回内容不会被当成用户的话再写回记忆。计数在 `/memory metrics`。

---

## 6. Dreaming 详细流程

### 6.1 触发与闸门

- **手动**：`/memory dream run [--dry-run]`、UI 按钮 → `force=true`，仍保留 enabled、pending-proposal 与 lock 检查。
- **自动**：`session/event` 的 `turn/end` → `scheduler.maybeAutoDream()`：

```
enabled && autoMemoryEnabled && autoDreamEnabled
  → 无 pendingProposal
  → 距 lastScanAt ≥ scanThrottleMs（默认 10min）
  → 距 lastDreamAt ≥ minHours（默认 24h）
  → 连续失败退避：min(scanThrottleMs·2^failures, 6h)
  → sessionsSince（主线、去重）≥ minSessions（默认 5）
  → 拿到 .consolidate-lock（PID+TTL 1h）
```

`sessionsSince` 只记录**主线会话**；`parentSession` / `origin:'subagent'` 的 teammate 会话直接跳过（不把 Lead 指令误当用户偏好）。

### 6.2 执行管线

```
DreamEngine.run({force, dryRun, trigger, noSessions, focus})
 1) 闸门 + 锁（open '.consolidate-lock','wx'；过期接管；失败回滚 mtime）
 2) gatherDreamInput()：纯读取，不写 state
      memory: MEMORY.md + topic 文件（每文件 ≤ dreamMaxFileChars=20000，超限 → head/tail
              截断并记入 truncatedFiles，prompt 标记禁写）；最多占 dreamInputMaxChars 的 70%
      sessions: state.sessionsSince 优先，不够时用 sessionQuery.filterSessions(cwd) 补齐，
              最多 sessionLookback=8 个主线会话；按水位线只读 seq 之后的事件；
              转写 ≤ dreamMaxSessionChars → 整段，并记 reads[{seq,complete:true}]
              否则 → chunkTranscript(dreamMapChunkChars)，留给下一步
              首次读取没有人类发言或只有探针 → 跳过（进 droppedSessions）
 3) 失效引用：collectStaleReferences 找出记忆里已不存在的路径，提示模型
 4) 预检成本：包含计划中的分块分析；block 模式超限 → 不调模型
 5) analyzeLongSessions()：每块一次调用（purpose 'cc-memory-dream-analysis'）
      笔记的 quote 在该块原文中核对，未命中丢弃；按命中位置标注 source 和日期
      受 dreamMapMaxChunks、token 上限约束，首次失败即停；已读部分写 reads[{seq,complete:false}]
      一块都没读到的长会话不出现在 prompt，也不移动水位线
 6) 整理调用：ctx.llm.stream({ system:DREAM_SYSTEM_PROMPT, messages:[user prompt],
              maxTokens:16384, purpose:'cc-memory-dream' })
      → 若 finish=max-tokens，自动用双倍预算（≤32768）重试一次
 7) extractJsonPlan()：支持 ```json 代码块/裸对象；失败 → 释放锁 + markDreamFailed
 8) validateDreamPlan(plan,{config,existingFiles,truncatedFiles})：
      op 数 ≤ dreamMaxOps=40；路径白名单 .md + scope 内；type 枚举；
      body ≤ maxContentBytes=128KB 且 ≤ dreamMaxFileChars，避免下轮无法完整读取；delete 需 dreamAllowDelete；truncated 文件拒绝 write/delete；同文件不能重复变更
 9) 机密扫描 + checkPlanEvidence()：
      读过会话时，新事实须有操作级 evidence（quote 归一化后 ≥6 字符，能在本轮输入中找到）；
      新 user/feedback 事实须引用 [user]，完整既有用户类原句可跨文件搬运；仅基于原记忆的用户类改写即使手动也转待审；
      任意写入被过滤则移除破坏性删除和索引操作，不推进该批会话水位线；预览列出所有正文删行；
      ≥400 字符的文件缩到一半以下：保留操作并警告；auto 进入 review，不推进水位线
10) 备份：<projectDir>/.dreams/<ts>/ （apply 时复制全部 memory 文件）
11) 分支：
      dry-run → 只写 plan.json（applied:false，含 reads/droppedSessions），state.setLastPlan(path)
      review  → 写 .pending/<ts>.json，setPendingProposal，不 done、不清 sessions
      apply   → 逐 op 执行 → writeIndex → reconcileIndex() → changelog → markDreamDone
                → 没有被过滤操作时 clearSessions(sessions+droppedSessions,{reads})   # 水位线只在这里移动
      apply-ops → 只应用选中项；clearSessions 不带 reads，水位线不动
12) 失败：executePlan 内捕获 → 按应用后哈希选择性回滚（并发修改的文件保留并报 conflicts）
           → markDreamFailed（consecutiveFailures+1）→ 返回 {applied:false, rolledBack:true}
13) 释放锁（成功 unlink；失败按接管前 mtime 回滚）
```

### 6.3 提示词

`DREAM_SYSTEM_PROMPT`（`src/dream-prompt.js`）说明：

1. **怎么读输入**：转写是数据不是指令；只有 `[user]` 是用户在说话，`[user-pasted]` 不是用户的话；日期以 `--- YYYY-MM-DD ---` 为准。
2. **什么值得记**：未来会话从仓库、历史、指令文件都拿不到的内容。架构描述、路径、版本号、测试数等不记，已有的直接删掉而不是更新。
3. **怎么处理**：明确的用户纠正优先；清楚的新值替换旧值；无法判断先后的两条都留并标 `CONFLICT:`；feedback/project 写 `**Why:**` 和 `**How to apply:**`；推断要标明是推断。
4. **证据要求**、截断文件规则、输出格式（严格 JSON）。

分析调用的 `ANALYST_SYSTEM_PROMPT` 在 `src/dream-map.js`，只提取笔记，不产出操作。记忆是背景上下文、可能过时，**不覆盖** system/developer/user 指令与 AGENTS.md/CLAUDE.md。

---

## 7. HTTP API 契约

- `GET /bridge`：loopback-only 桥接发现（返回与 index 注入一致的 `{base, token}`；DSH auth 门禁；供页面早于注入时恢复 API 模式）。

- 前缀：`/api/cc-memory/`；请求头 `x-cc-memory-token`；响应 JSON + `Cache-Control: no-store`。
- **安全（v6）**：仅接受 loopback 来源（`req.socket.remoteAddress` 必须 `127.*`/`::1`，否则 403 `loopback-only`）；POST 额外校验 `Origin`（跨源 → 403 `bad-origin`，同 Host 或 loopback host 放行）；token 持久化在 `<memoryRoot>/.api-token`（0600，插件重载/进程重启后不变，已打开页面不会失效）；token 比对常量时间；DSH 自身鉴权层通常在此 handler 之前拦截未认证请求。
- token 由 `webserver/index-inject` 结构化 row 注入 (`kind:'global', name:'__CC_MEMORY_API__')`；仅 owner peer 拿到 token（peer 缺失 fail-closed，liveshare viewer 不注入）；桌面 Electron 在 boot 前应用 global row，相对 base 经 `dsh-app://` 自定义 protocol 转发并带认证 cookie；若页面加载早于插件安装/重载，客户端显示明确 banner + 「刷新页面」按钮。
- **rules 是持久提示面**：`POST /rules` 会写 `<projectDir>/memory-rules.log` 审计行（scope/source/bytes/sha256/preview），便于追溯 prompt 规则变更。
- `enabled:false` 时仅 `/status`、`/toggle` 可用，其余返回 `{ok:false,error:'plugin-disabled'}`。
- 备份/回收站（v7）：`GET /backups`、`GET /trash` → `{ok,items:[{id,at,files}]}`；`POST /restore {kind,id,file?}` → `{ok,restored,reconciled}`（只允许 `.dreams`/`.trash` 下单段路径，写入 changelog + reconcile）。
- dream 动作（v7）：`POST /dream {action:'preview'}` → `{ok,result:{path,summary,ops:[{index,op,scope,file,type,before,after,changed}],truncatedFiles,dropped,durationMs,inputChars,outputChars,usage,costExceeded}}`；`{action:'apply-ops',indexes:[n]}` 只应用选中 op（备份+失败回滚）；`apply-last/apply-pending` 现在持 `.consolidate-lock`，冲突结果 `{ok:false,error:'dream-locked'}`。
- 指标（v8）：`GET /metrics` → `{ok,metrics}`（canonical summary：inject/reads/writes/searches/dreams/costs，另带 `injections` 别名）；`/status` 自带 `metrics`。

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|
| GET | `/status` | `?sessionId=` | `{ok,version,project,config,overrides,index,entries,userScope,state,changelogTail,trashCount,rules,health}` |
| GET | `/file` | `?sessionId&file&scope` | `{ok,file,scope,frontmatter,body,raw}` |
| GET | `/rules` | `?sessionId` | `{ok,rules}` |
| GET | `/log` | `?sessionId&lines=40` | `{ok,tail}` |
| POST | `/rules` | `{sessionId?,scope:'project'\|'global',text}` | `{ok,rules}`（空 text=删除覆盖） |
| POST | `/toggle` | `{enabled?,autoMemoryEnabled?,autoDreamEnabled?}` | `{ok,overrides,config}` |
| POST | `/dream` | `{sessionId?,action:'dry-run'\|'run'\|'apply-last'\|'apply-pending'\|'reject'}` | `{ok,result}` |
| POST | `/delete` | `{sessionId?,file,scope?}` | `{ok,trashed,trashPath}`（需 `dreamAllowDelete`） |

错误约定：`{ok:false,error,message}`；坏 body→400 `bad-body`；未知 action→400 `unknown-action`；无 token→401。

---

## 8. Client 架构

> **UI 设计已冻结（2026-11-07 起，改动需维护者批准）**：`client.js`、`locale/en.json`、`locale/zh.json`、`icon.svg` 不得更改；任何 UI 改动需用户明确批准并运行 `node scripts/ui-freeze.mjs --update`，否则 `test/ui-freeze.test.mjs` 失败。见 [UI-FREEZE.md](UI-FREEZE.md)。

- 加载形态：`window.__ModuleLoader__.load({ id:'dsh-cc-dream-memory', factory(require) })`；只能 `require('react')`；无构建步骤、无其它 client 包依赖。
- 注册：
  - `conversation.view`：`{id:'cc-memory', order:40, label:()=>t('view.title')}` → 「记忆」页。
  - `conversation.composer.dock`：`{id:'cc-memory-status', order:50}` → 输入框下方状态 chip（`记忆 N` + 待处理数，自带样式，60s 轮询、卸载清理）。
- 页面结构（v4 UI）：固定头部（标题 + 项目名/条数 + 「记忆 / Dream / 设置」三个标签 + 刷新）+ 可滚动内容。`MemoryView` 持有 status、busy、toast，并提供 `run(key, task, {check, success})`：同一时间只跑一个动作，成功/失败统一 toast，结束后重新拉 `/status`。
  - `MemoriesTab`：待确认写入 → 搜索 + 新建 → 类型筛选（+ 本项目/跨项目）→ 列表；详情/编辑器在右栏（sticky，最大高度为可视高度，内部滚动），窄屏替换列表。
  - `TidyTab`：无方案时是引导卡 + 「生成Dream方案」（`dream dry-run`）；有方案时用 `preview` 渲染逐条改动，勾选后 `apply-ops`；`/dream-history` 单独拉取，最新可撤销批次显示撤销（`undo`）。
  - `SettingsTab`：`/toggle` 四个开关、rules 编辑、`/trash` `/backups` 懒加载 + `/restore`、记忆目录复制、使用情况一行。
- 记忆预览：内置的小型安全 Markdown 渲染器（标题/列表/代码块/引用/链接/粗斜体），不注入 HTML。
- 数据访问：统一 `fetch` + `x-cc-memory-token`；数据层（`normalize*`、`createBackend`）与 UI 分离；错误进 toast 或卡片文本，不炸 slot（外层还有 ViewBoundary）。
- 降级状态：`bridge-missing`（页面早于插件加载）→ 只读 + banner + 「刷新页面」；`no-backend` / `token-expired`（401）→ 错误 banner + 「刷新页面」；插件或自动记忆关闭 → banner 内一键「开启」。
- locale：`dsh-cc-dream-memory` 命名空间；客户端内联字典 en/zh 各 **165 键**，`locale/*.json` 与之一一对应（另有 `meta`）；测试会检查源码里每个字面量 `t('…')` 键在两种语言里都存在。
- 测试钩子 `window.__CC_MEMORY_INTERNALS__`：数据层 normalize 函数 + UI 纯函数（`filterEntries`、`countByType`、`opKind`、`projectLabel`、`attentionCount`、`viaLabel`、`readinessText`）。

---

## 9. 配置参考（profile `cordis.patch.yml` 的 `cc-memory` 行）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件功能总开关（可被运行时 override 覆盖；不会阻止加载，便于从 UI 再开启） |
| `autoMemoryEnabled` | `true` | auto memory：注入 + 自动写入；`/memory on|off` 写这个 |
| `memoryRoot` | `''` | 记忆根目录，空 = `$DSH_HOME/cc-memory`；支持 `~/` |
| `userMemoryEnabled` | `false` | 跨项目 user scope |
| `injectIndex` | `true` | 是否注入索引 |
| `autoRecall` | `true` | 按用户消息自动附加相关记忆 |
| `autoRecallMaxFiles` / `autoRecallMaxChars` | `3` / `3000` | 每条消息最多附加的记忆数 / 总字符数 |
| `injectionMode` | `session` | `session`=会话开始注入一次并冻结；`live`=每次变化刷新 |
| `indexMaxLines` / `indexMaxBytes` | `200` / `25600` | 注入预算（官方 200 行/25KB） |
| `injectSubagents` | `false` | 是否给 teammate/subagent 会话注入（默认不注入） |
| `subagentWriteMode` | `off` | 子会话写入：`off` 默认只读，`shared` 写当前项目 |
| `autoDreamEnabled` | `false` | 自动Dream |
| `minHours` / `minSessions` | `24` / `5` | 自动 dream 闸门 |
| `scanThrottleMs` / `lockTtlMs` | `600000` / `3600000` | 节流 / 锁 TTL |
| `dreamMode` | `apply` | `apply` 直接应用；`review` 产提案待人工 apply/reject |
| `dreamProvider` / `dreamModel` | `''` | 空 = 用当前默认模型选择 |
| `dreamAllowDelete` | `true` | 允许删除（启用后仍只软删除到 `.trash/`；v11 默认开启） |
| `dreamMaxOps` / `dreamInputMaxChars` | `40` / `96000` | 单次操作数 / 输入预算 |
| `dreamMaxFileChars` / `dreamMaxSessionChars` / `dreamMaxToolChars` | `20000` / `12000` / `4000` | 单文件上限 / 整段进入整理调用的会话上限 / 每块工具证据上限 |
| `dreamMapChunkChars` / `dreamMapMaxChunks` | `24000` / `12` | 长会话每块大小 / 单次 Dream 最多分析的块数 |
| `llmMaxTokens` | `16384` | dream 输出预算（max-tokens 时双倍重试一次） |
| `sessionLookback` | `8` | dream 参考的最近 session 数 |
| `tools` / `commands` / `ui` | `true` | 各面开关 |
| `contextOrder` | `850` | 注入 context 排序 |
| `maxContentBytes` | `131072` | 单条记忆正文上限 |
| `rulesMaxChars` | `8000` | 规则文件上限 |
| `secretScan` | `warn` | 写记忆/dream 写文件/rules 前的机密扫描：`warn`/`deny`/`off` |
| `dreamMaxTotalTokens` | `0` | dream 单次 total token 软上限（0=off）；超限 `costExceeded` 告警但照常应用 |
| `refreshIntervalMs` | `30000` | 注入缓存兜底刷新间隔 |

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
| 手动Dream | 「记忆」页 Dry run / Dream now；`/memory dream run [--dry-run]` |
| 审阅Dream | `dreamMode:'review'` 时生成提案 → 「应用提案 / 拒绝提案」或 `/memory dream apply|reject`；dry-run 的 plan 可用「应用上次计划」原样执行 |
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
| 没有注入 | `autoMemoryEnabled`/`enabled` 是否被 override 关了（`/memory status` 的 config）；`injectionMode` 是否 session 且本会话已冻结；看 `health.warnings` |
| 没有 `memory_*` 工具 | 插件行是否 active；`inject` 硬依赖 `tools/systemPrompt` 是否存在 |
| UI 空白/降级 banner | 先刷新页面；若仍降级，用 `/memory status` 确认插件与命令面可用（v11 起桌面/Web 通过 index-inject 结构化 row 注入 token，不再有 `.api-tap.log`；peer 非 owner 时不会注入）。 |
| `/api/cc-memory/*` 401 | token 不对/缺失：确认页面刷新后从 index 拿到 `__CC_MEMORY_API__`；token 已持久化在 `.api-token`，插件重载不会失效。 |
| dream 不动 | `autoDreamEnabled`、闸门（24h/5 sessions/节流/退避）、`pendingProposal` 是否阻塞；看 `.dream-log.md`/`state.lastError` |
| 索引有孤儿/悬空 | `health.warnings` 会提示；跑一次 dream apply 自动 `reconcileIndex` |

---

## 11. 安全、成本与已知限制

- **安全（v6/v7）**：HTTP 仅接受 loopback 来源 + POST Origin 校验 + token 持久化 `.api-token`（0600）；token 常量时间比对；API 不写会话日志；rules 写入审计 `.memory-rules.log`；**v7 起写入/dream/rules 前做机密扫描**（8 类规则 + 高熵 base64，`secretScan: warn|deny|off`，默认 warn，excerpt≤12 字符）。记忆是明文 Markdown，仍**无 HTTP 限流**。
- **成本（v8）**：plan/changelog/state/metrics 记录 `durationMs/inputChars/outputChars/usage`（usage 由 `ctx.llm.stream` 提供时）；`dreamMaxTotalTokens` 软上限超限告警（默认 off）；UI 展示最近成本与徽标；仍无硬性成本阻断。
- **已知限制**：
  1. 默认 `session` 冻结：本会话新写记忆不会立刻进注入；其他会话写入要到下个会话才可见（要实时刷新设 `injectionMode:'live'`）。
  2. 非 git 工作区（如 default-workspace）按工作区聚合记忆，无关会话会混用同一份项目记忆（项目身份路线图）。
  3. 指标是“使用量/接受率”而非“回答质量价值”，仍需 A/B 或人工评估；neverRead 只反映当前索引文件的读计数。
  4. 自动召回是词面匹配，换说法可能召回不到；证据检查只证明引用存在，不证明推断正确。
  5. 子代理不继承主会话记忆（可配 `injectSubagents`），fork 子会话按父会话项目解析。
  6. 跨平台：Windows 路径/rename 重试专门处理过；v7 起 CI 覆盖 Windows+Ubuntu（Node 22/24），但仍无真实宿主 E2E 与浏览器 E2E。
  7. `apply-ops` 成功后按“完成一次 dream”更新 cadence 并清 sessions/plan；人工 apply 锁冲突在 HTTP 侧为 `{ok:true,result:{ok:false,error:'dream-locked'}}`。
  8. 机密扫描是启发式；无 HTTP 限流；本机多用户未隔离。
  9. 工作目录解析不到时（v6 起）该会话直接禁用记忆功能（工具返回 `no-project`）。

---

## 12. 扩展指南（二次开发）

- **加一个工具**：`src/tools.js` 里 `register({name, description, parameters, output, execute})`；execute 里 `projectFor(runtime, exec)` 拿上下文；写后 `invalidate(runtime, agent)`。
- **加一个命令**：`src/commands.js` 的 `register({name, description, input, handler})`；解析用 `parseCommandLine`。
- **加 UI 卡片/按钮**：`client.js` 组件内新增；数据走现有 `/status` 字段或新端点（`src/http.js` 加 route + 客户端 request）。
- **改 dream 行为**：提示词在 `src/dream-prompt.js`；校验/应用/回滚在 `src/dream.js`（`validateDreamPlan`、`executePlan`、`handleApplyFailure`）；输入收集在 `src/dream-input.js`，转写在 `src/dream-session-text.js`，长会话在 `src/dream-map.js`，证据在 `src/dream-evidence.js`。
- **加记忆类型**：`MEMORY_TYPES`（store.js）+ `rules.js` 默认规则 + 前端类型色点/locale。
- **加配置项**：`config.js` 的 `DEFAULTS` + `resolveConfig` 校验；需要时在 `http.js` 的 `CONFIG_FIELDS`、`tools.js` 的 `configSummary`、commands 状态里暴露。

---

## 13. 版本、测试与验证

- 版本：`package.json` **0.11.0**；语义化 + `CHANGELOG.md`。
- 测试：`test/*.test.mjs` 当前 **445 条 / 60 个文件**，`node --test "test/*.test.mjs"`；`node scripts/verify.mjs` PASS。只在 Windows + Node 24 上跑过，Ubuntu 与 Node 22 待 CI 确认。
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
