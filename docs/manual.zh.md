# 使用手册

这是完整的中文手册，安装和入门请看 [README.zh.md](../README.zh.md)。架构和 DSH 集成机制见 [ARCHITECTURE.md](ARCHITECTURE.md)。

Web UI 处于冻结状态，改动流程见 [UI-FREEZE.md](../UI-FREEZE.md)。

## 记忆放在哪

```
$DSH_HOME/cc-memory/
  projects/<workspace-slug>/
    .state.json            # 插件状态（上次 dream、待处理 session、提案）
    .dream-log.md          # 每次 dream 的 changelog
    .dreams/<ts>/          # 每次 dream 前的备份
    .pending/<ts>.json     # review 模式的待审提案
    .consolidate-lock      # dreaming 并发锁（PID + 1h TTL）
    memory/
      MEMORY.md            # 索引：一行一条 `- [name](file) — description`
      user_role.md         # topic 文件：frontmatter(name/description/type/modified) + 正文
  user/memory/             # 可选跨项目记忆（userMemoryEnabled）
```

`<workspace-slug>` 由工作区（或最近的 git 根）推导，格式与 `~/.dsh/sessions` 的目录命名一致（如 `--C-Users-me-repo--`），所以同一仓库的所有会话（含 git worktree）共享一份记忆。

记忆是**纯 Markdown**，可以随时手工查看、编辑、删除；删除整个 `cc-memory` 目录即清空记忆。

## 模型侧工具

模型侧**只有 4 个工具**（描述 + JSON Schema 总预算 ≤3000 字符）：

| 工具 | 作用 |
|---|---|
| `memory_save` | 新增一条记忆（name/type/description/content；低置信或 confirm 写入进待审；冲突拒写并返回原条目，疑似重复保留 advisory；force 只绕过重复拦截） |
| `memory_update` | 更新正文/描述；低置信同样待审；传 `name` 改名（保留 created/provenance，旧文件进回收站）；传 `delete:true` 软删除 |
| `memory_read` | 读取一条记忆的完整 Markdown，附 `ageDays`；满 30 天再加 `staleness`，提醒先核实再引用 |
| `memory_search` | 相关度排序检索（name/desc/body 权重 + phrase + recency + type/scope/limit，返回 score/snippets） |

人类操作面（不占模型工具预算）：`/memory list|status|show|index|delete|dream|refresh|metrics|writes|backups|restore|edit|merge|history|search|import|export`、`/remember`、Memory 页与 HTTP API。

类型：`user`（用户角色/偏好）、`feedback`（纠正与已确认做法）、`project`（代码与 git 推导不出的进行中工作/决策）、`reference`（外部信息在哪找）。

## 斜杠命令

- `/memory` — 状态总览；`/memory json` 给脚本/降级用的 JSON。
- `/memory list` / `/memory show <file>` / `/memory index`
- `/memory on` / `/memory off` — **auto memory**（注入 + 自动写入）开关；插件本身不卸载。
- `/memory plugin on` / `/memory plugin off` — **插件功能总开关**（运行时 override，立即生效，无需改 yml/重启）。
- `/memory dream on` / `/memory dream off` — auto dreaming 开关
- `/memory dream status` / `/memory dream run [--dry-run] [--focus <主题>]` — 生成计划（dry-run 会记录 `lastPlanPath`）；`--focus` 让这一轮优先关注某主题，多个词要加引号；Web 视图暂无此入口（UI 已冻结）
- `/memory dream apply` — **执行上次 dry-run 的那份 plan.json**（没有则执行 review 提案）；不会重新调模型
- `/memory dream reject` — 丢弃 review 提案
- `/memory dream preview` — 只读展示最新 plan 的逐条 diff（before/after 字符数、changed），不写盘、不调模型
- `/memory dream apply-ops <indexes>` — 只应用 plan 中选中的操作（逗号/空格分隔，0-based），备份+回滚语义与整份 apply 相同；不移动会话水位线，下次 Dream 仍会重读这些会话
- `/memory rules` / `/memory rules reset` — 查看/清除可编辑的注入规则（见下）
- `/memory delete <file>` — 软删除（移到 `.trash/<ts>/`，可从备份/回收站恢复）
- `/memory backups` / `/memory trash` — 列出 `.dreams/` 备份与 `.trash/` 回收站批次
- `/memory restore <backup|trash> <id> [file]` — 从备份/回收站恢复整批或单文件（写 changelog + reconcile 索引）
- `/memory metrics` — 效果指标：注入次数、自动召回次数、读/写总数、search、dream 接受率、Top read、never read、最近成本
- `/memory writes` — **v9** 待审写入列表（低置信/confirm 候选；冲突拒写并返回原条目）
- `/memory approve <id>` / `/memory reject <id> [reason]` — 批准（走正常写入 + provenance/机密扫描/索引）或拒绝待审写入
- `/memory refresh` — **v9** 立即重建本会话注入（冻结模式下也强制刷新）
- `/memory live on|off` — **v9** 当前会话切 live/auto 注入模式（per-session，不影响其他会话）
- `/memory user on|off` — **v9** 开关跨项目 user 记忆空间（独立 30 行/4KB 预算）
- `/memory search <query> [--type= --limit=]` — **v10** 相关度排序检索（score/snippets）
- `/memory edit <file> [--name= --type= --description= --content=]` — **v10** 编辑记忆（保留 created/provenance、secret scan）
- `/memory merge <file1> <file2> [...]` — **v10** 合并多条记忆（`## 原名` 分节，原文件进回收站，reconcile 索引）
- `/memory history <file>` — **v10** 审计：provenance + changelog 相关行 + dream/pending 引用
- `/memory dream history` / `/memory dream undo` — **v10** Dream批次时间线 / 撤销最近一次 apply（恢复备份 + 新增文件移 trash + reconcile）
- `/memory import <path>` / `/memory export <path>` — **v10** Claude Code 记忆导入 / 导出（含 rules 导出到 `.claude/rules`）
- `/remember [--type=user|feedback|project|reference] [--scope=project|user] <内容>` — 自动命名取正文首行前 32 个字符（支持中文，不互相覆盖）

开关类命令会写回插件配置行（依赖配置编辑器；保存后重载插件生效）。**`/memory plugin off` 与 UI 开关写的是运行时 override 文件，不重启插件、不影响其他功能注册，因此随时可以再打开。** 真正卸载/移除插件仍需 Plugin Manager 或 profile yml。

## 可编辑的注入规则

每次请求注入的「哪些值得记住」规则是**用户数据**，按以下优先级读取（全部为纯 Markdown，可随时手改）：

1. 项目覆盖：`<projectDir>/memory-rules.md`
2. 全局覆盖：`<memoryRoot>/memory-rules.md`（默认 `~/.dsh/cc-memory/memory-rules.md`）
3. 内置默认（6 条 bullet，与 Claude Code 的 auto memory 指南对齐）

- 在 Memory 页的 **Rules 卡**里可直接编辑、保存到 project/global、或删除覆盖恢复默认；保存后立即生效（下一次请求注入新规则）。
- 上限 8000 字符（`rulesMaxChars`），超长会被拒绝；文件行内容原样注入。

## 注入策略：会话开始注入一次，然后冻结

默认 `injectionMode: 'session'`：

1. **第一轮就注入**：模型不知道有记忆就不会去查（只给 `memory_search` 工具，大部分记忆永远不会被用到）；「中文回复」「先看结论」这类偏好/纠正必须从第一句就生效；只注入索引成本很低（当前 5 条约 300 token），正文按需 `memory_read`。
2. **会话内冻结**：首次构建后，`memory_save`、dream、其他会话写入、30 秒定时器都不会改变本会话注入的文本。
   - 本会话自己写的记忆已经在对话历史里，不需要重复注入；
   - 其他会话的更新在**下一个会话**生效；
   - **compaction 时刷新一次**（`compaction/*` 会话事件），因为那时请求前缀本来就要重算。
3. **可选 `injectionMode: 'live'`**：保留旧的实时刷新行为（每次记忆变化/定时器都更新）。
4. 配置/规则变更（`/memory plugin on|off`、`/memory on|off`、UI 开关、Rules 保存）属于显式用户操作，会强制刷新当前会话的冻结快照。
5. 子会话开关 `injectSubagents`（默认 `false`）：teammate/subagent 子会话默认不注入项目索引（接近 Claude Code 的默认）；显式设为 `true` 才注入。写入归属由 `subagentWriteMode` 控制。

> 实现说明（已核对 DSH 源码）：`systemPrompt.context` 渲染出的 runtime context **不会进入 system prompt 前缀**，而是作为一条**尾部 user 消息**追加（`agent-loop` 里 `messages: [...claimed, context]`），且文本不变时不会重复追加。所以冻结的主要收益不是"保住前缀缓存"，而是避免每次记忆变化就往历史里多塞一条快照消息（token 增长），并让会话上下文稳定、可预期。

## Web 视图

会话标题栏的视图切换里出现 **Memory / 记忆** 标签（`conversation.view`，id `cc-memory`，order 40）——不在左侧栏。页面顶部固定标题与三个标签，下面是可滚动内容：

- **记忆**（默认）：搜索框（名称/描述本地即时过滤，≥2 字时再用 `/search` 补正文命中并显示片段）+ 类型筛选（全部/用户/反馈/项目/参考，带数量；开启跨项目记忆时多一个「本项目 / 跨项目」切换）+ 按更新时间排序的列表。点一条在右侧打开详情（Markdown 渲染、来源、更新时间），可**编辑**（名称/类型/摘要/正文，Ctrl+Enter 保存）或**删除**（两段确认，进回收站）；「新建」直接写一条。智能体拿不准的写入出现在顶部「等你确认」，一键保留/丢弃。
- **Dream**：一条流程——「生成Dream方案」（dry-run）→ 逐条看改动（新增/修改/删除/索引，可展开改前/改后，默认全选有变化的项）→「应用所选 N 项」（两段确认，走 `apply-ops`）；待审提案可「放弃方案」。下方是上次Dream时间、**自动Dream**开关与就绪说明、索引大小进度条，以及「最近Dream」列表（最新一批可撤销，已撤销的有标记）。
- **设置**：四个全局开关（记忆功能 / 自动记忆 / 自动Dream / 跨项目记忆，注明对所有项目生效）、记忆规则编辑（保存到本项目 / 保存为全局 / 恢复默认）、回收站与Dream前备份（整批或单文件恢复）、记忆目录（可复制）与一行使用情况。
- 成功/失败用底部 toast 提示；破坏性操作都是两段确认；跟随宿主亮/暗主题变量；容器宽度 ≤720px 时变单列，详情页带「返回」。
- 输入框下方 dock 的状态 chip（`conversation.composer.dock`）：`记忆 N`，有待确认写入或待审方案时追加「N 项待处理」，60 秒轮询。

效果指标趋势、健康分、合并、文件历史、导入/导出不在页面上（仍可用 `/memory metrics|merge|history|import|export` 与 HTTP API）。

**数据通道是静默 HTTP API**：`GET/POST /api/cc-memory/*`；loopback + `x-cc-memory-token`（token 持久化在 `~/.dsh/cc-memory/.api-token`，插件重载不再失效）+ 只接受 loopback 来源 + POST 校验 Origin；写 rules 会追加审计到 `<projectDir>/.memory-rules.log`（scope/source/bytes/sha256）。页面拿不到 API（加载早于插件安装/重载）时显示明确 banner 和「刷新页面」按钮，不再静默降级为命令模式；`enabled:false` 时除 `/status`、`/toggle` 外一律返回 `plugin-disabled`。

API 端点：`GET /status`、`GET /file`、`GET /rules`、`GET /log`、`GET /backups`、`GET /trash`、`POST /rules`、`POST /toggle`、`POST /dream`（`run|dry-run|apply-last|apply-pending|apply-ops|preview|reject`）、`POST /delete`、`POST /restore`。

## Dream（后台整理）

触发（全部满足）：`autoMemoryEnabled` → `autoDreamEnabled` → 无待审提案 → 距上次 ≥ `minHours`（默认 24）→ 自上次 ≥ `minSessions`（默认 5）个**主线** session → 10 分钟扫描节流 → 连续失败退避（指数、上限 6h）→ 拿到 `.consolidate-lock`。teammate/subagent 会话（`parentSession` 或 `origin: 'subagent'`）不计入、也不会被当作「用户的话」喂给模型。

一次 Dream：

1. **收集（纯读取）**：读索引与 topic 文件（最多占输入预算的 70%）；读最近 `sessionLookback` 个主线会话。此步不写任何状态，失败或 dry-run 不会让会话被跳过。
2. **转写**：宿主注入的内容（指令、runtime context、技能目录、自动召回）一律不进转写。每段带标签：`[user]` 是用户打的字，`[user-pasted]` 是用户转发的长材料，`[assistant]` / `[tool-call]` / `[tool-result]` / `[tool-error]` 是过程记录，并带 `--- YYYY-MM-DD ---` 日期标记。
3. **长会话分块分析**：不超过 `dreamMaxSessionChars` 的会话整段进入；更长的按 `dreamMapChunkChars` 切块，每块单独调一次模型提取笔记。笔记必须带引用，插件在该块原文里核对，找不到的丢弃，并按命中位置给笔记标注真实来源和日期（模型自称的来源不算数）。单次最多 `dreamMapMaxChunks` 块；预算或 token 用尽时停下，已读部分照常使用，剩余部分下一轮接着读。
4. **整理**：模型输出严格 JSON 计划（write / delete / index）。可用 `--focus` 指定这一轮优先关注的主题。
5. **校验**：路径必须在 memory 目录内、只允许 `.md`、操作数/大小有上限；**输入中被截断的文件（> 20000 字符）禁止整份重写，也禁止删除**；未写 `file` 的写入若推导出的文件属于另一条同 slug 的记忆，丢弃该写入。
6. **证据检查**：读过会话时，新增非空正文行须分别带 `evidence:[{statement,quote}]`，每行都要覆盖，且引用须能在本轮读到的内容里找到；`user`/`feedback` 须来自 `[user]`。程序记录真实 sessionId/seq 或来源记忆文件。旧字符串引用仍可手动应用，但会警告其仅覆盖整次写入。大幅缩减保留警告和操作，交给自动审阅边界处理。纯整理的手动应用不强制引文，仍须人工判断。
7. **自动审阅边界**：自动 Dream 的新增事实、正文/元数据改写、未证明原文完整保留的删除会进入现有 review 提案，不推进会话水位线；仅保留内容的空白规范化、相同内容与元数据的重复文件删除及忠实索引修复可自动应用。已有提案会阻止新 Dream 覆盖它。手动应用仍走既有预览、哈希检查和恢复路径。
8. **备份**当前记忆到 `.dreams/<ts>/`，然后应用（`dreamMode: 'apply'`）或写提案（`'review'`，不清 session、需人工 apply/reject）。
8. 写文件 → 写索引 → `reconcileIndex()` 防孤儿（磁盘有文件而索引无条目会自动补回）→ 追加 `.dream-log.md` → 更新 state → 释放锁。
9. **中途失败会选择性回滚**：回滚前把当前记忆快照到 `.dreams/<ts>-rollback/`；只处理本次计划 touch 的文件，且当前哈希必须等于“dream 应用后预期哈希”才恢复/移 trash；未触碰的文件与被并发修改的 touched 文件**原样保留**，后者返回 `conflicts:[{file,reason}]`；changelog 记 `rollback: true` 与冲突行。
10. **成本/耗时**：plan JSON、changelog、state 记录 `durationMs`/`inputChars`/`outputChars`/`usage`（含分块分析），`/memory status` 可查。
11. **按条应用**：`preview` 返回逐条 diff，`apply-ops <indexes>` 只执行选中操作；apply-ops 与人工 apply 都持 `.consolidate-lock`（冲突返回 `dream-locked`）。

**水位线**：每个会话读到哪一步（`seq`）、是否读完，都记在计划的 `reads` 里，**只有 apply 成功才写入 state**。dry-run、review 未批准、失败都不移动水位线；只读了一部分的长会话下一轮从断点继续；已读完的会话有新内容时只读新增部分。

dry-run 的 `plan.json` 会被记录为 `lastPlanPath`；`/memory dream apply`、UI 的「应用上次计划」、`runtime.applyLastPlan()` 都**执行这份既有计划**，不会重新调模型——预览与执行是同一份内容。计划里记录了生成时记忆目录的内容 hash；若之后记忆有改动（人工编辑、`memory_save` 等），apply 会以 `stale-plan` 拒绝并列出变动文件，需重新 dry-run。直接 apply 时，若模型运行期间记忆被改动，本次 dream 也会放弃应用。

安全默认：自动 dream 关闭；删除默认开启但只做软删除（进 `.trash/`，可恢复）；每次改动有备份与 changelog；记忆只是背景上下文（注入文本明确「可能过时，不覆盖 AGENTS.md/CLAUDE.md 等指令」）。

## 写入边界

- `memory_save` 与 `memory_update` 共用审阅边界；`confidence:low` 和 confirm 不能被 `force:true` 绕过。未确认推断须使用低置信，模型置信度本身不是事实证据。
- 词面策略识别到跨文件冲突时，拒绝产生第二条有效记忆，返回原文件；明确的用户纠正通过更新原文件处理。词面冲突识别仍可能漏报或误报。
- 待审更新、改名和删除保存原文件 SHA-256；批准时在存储写锁内比较，期间作者改过文件则返回 `STALE_WRITE` 并保留候选。旧版本未存哈希的提案保持兼容，没有该保护。
- UI 保持冻结；所有新行为使用已有工具、命令与提案界面。

## 写入策略：重复、冲突与待审队列（v9）

写入不再“模型说什么就写什么”，`memory_save` 前先过 `src/policy.js`：

| 判定 | 阈值/条件 | 行为 |
|---|---|---|
| `allow` | 无相似、无冲突 | 正常写入 |
| `duplicate` | 与已有条目相似度 ≥ 0.82 | **不写**，返回已存在文件 + hint（用 `memory_update` 或 `force:true`） |
| `possible-duplicate` | 0.55 – 0.82 | **advisory**：照常写入，结果附 `candidates` 提示（v11 起不再拦截） |
| `conflict` | 同主题 + 极性相反（喜欢/讨厌、用/不用、always/never…） | **拒写**，返回 `action:conflict` 和原文件；明确纠正时读原条目再 `memory_update` |
| `low-confidence` | `confidence:'low'` 或 `writeMode:'confirm'` | 进 **`.pending/writes/` 待审队列**，返回 `pendingId`；**force 不能绕过低置信或 confirm**，`memory_update` 同样排队 |

- 审阅：UI「待确认写入」卡，或 `/memory writes`、`/memory approve <id>`、`/memory reject <id>`；批准时走正常写入（provenance/机密扫描/索引/metrics + 软删除安全）。
- 相似度：CJK 单字+bigram、latin word 的 Dice 系数，name/description/body 加权。
- 设计原则：**写入端负责质量，Dream 只负责事后整理**；宁可让模型/人确认一次，也不让同义记忆、矛盾事实悄悄进库。

## 项目身份与多记忆空间（v9）

记忆目录由 `src/identity.js` 决定，优先级：

1. 配置 `projectId`（最明确，适合非 git 目录/多人共享）；
2. workspace 标记文件（向上查找）：`.cc-memory.json`（`{"projectId":"my-project"}`）或 `.dsh-memory-project`（纯文本 id）；
3. git 仓库根；
4. 普通工作目录（**会提示“多个会话共享记忆”的健康警告**）。

非 git 工作区想隔离时，在项目根放一个标记文件即可：`echo '{"projectId":"rent-calculator"}' > .cc-memory.json`。

多记忆空间：`user` scope 是跨项目的独立空间（`userMemoryEnabled`，命令行/UI 可开关），拥有自己的 **30 行/4KB** 预算；project 空间默认 **200 行/25KB**（对齐官方额度，token 成本更高）。注入文本分 `project` 与 `user` 两段，各自独立 budget-notice。

## 会话内即时刷新（v9）

冻结注入的默认策略不变（第一轮注入、会话内稳定），但不再“只能等下一个会话”：

- `/dream run|status|apply|history|undo`：Dream 的短命令（等价 `/memory dream …`），UI 降级时也可用。
- `/memory refresh`（命令/UI）：**立即重建当前会话注入**（冻结模式也强制）；
- `/memory live on|off`：**只对当前会话**切 live 模式（不影响其他会话/全局配置）；
- 配置/规则变更、compaction 仍照旧刷新。

## dream 就绪度、健康度与成本模式（v9）

- **就绪度**：`/memory dream status` 与 UI Dream 卡显示 `eligible`、`nextEligibleAt`、阻塞原因（auto 关闭/未到 24h/会话数不足/节流/退避/待审提案/锁）；`/status.readiness` 可机读。
- **健康度**：0–100 分 + 维度（索引预算、neverRead 比例、dream 是否过久、pending 是否过期、截断文件、规则、身份共享）+ suggestions（over-budget / many-never-read / dream-overdue / pending-stale / non-git-sharing / rules-truncated）；UI 徽标 + 折叠建议。
- **待审提案超时**：默认 72h 未处理自动归档到 `.pending/expired/` 并解除对自动 dream 的阻塞（不再“忘了就永远不Dream”）。
- **成本三模式** `dreamCostMode`：`warn`（默认，超限仍应用+告警）/ `review`（不应用、转 pending 提案）/ `block`（预检超限直接不调 LLM；事后超限不写记忆、记失败）；超限都写 `costExceeded` 到 plan/state/changelog，UI 显示徽标。

## P1 新增：恢复/编辑/检索/指标/互通/一致性（v10）

- **恢复语义**：每次 apply/apply-ops 生成 `.dreams/<ts>/meta.json`；`/memory dream undo`（或 UI Dream 历史里的 Restore）恢复该批备份、把 dream 新建的文件移入 `.trash/<ts>-undo/`、恢复索引并 reconcile，连续 undo 会逐个批次回退；`/memory dream history` 列出批次（旧批次无 meta 只读展示）。
- **编辑/合并/审计**：`POST /file`、`POST /merge`、`GET /file-history` + UI（Edit 表单、文件多选 Merge、History 折叠）替代“只能靠工具改”。
- **检索**：`memory_search` + `/memory search` + UI 搜索框；相关度 = name(5)/description(3)/body(1) + phrase bonus + 30 天 recency，支持 type/scope 过滤与分页；语义检索（embedding）仍留作路线。
- **指标价值**：daily 桶（60 天）、adoption 计数、dream quality（appliedOps/planOps、dropped、rollbacks、applyRate/dropRate）；`GET /metrics?days=7` 与效果卡 7 日趋势。
- **Claude Code 互通**：`/memory import <dir>` 读取 CC 的 `memory/MEMORY.md`+topic 文件（有/无 frontmatter 均可，重复跳过）；`/memory export <dir>` 产出同款布局 + `rules` 写到 `.claude/rules/dsh-memory.md`。
- **团队/子会话**：`subagentWriteMode` 明确归属；所有写工具/写命令对 `off` 模式下的 subagent 返回 `subagent-readonly`，只读工具照常。
- **事务一致性**：`src/lock.js` 跨进程写锁包裹 store 所有 mutating 方法（`.write.lock`，TTL 30s），与 dream 的 `.consolidate-lock` 互补；各 op 写入 + reconcile 仍是“最终一致”，不是跨文件事务。
- **compaction 恢复**：压缩会丢细节，所以 compaction 刷新时注入 `<memory-digest>`（最近修改 top5 + 最常读取 top3），可 `compactionDigest:false` 关闭。

## 撤销、工具和写入策略

- **撤销 dream 数据安全**：`meta.json` 记录被触碰文件的 sha256（apply 后）、created/rewritten/deleted/operations；undo 只处理这些文件；任一文件当前哈希与记录不一致 → **整体拒绝**（`conflict` + conflicts 列表，磁盘不变）；undo 前把当前状态备份到 `.dreams/<ts>-undo-backup/`；索引由 `reconcileIndex` 修正（不覆盖 MEMORY.md）；旧批次无 hashes → `legacy-batch`，只读不可 undo；连续 undo 逐批回退。
- **模型侧 4 工具 + recall 并入 search**：工具定义总量受 3000 字符预算约束；list/status/dream/refresh 仅通过 `/memory`、UI、HTTP 提供，模型删除记忆走 `memory_update` 的 `delete`。
- **写入策略放宽**：短正文直接写（不再有 body<20 低置信）；冲突/疑似重复 **advisory**（照常写入 + conflicts/candidates 提示）；只有高度重复（≥0.82）拦截；只有 `confidence:'low'` / `writeMode:'confirm'` 进待审队列。
- **强制规则不可删**：注入规则 = 强制两条（不存密钥、记忆不覆盖指令）+ 默认建议（用户 rules 存在则替换）+ 用户 rules（追加）；新增 `When to save` 触发时机段。
- **Dream 真正整理**：prompt 从“保留每个事实”改为“保留仍然成立的事实，被新会话取代的状态直接替换”；禁止记录版本号/测试数/提交哈希/行数/进度流水账/一次性事务；`dreamAllowDelete` 默认开启（软删除）。
- **桌面 API 修复**：不再依赖 `tapIndex`；改用 `webserver/index-inject` 结构化 row `{kind:'global',name:'__CC_MEMORY_API__',value:{base:'/api/cc-memory',token}}`，仅 owner peer 注入（peer 缺失 fail-closed，liveshare viewer 永不拿 token）；桌面 Electron 在 boot 前把 global row 应用到 `dsh-app://app`，相对 base 经自定义 protocol 转发并带认证 cookie。
- **机密扫描分级**：明确格式（sk-proj-/sk-ant-/github_pat_/gho_/AIza/JWT/带密码连接串/中文「密码：」/AWS/私钥/slack）→ **deny 拒写**；泛化赋值/Bearer/高熵 → warn；`secretScan:'deny'` 仍为“全部拒绝”严格档，`off` 跳过。

## 运行时行为

- **运行时开关即时生效**：DreamEngine/MemoryStore 通过 live config provider 读取当前配置；`/memory on|off`、`/memory user on|off` 不再需要重载插件。
- **confirm 不可绕过**：`writeMode:'confirm'` 下 memory_save（含 `force:true`）与 memory_update 都进待审队列；批准 update 保留 created/provenance。
- **回滚不丢并发写**：失败回滚只处理 touched 文件且校验应用后哈希；未触碰/被并发修改的文件保留，冲突写入 `conflicts` 并留痕 `.dreams/<ts>-rollback/`。
- **lastPlan 不再误清**：`applyLastPlan` 仅在 `applied:true` 时清计划；锁冲突返回 `{applied:false,error:'dream-locked'}` 并保留指针。
- **会话缓存清理**：`agent/disposed` 调 `runtime.forgetSession`，`bySession` 上限 500，长期运行不泄漏。
- **模型覆写留历史**：`.history/<file>/<ts>-<hash8>.md`，`keepHistory`/`historyMaxPerFile` 控制；模型 update/save 与 dream 写入前都保留旧版本。
- **user scope 可写**：`memory_save/update` 支持 `scope:'project'|'user'`；跨项目偏好可写 user scope。
- **注入文案修正**：不再让模型跑 `/memory dream run`、不暴露绝对记忆路径。
- **其它**：memory_read 指标 best-effort；重复检查只读 ≤12 个候选 body；锁 stale 回收检查 pid 存活（仍是 best-effort 跨进程锁，不是严格 mutex）。

## 评估（eval/）

A/B0/B/C 配对实验（A 无记忆无工具 / B0 相同工具+空记忆 / B 记忆 / C 记忆+Dream）在 `eval/`：6 个记忆开发场景 + rubric + 检查点 + headless runner；另有 `eval/scenarios.coding.dev.json` 的开放工具普通编码场景。

```powershell
# 无模型校验（场景 schema / 泄漏 / 检查点）
node eval/validate.mjs
node eval/assert-harness.mjs
node eval/freeze.mjs   # 改动场景后冻结

# 不调模型，完整跑一遍编排（工作区、检查点、恢复、客观检查、报告）
node eval/run.mjs --fake-model --only dev-02-correction --runs 1

# 真实模型试点（需要 DEEPSEEK_API_KEY；cc-memory-eval profile）
node eval/run.mjs --runs 1
```

首轮开发试点读 [eval/PILOT-REPORT.md](../eval/PILOT-REPORT.md)，最近一次小型试点读 [eval/RELIABILITY-REPORT-2026-11-08.md](../eval/RELIABILITY-REPORT-2026-11-08.md)。两者都是诊断，**效果没有结论**。

## 配置（`cordis.patch.yml` 行 `cc-dream-memory`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件功能总开关（可被 `/memory plugin off` 的运行时 override 覆盖；**不再阻止插件加载**，因此可从 UI 重新开启） |
| `autoMemoryEnabled` | `true` | auto memory 开关：注入 + 自动写入；`/memory on|off` 写这个 |
| `memoryRoot` | `''` | 记忆根目录，空 = `$DSH_HOME/cc-memory`；支持 `~/` |
| `userMemoryEnabled` | `false` | 启用跨项目 `user` scope |
| `injectIndex` | `true` | 是否注入索引 |
| `autoRecall` | `true` | 按用户消息自动附加相关记忆 |
| `autoRecallMaxFiles` / `autoRecallMaxChars` | `3` / `3000` | 每条消息最多附加的记忆数 / 总字符数 |
| `injectionMode` | `session` | `session` = 会话开始注入一次并冻结；`live` = 每次变化实时刷新 |
| `indexMaxLines` / `indexMaxBytes` | `200` / `25600` | 每次注入的索引预算（官方 200 行/25KB；token 成本更高） |
| `injectSubagents` | `false` | 是否给 teammate/subagent 子会话也注入索引（默认不注入） |
| `autoDreamEnabled` | `false` | 自动 dreaming（建议先手动跑几次再开） |
| `minHours` / `minSessions` | `24` / `5` | 自动 dream 闸门 |
| `scanThrottleMs` | `600000` | 扫描节流 |
| `lockTtlMs` | `3600000` | 锁过期回收 |
| `dreamMode` | `apply` | `apply` 直接应用；`review` 产提案待批（apply/reject） |
| `dreamAllowDelete` | `true` | 允许 dream 删除记忆（仅软删除到 `.trash/`，可恢复；v11 默认开启） |
| `dreamMaxOps` | `40` | 单次 dream 操作上限 |
| `dreamInputMaxChars` | `96000` | 整理调用的字符预算；记忆最多占 70%，其余给短会话全文与长会话笔记 |
| `dreamMaxFileChars` | `20000` | 单个 topic 文件完整进入 dream 的上限；超过=truncated，禁止重写 |
| `dreamMaxSessionChars` | `12000` | 不超过此长度的会话整段进入整理调用；更长的走分块分析 |
| `dreamMapChunkChars` / `dreamMapMaxChunks` | `24000` / `12` | 长会话每块大小 / 单次 Dream 最多分析的块数；没读完的下次接着读 |
| `dreamMaxToolChars` | `4000` | 每块保留的工具证据上限（错误优先、其余均匀取样；不超过块大小的 1/3；0 关闭） |
| `llmMaxTokens` | `16384` | dream 单次输出预算；被 max-tokens 截断时自动用双倍预算重试一次 |
| `rulesMaxChars` | `8000` | 注入规则（memory-rules.md）允许的最大字符数，超出拒绝保存 |
| `secretScan` | `warn` | 写记忆/dream 写文件/改 rules 前的机密扫描：`warn`（写入但带 warnings）/ `deny`（拒绝）/ `off` |
| `dreamMaxTotalTokens` | `0` | dream 单次 total token 上限（0=off）；warn 模式超限仍应用，review 转提案，block 不写记忆 |
| `dreamCostMode` | `warn` | 超成本上限的行为：`warn` / `review`（不应用、存提案）/ `block`（预检超限不调 LLM、事后不写记忆） |
| `writeMode` | `auto` | `auto`（策略过滤）/ `confirm`（所有写入进待审队列） |
| `policyDuplicateThreshold` / `policySuggestThreshold` | `0.82` / `0.55` | 重复阈值 / 相似候选阈值 |
| `pendingProposalTtlHours` | `72` | review 提案超时自动归档，不再永久阻塞自动 dream |
| `projectId` | `''` | **v9** 显式项目身份（优先级最高）；空则读 workspace 标记 > git root > workspace |
| `userIndexMaxLines` / `userIndexMaxBytes` | `30` / `4096` | user 记忆空间的独立注入预算 |
| `subagentWriteMode` | `off` | 子会话写入归属：`off`（默认，写工具返回 `subagent-readonly`，只读照常）/ `shared`（即使不注入也写当前项目） |
| `indexMaxLines` / `indexMaxBytes` | `200` / `25600` | 项目索引注入预算（官方 200 行/25KB；越大 token 越多） |
| `compactionDigest` | `true` | compaction 刷新时是否注入 `<memory-digest>`（最近修改 top5 + 最常读取 top3，≤400 字符） |
| `sessionLookback` | `8` | dream 参考的最近 session 数 |
| `tools` / `commands` / `ui` | `true` | 各面开关 |
| `evalMode` | `false` | **仅评估用**：为 true 时额外注册 `memory_eval_dream`（正常使用不要开启） |
| `contextOrder` | `850` | 注入 context 的排序 |

## 数据安全与可恢复性

- **软删除**：`/memory delete`、UI、HTTP 与 dream 的 delete 操作都移到 `<projectDir>/.trash/<ts>/`（可手工恢复），不会物理删除。
- **覆写历史**：`saveEntry` 覆盖已有文件、`updateEntry`、`writeRawEntry`（含 dream apply）在写入前把旧内容快照到 `<projectDir>/.history/<file>/<ts>-<hash8>.md`；`keepHistory`（默认 true）、`historyMaxPerFile`（默认 20）控制，失败不阻塞主写入。
- **索引一致性**：每次 dream apply 之后调用 `reconcileIndex()`：索引缺失的文件自动补一行、指向不存在文件的悬空行移除，避免「文件在磁盘但永远不注入」的孤儿。
- **计划可审**：dry-run 的 `plan.json` 与 review 提案都保留在磁盘；`/memory dream apply` 执行的就是这份计划；v7 起可 `preview` 逐条看 diff，并用 `apply-ops` 只应用选中条。
- **失败可回滚**：apply/apply-ops 中途任何错误 → 用本次备份恢复记忆目录与索引，`rolledBack: true`，changelog 记录。
- **可恢复**：`.dreams/<ts>` 备份与 `.trash/<ts>` 回收站可通过 `/memory backups|trash`、UI「备份与回收站」卡或 `POST /restore` 恢复整批/单文件（写 changelog + reconcile）。
- **provenance**：新写入的记忆 frontmatter 带 `created`/`source_session`/`via`（tool/command/dream），可追溯来源；`/memory list` 与 UI 文件行展示。
- **机密扫描**：写记忆/改规则/dream 写文件前扫描 19 条规则（AWS key、私钥块、sk-*/sk-proj-/sk-ant-、github_pat_/gho_/ghp_、AIza、JWT、密码连接串、中文「密码：」、slack 等明确格式 → **deny 拒写**；Bearer、`api_key=`/`password=` 赋值、高熵 base64 → **warn**）；`secretScan: warn|deny|off`（默认 warn，明确格式的密钥即使在 warn 下也拒绝；deny 全部拒绝；off 跳过），只记录前 12 字符摘要，不入日志。
- **效果指标与成本**：`<projectDir>/.metrics.json` 记录注入/读写/search/dream 接受率/最近成本（跨进程安全）；`/status.metrics`、`GET /metrics`、`/memory metrics` 与 UI「效果」卡可查；`dreamMaxTotalTokens` 超限告警（不阻止应用）。

## 与 Claude Code 的差异（有意为之）

- **Dream 产物可审计**：JSON 计划 + 备份 + changelog；删除只进入可恢复的 `.trash/`（`dreamAllowDelete:false` 可关闭）。
- **截断保护**：输入被截断的文件不允许被整份重写，也不允许删除，防止把长文件改短。
- **证据门槛**：Dream 新增的事实必须引用能在原文找到的内容；`user`/`feedback` 类记忆必须引用用户亲口说的话，转发的报告和工具输出不算。
- **注入稳定**：会话开始注入一次索引并冻结，compaction 时刷新；DSH 的 runtime context 是尾部 user 消息（不进系统提示前缀），文本不变时不会重复追加。Claude Code 需要压缩后从磁盘重读。
- **不重造 CLAUDE.md 层**：DSH 原生 `dsh-agent-instructions` 已加载 `AGENTS.md`/`CLAUDE.md`/`CLAUDE.local.md`。
- **自动 dream 默认关闭**：避免未经确认的后台改动。
- **记忆是背景上下文**：注入文本明确「可能过时，不覆盖 system/developer/user 指令与 AGENTS.md/CLAUDE.md」，与官方「context, not enforced configuration」一致。

## 更新、兼容与回滚（插件化约定）

**更新什么、要做什么**

| 改动 | 生效方式 |
|---|---|
| 只改 `client.js` / `locale/*.json` | 刷新页面即可（客户端产物按 revision 提供，无需重启 Host） |
| 改 Host 代码（`index.js`、`src/*.js`） | 让 Loader 重新加载该行：`plugin_manager set_plugin include:cc-dream-memory enabled=false → true`（或重启 App）。数据与记忆目录不受影响 |
| 只改 `package.json` 版本号（`src/meta.js` 未动） | 行重载不会更新已缓存的 `VERSION`（Loader 只重新 import 有变化的模块）；需 touch `src/meta.js` 或重启 App。升级流程里通常同时改了代码，不受影响 |
| 完整安装/升级 | `plugin_manager install_bundle <绝对路径>`；版本号见 `package.json`，变更记入 [CHANGELOG.md](../CHANGELOG.md) |

**为什么更新不容易炸**

- **依赖最小化**：硬依赖只有 `tools` + `systemPrompt`；`commands`、`agents`、`workingDirectory`、`webServer` 全部通过 `ctx.get()` 可选解析，缺失时各自降级（无斜杠命令 / 无 per-agent 缓存 / cwd 回退 / UI 降级命令模式），不再因为某个 profile 少一个服务就让整个插件 inactive。
- **不依赖 DSH 内部实现**：不读安装目录/asar 内部路径、不做版本号猜测，只用文档化服务契约与特性探测（`typeof x === 'function'`）。
- **单点失败不扩散**：每个能力 `mount()` 独立 try/catch；`apply()` 整体 try/catch——插件初始化失败只打一行日志，不抛给 Host。
- **注册全部可清理**：prompt context、事件监听、定时器、HTTP 路由、index tap、工具、命令全部返回 disposer，统一挂在插件 `ctx.effect` 下；重载/卸载后不留监听、定时器或半注册状态（可反复 reload）。
- **数据读取全容错**：`state.json` / `.plugin-state.json` / `memory-rules.md` 损坏或字段未知 → 回退默认并继续；索引孤儿/悬空行由 `auditIndex/reconcileIndex` 修复并记入 health warnings。
- **数据与版本解耦**：记忆在 `~/.dsh/cc-memory`（`DATA_SCHEMA: 1`），插件升级/回滚不迁移、不删除数据。

**健康检查**

- `/api/cc-memory/status` 返回 `version` 与 `health{ok,warnings,services}`；
- `/memory status`、UI 健康卡与 `/status` 返回 `version` / `health` / `rules`（模型侧已无 `memory_status` 工具）；
- `/memory` 状态显示版本，并在有 warning 时列出（规则截断、索引缺失/悬空、上次 dream 失败、待审提案、可选服务缺失）。

**回滚/恢复**

- 卸载 bundle 不影响 `~/.dsh/cc-memory`；
- 删除 `~/.dsh/cc-memory/.plugin-state.json` → 恢复 yml/默认开关；
- 删除 `<projectDir>/memory-rules.md` 或 `~/.dsh/cc-memory/memory-rules.md` → 恢复默认规则；
- 删除 `<projectDir>/.state.json` → 重置 dream 状态；
- 删除整个 `~/.dsh/cc-memory` → 清空记忆（建议先备份 `.trash/` 与 `.dreams/`）；
- 旧版本插件可继续读取 `DATA_SCHEMA: 1` 的数据文件。

## 开发与验证

```powershell
# 语法检查
node --check index.js
node --check client.js

# 单元测试（Node 24 用 glob 形式；直接 `node --test` 也可自动发现）
node --test "test/*.test.mjs"

# 汇总验证（结构 + 语法 + 全量测试）
node scripts/verify.mjs
```

集成验证在 Harness 内进行：`plugin_manager` 安装/重载 → `cordis_inspect_list` 确认工具（应为 4 个：save/update/read/search）→ 调用 `memory_save` / `memory_search` → `/memory status`、`/memory dream run --dry-run` → apply last plan → Web 页面刷新。

## 已知限制

**与 Claude Code auto memory 的已知差异**

- Worktree 已共享主仓库记忆；Windows 盘符大小写已归一。
- 超预算时注入最早 + 最新条目并提前提醒；模型可用 `memory_update` 合并与删除。
- 子代理默认不注入；但子代理若显式开启写入，仍共享项目存储（官方子代理有独立目录）。
- 自动召回是**词面匹配**：换一种说法就可能召回不到，没有 embedding，也不会让模型挑选文件。
- Dream 不提供工具读取（没有 fact-check 工具），而是把文本送给模型；单次最多读 `sessionLookback` 个会话、`dreamMapMaxChunks` 块，读不完的留到下一轮。
- **证据校验的边界**：结构化引用检查逐行覆盖和来源位置，仍不能证明语义推断正确；旧字符串引用只有操作级覆盖，手动纯整理不强制引文，自动语义改写必须待审；粘贴检测（`[user-pasted]`）是启发式，短粘贴和转述识别不出。
- “写入混入推断”：已加默认规则（区分用户原话与推断），**效果未验证**；规则是否真的减少推断混入，需要下一轮评测。

**仍未做 / 待观察**

- ⏳ **效果价值评估**：v8 已统计“使用量/接受率/neverRead/成本”，但还不能证明记忆“让回答更好”；需要 A/B 或人工评估层（路线图第一优先级）。
- ⏳ **浏览器 E2E**：v7/v8 新 UI（diff/恢复/效果卡/成本）有 vm+shim 测试，仍需真实页面刷新验收；无 Playwright 覆盖。
- ✅ 项目身份已补 marker/config `projectId` 与 user 独立空间；**团队/多用户共享**仍未设计。
- ✅ v10 已实现与 Claude Code 记忆格式互通（`/memory import|export`，含 `.claude/rules` 导出）。
- ⏳ 机密扫描仍是启发式（格式规则 + 熵），无 HTTP 限流；本机多用户/权限隔离未做（单用户设计）。
- ⚠️ `apply-ops` 成功后按“完成一次 dream”处理（更新 cadence、清 sessions/plan），但不移动水位线；若只想部分应用而保留计划，需要额外语义。
- ⚠️ 直接 `apply`（无 plan 文件）时 `runtime.dream().path` 返回 backupDir；dry-run/review 返回 plan/proposal 路径。
- ⚠️ dream 锁冲突在 HTTP 侧以 `{ok:false,error:'dream-locked'}`（结果对象）返回，未映射成 409；UI 以错误文案呈现。
- ⚠️ 客户端视觉（挂载/交互细节）需在真实页面刷新后验收；仓库内已有 vm+React shim 测试，但不是浏览器 E2E。
- ⚠️ review 提案未 apply/reject 前会阻塞自动 dream（有意的「等人处理」语义），默认 72h 后自动归档解除。

**语义/边界**

- 默认 `injectionMode: 'session'` 下，本会话新写的记忆不会立刻出现在注入文本里；其他会话的更新要到下一个会话生效。需要实时刷新可设 `injectionMode: 'live'`。
- `runtime.context` 是**尾部 user 消息**（`agent-loop`: `messages:[...claimed, context]`），文本不变不重复追加；`session` 冻结把变化限制在会话边界/compaction。
- 浏览器版（Chrome）访问必须使用 `dsh web` 打印的带 token URL，桌面版不受影响；历史里已经产生的旧 `memory · …` 轨迹行不会被删除（只保证不再新增）。
- 运行时开关（`/memory plugin on|off`、UI pills）写在根目录 `.plugin-state.json`，是**全局**的（影响所有项目）；UI 与命令输出都标注「全局」。
- 覆盖率（v7 前）：行 79% / 分支 62%；`client.js` 已有入库测试，scheduler/commands/tools 分支覆盖仍偏低。


