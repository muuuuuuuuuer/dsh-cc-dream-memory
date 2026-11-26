# 使用手册

这是完整的中文手册，安装和入门请看 [README.zh.md](../README.zh.md)。架构和 DSH 集成机制见 [ARCHITECTURE.md](ARCHITECTURE.md)。

Dream 副本就绪后，点文件名展开对照。索引 `MEMORY.md` 也可在切换前查看。

## 记忆放在哪

```
$DSH_HOME/cc-memory/
  projects/<workspace-slug>/
    .state.json            # 插件状态（上次 dream、待处理 session、待切换的副本）
    .dream-log.md          # 每次 dream 与切换的 changelog
    .dreams/<ts>/          # 切换前的完整备份 + meta.json（撤销用）
    .dreams/shadow/        # Dream 写出的记忆副本，等你切换或丢弃
    .consolidate-lock      # dreaming 并发锁（PID + 1h TTL）
    memory/
      MEMORY.md            # 索引：一行一条 `- [name](file) — description`
      user_role.md         # topic 文件：frontmatter(name/description/type/modified) + 正文
```

`<workspace-slug>` 由工作区（或最近的 git 根）推导，格式与 `~/.dsh/sessions` 的目录命名一致（如 `--C-Users-me-repo--`），所以同一仓库的所有会话（含 git worktree）共享一份记忆。

记忆是**纯 Markdown**，可以随时手工查看、编辑、删除；删除整个 `cc-memory` 目录即清空记忆。

## 模型侧工具

模型侧**只有 4 个工具**（描述 + JSON Schema 总预算 ≤3000 字符）：

| 工具 | 作用 |
|---|---|
| `memory_save` | 新增一条记忆（name/type/description/content）；可带 `citations`（本会话里的原话，宿主核验；含用户亲手写的原话时记为已核实）；几乎重复或同主题反义只在回执里附 `advisory`，仍会写入，由模型决定是否合并 |
| `memory_update` | 更新正文/描述；`old_text`+`content` 只替换一段，旧段落进 `## History`；同款 `advisory`；传 `name` 改名（保留 created/provenance，旧文件进回收站）；传 `delete:true` 软删除（进回收站，可恢复） |
| `memory_read` | 读取一条记忆的当前内容（已退休/被替换的旧值不返回），附 `ageDays`；满 30 天再加 `staleness`，提醒先核实再引用 |
| `memory_search` | 相关度排序检索（name/desc/body 权重 + phrase + recency + type/limit，返回 score/snippets） |

人类操作面（不占模型工具预算）：`/memory [status]`、`/memory search`、`/memory dream`、`/memory undo`、`/memory session`、`/remember`、Web「记忆 / Dream / 设置」页与 HTTP API。

类型：`user`（用户角色/偏好）、`feedback`（纠正与已确认做法）、`project`（代码与 git 推导不出的进行中工作/决策）、`reference`（外部信息在哪找）。

## 与 Claude Code auto memory 的对齐

本项目把「日常记忆」按 Claude Code 的 auto memory 语义实现：存储布局、索引预算、项目/worktree 共享与类型体系对齐；v23 起**默认用模型 selector 召回**，**默认开启 5-turn 自动抽取**，子代理独立目录可选，但团队与 Dream 形态仍有差距。完整对照（2026-11-13 基线）见 [ARCHITECTURE §5.6](ARCHITECTURE.md#56-与-claude-code-auto-memory-的对照)。

**一致的默认行为**

| 方面 | 行为 |
|---|---|
| 入口 | 首轮把 `MEMORY.md` **原文**注入上下文（前 200 行 / 25KB）；topic 文件不预载，每轮 selector 最多挑 5 条，实际附加受 `autoRecallMaxFiles`（默认 3）约束 |
| 上限 | 只读前 200 行或 25KB（先到为准），超出部分不加载；写索引后若超限，写入仍成功但回执带 error，要求重写索引；索引行超过约 200 字符会截断 hook，详情留在 topic 文件 |
| 位置 | 一个项目一份记忆，共用同一 git 根（含 worktree）；默认 `$DSH_HOME/cc-memory/projects/<slug>/memory/`（官方是 `~/.claude/projects/<project>/memory/`，布局同构） |
| 格式 | `- [Title](file.md) — one-line hook`；无描述就是裸指针；`modified` 为 ISO 8601 |
| 类型 | `user` / `feedback` / `project` / `reference` 四类 |
| 开关 | `enabled` / `autoMemoryEnabled` 控制；`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 直接关闭 |
| 不记什么 | 代码库能读到的（架构、路径、修 bug 过程）、一次性任务、密钥，以及 `memory-rules.md` 已写的 |

**主要差异**

| 维度 | 官方（2026-11） | 本插件（v23） |
|---|---|---|
| 写入时机 | 每轮 query loop 后 forked agent 自动抽取，主 agent 已写则跳过，5-turn 预算 | `autoExtract` 默认开：主线 `turn/end`、本 turn 主 agent 写过则跳过、默认每 3 个 turn 一次、进程内 5-turn 工具循环，只读游标之后的转写；写入直接过 `memory_save` 门 |
| 召回 | 每轮一次 Sonnet selector，最多自动附 5 个主题文件 | `recallMode:'model'`：按标题、简介和当前正文搜候选，再由模型从清单最多选 5 篇，实际附加受 `autoRecallMaxFiles`（默认 3）限制。超时或失败时跳过本轮召回。 |
| 系统提示 | 完整 auto-memory 段：类型+scope、保存/不保存清单、Why/How、漂移核验 | 19 行紧凑手册：四类型、保存/不保存、Why/How、绝对日期、推荐前核验；无 team |
| 子代理记忆 | 子代理可用 frontmatter `memory` 拥有 user/project/local 目录，快照合并 | 单一 `subagentMemory`：`off` 不注入/不可写，`shared` 项目库读写，`own` 用 `agents/<preset>/memory`（`agentMemoryPresets` 可限制）；无快照合并 |
| 团队记忆 | `team/` + 服务器同步 + secret scanner | 无 |
| Dream | 4 阶段 agent：grep transcript、对照代码库、CLAUDE.md 对账、直接落盘 | 分析器 + 主机合并 + 引用核验 + shadow + 人工切换；不读代码库，输入受预算约束 |
| 配置 | `autoMemoryDirectory`、`CLAUDE_CODE_PROJECT_DIR_NAME`、每项目开关 | 全局 `memoryRoot`/`projectId`；子代理目录按 preset；无 per-project 开关/目录 |
| 文件工具 | 标准 Read/Write/Edit | `memory_*` 专用工具 |

**插件独有、可调的能力**

| 配置 | 默认 | 作用 |
|---|---|---|
| `autoExtract` | `true` | turn/end 后自动抽取；进程内 5-turn 工具循环，写入直接过 `memory_save` |
| `subagentMemory:'own'` | `off` | 子代理使用自己的 `agents/<preset>/memory`，与主库隔离；Dream 会只读这些私有笔记，把站得住的内容合并进项目笔记（私有库不会被改写） |
| `autoDreamEnabled` | `false` | Dream 自动整理 |

**安全取舍**：索引原文注入意味着手工改 `MEMORY.md` 会直接进上下文（官方同样如此）。插件只保证「正常写入时按笔记元数据生成索引行」，不再过滤手改行；需要审查就关闭 `autoMemoryEnabled` 或删掉行。

**写入与提示词**：`memory_save`/`memory_update` 直接落盘、无待审队列，与官方一致；默认开启的自动抽取也只走这条写入门，不另建暂存路径。提示词是 19 行紧凑手册，覆盖了官方的写入质量规则，但不是完整 auto-memory 段的等价实现。

## 斜杠命令

日常与排障使用精简后的命令集合，浏览、编辑、删除、规则与恢复操作收拢在 Web「记忆」面板和 HTTP API 中：

- `/memory`（或 `/memory status`）— 状态总览：开关状态、索引大小、条目数、本会话策略、归档候选、待审 Dream 状态与健康警告。
- `/memory search <query> [--type= --limit=]` — 按标题、简介和当前正文检索（附 score 与片段）。
- `/memory dream status [runId]` — 查看 Dream 状态、待切换副本、最近运行或指定 `runId` 进度。
- `/memory dream run [--focus <主题>] [--memory-only] [--wait]` — 跑一轮整理（写进 `.dreams/shadow/` 副本，原记忆不动）；`--memory-only` 只整理已有笔记、不读对话；`--wait` 等待完成。
- `/memory dream estimate [--memory-only]` — 估算本轮 Dream 输入 token。
- `/memory dream resume <runId> [--wait]` / `/memory dream cancel [runId]` — 从检查点继续暂停的运行，或中止运行中任务。
- `/memory dream diff <file>` — 查看某页待切换改动的行级差异、引用核验状态与历史拒收记录。
- `/memory dream switch [--reject 文件,...] [--defer 文件,...] [--confirm 文件,...]` — **应用副本里通过的修改**（先整目录备份，写 changelog；可用 `/memory undo` 退回）。
- `/memory dream discard` — 暂缓本轮副本，原记忆不变，相关会话留待下次复查。
- `/memory undo` — 撤销最近一次切换（只还原被那次切换改过的笔记并把新建文件移入 `.trash/`，其余保持你的修改）。
- `/memory session [status|use on|off|learn on|off]` — 控制当前对话是否加载/召回记忆（`use`）以及是否参与自动抽取和 Dream（`learn`）。
- `/remember [--type=user|feedback|project|reference] [--force] <内容>` — 自动命名取正文首行前 32 个字符（支持中文，不互相覆盖，不在英文单词中间截断）。和已有记忆重复或矛盾时拒绝写入，加 `--force` 强制保存；会列出相关记忆供你核对。

开关类设置（`enabled` / `autoMemoryEnabled` / `autoDreamEnabled` / `autoExtract`）可在 Web「设置」页顶部开关或 `POST /api/cc-memory/toggle` 实时切换（写入根目录 `.plugin-state.json` 运行时 override，立即生效，无需重启）。真正卸载/移除插件仍需 Plugin Manager 或 profile yml。

## 可编辑的注入规则

每次请求注入的「哪些值得记住」规则是**用户数据**，按以下优先级读取（全部为纯 Markdown，可随时手改）：

1. 项目覆盖：`<projectDir>/memory-rules.md`
2. 全局覆盖：`<memoryRoot>/memory-rules.md`（默认 `~/.dsh/cc-memory/memory-rules.md`）
3. 内置默认（6 条 bullet，与 Claude Code 的 auto memory 指南对齐）

- 在 Memory 页的 **Rules 卡**里可直接编辑、保存到 project/global、或删除覆盖恢复默认；保存后立即生效（下一次请求注入新规则）。
- 上限 8000 字符（`rulesMaxChars`），超长会被拒绝；文件行内容原样注入。

## 注入策略：会话开始注入一次，然后冻结

每个会话使用一份注入快照。

1. **第一轮就注入**：模型不知道有记忆就不会去查（只给 `memory_search` 工具，大部分记忆永远不会被用到）；「中文回复」「先看结论」这类偏好/纠正必须从第一句就生效；只注入索引成本很低（当前 5 条约 300 token），正文按需 `memory_read`。
2. **会话内冻结**：首次构建后，记忆写入和 Dream 切换不会自动刷新本会话的快照。
   - 本会话自己写的记忆已经在对话历史里，不需要重复注入；
   - 其他会话的更新在**下一个会话**生效；
   - **compaction 时刷新一次**（`compaction/*` 会话事件），因为那时请求前缀本来就要重算。
3. 配置或规则变更会刷新快照。
4. 子会话由 `subagentMemory` 控制，`off` 关闭，`shared` 共享项目库，`own` 使用 preset 的独立目录。

> 实现说明（已核对 DSH 源码）：`systemPrompt.context` 渲染出的 runtime context **不会进入 system prompt 前缀**，而是作为一条**尾部 user 消息**追加（`agent-loop` 里 `messages: [...claimed, context]`），且文本不变时不会重复追加。所以冻结的主要收益不是"保住前缀缓存"，而是避免每次记忆变化就往历史里多塞一条快照消息（token 增长），并让会话上下文稳定、可预期。

## Web 视图

会话标题栏的视图切换里出现 **Memory / 记忆** 标签（`conversation.view`，id `cc-memory`，order 40）——不在左侧栏。页面顶部固定标题与三个标签（**记忆 / Dream / 设置**），下面是可滚动内容：

- **记忆**（默认）：搜索框（名称/描述本地即时过滤，≥2 字时再用 `/search` 补正文命中并显示片段）+ 类型/可信状态筛选 + 按更新时间排序的列表。点一条在右侧打开详情（Markdown 渲染、来源、更新时间），可**编辑**（名称/类型/摘要/正文，Ctrl+Enter 保存）或**删除**（两段确认，进回收站）；「新建」直接写一条。
- **Dream**：一条流程——「Estimate the run」估算输入 → 「Start the dream run」跑一轮，结果写进**记忆副本**（原记忆不动）→ 卡片显示「新增 N / 修改 N / 删除 N」与变更文件，每处 diff 可展开，并列出该改动用到的 `session #seq — quote` 证据，支持逐页 Pass/Reject 或 Switch/Discard。下方是本工作区对话整理状态、上次Dream时间与就绪说明、索引大小进度条，以及「最近Dream」列表（最新一次切换可用撤销回退）。
- **设置**：四个全局开关（记忆功能 / 自动记忆 / 自动Dream / 自动抽取，注明对所有项目生效）、常量只读说明（召回模式、子代理策略）、记忆规则编辑（保存到本项目 / 保存为全局 / 恢复默认）、回收站与Dream前备份（整批或单文件恢复）、记忆目录（可复制）与一行使用情况。
- 成功/失败用底部 toast 提示；破坏性操作都是两段确认；跟随宿主亮/暗主题变量；容器宽度 ≤720px 时变单列，详情页带「返回」。
- 输入框下方 dock 的状态 chip（`conversation.composer.dock`）：`记忆 N`，有等待切换的 Dream 副本时追加「N 项待处理」，60 秒轮询。

效果指标趋势、文件历史、合并与导入/导出可通过 HTTP API 查询。

**数据通道是静默 HTTP API**：`GET/POST /api/cc-memory/*`；loopback + `x-cc-memory-token`（token 持久化在 `~/.dsh/cc-memory/.api-token`，插件重载不再失效）+ 只接受 loopback 来源 + POST 校验 Origin；写 rules 会追加审计到 `<projectDir>/.memory-rules.log`（scope/source/bytes/sha256）。页面拿不到 API（加载早于插件安装/重载）时显示明确 banner 和「刷新页面」按钮，不再静默降级为命令模式；`enabled:false` 时除 `/status`、`/toggle` 外一律返回 `plugin-disabled`。

API 端点：`GET /status`、`GET /file`、`GET /rules`、`GET /log`、`GET /search`、`GET /backups`、`GET /trash`、`GET /metrics`、`POST /rules`、`POST /toggle`、`POST /dream`（`run|start|status|cancel|resume|switch|discard|estimate|undo`）、`POST /delete`、`POST /restore`、`POST /merge`、`POST /import`、`POST /export`。

## Dream（后台整理）

自动 Dream 需要开启 `autoMemoryEnabled` 和 `autoDreamEnabled`，并满足运行间隔 `minHours`（默认 24）、扫描节流、失败退避和锁检查。已有待切换副本时暂停新运行。复查对话须积累 `minSessions`（默认 5）个待复查的主线会话。维护用户纠正过的笔记或失效来源可以单独启动，待复查会话继续排队。teammate/subagent 会话（`parentSession` 或 `origin: 'subagent'`）不计入主线会话。

一次 Dream：

1. **收集（纯读取）**：先取状态中登记的主线会话，再查同一工作目录的未处理会话；同时读取 topic 文件。读取失败会记录错误。
2. **转写**：宿主注入的内容（指令、runtime context、技能目录、自动召回）一律不进转写。每段带标签：`[user]` 是用户打的字，`[user-pasted]` 是用户转发的长材料，`[assistant]` / `[tool-call]` / `[tool-result]` / `[tool-error]` 是过程记录，并带 `--- YYYY-MM-DD ---` 日期标记。
3. **分批复查**：按已选对话范围提取带原文引用的事实。Dream 完成一批就提交，处理完成的连续范围才推进会话游标。
4. **整理**：模型输出要写入哪些笔记（name/description/type/body）与哪些笔记该退休，可用 `--focus` 指定这一轮优先关注的主题。
5. **校验**：路径必须在 memory 目录内、只允许 `.md`、笔记数与正文长度有上限；单条正文超过 `dreamMaxFileChars` 的不写入。
6. **证据检查**：读过会话时，新事实须有操作级引用，宿主核对引用是否存在并记录真实来源；新 `user`/`feedback` 事实仍须有 `[user]` 来源。完整既有用户类记忆的原句可跨文件搬运，不必重读旧会话；项目/参考记忆不能借此升级成用户偏好。引用存在不证明语义正确。宿主列出正文删行并告警；任何写入被过滤，相关批次的删除改动一并停用。
7. **副本而不是直接写**：分析结果先写进 `.dreams/shadow/`（当前记忆的完整副本），与当前记忆逐文件比对得出新增/修改/删除。没有差异时这一轮记为 `nothing-new`；有差异时把副本路径与差异清单记进 state，等你切换或丢弃。
8. **切换**（`/memory dream switch` 或 UI）：先把当前记忆目录整目录备份到 `.dreams/<ts>/`，再把副本文件写回、把副本里删掉的文件移入回收站、把副本的 `MEMORY.md` 写回并重建索引（`MOVED TO` 退休桩保留），写 `meta.json`（含每个文件切换后的哈希）与 changelog；之后可用 `/memory undo` 退回去。
8b. **冲突与退休留在页面上**：同一条事实在两处给出不同的值、宿主又无法判定该替换哪一行时，页面里会留一行 `- CONFLICT: "<旧值>" vs "<新值>" — the sources disagree; a person has to pick one. ^[…]`，两边的引文都在，重复运行不会叠加；模型判定某页内容已并入另一页时（`retire`），该页被删除、索引留下 `- [名字](旧文件) — MOVED TO [[目标]]`，旧名字仍然找得到去向。索引是扁平列表（`- [名字](文件) — 说明`），与 Claude Code 的 `MEMORY.md` 一致。
9. 写副本 → 重建副本索引 → 与当前记忆比对 → 追加 `.dream-log.md` → 更新 state → 释放锁。
10. 中途失败不回滚已写到副本的东西（副本不是记忆）：切换时若发现某个文件在运行期间被改过或删过，切换直接返回 `conflict` 并列出文件，原记忆完全不动。
11. **成本/耗时**：changelog 与 state 记录 `durationMs`/`inputChars`/`outputChars`/`usage`（含分块分析），`/memory status` 可查。
12. **换回**：`/memory undo` 只还原「这次切换改过的文件」，只把「这次切换新建的文件」移到回收站；其它笔记（包括你自己在切换后改过的）一律不动。若被切换改过的文件你又改过，undo 返回 `conflict` 并列出文件。

**水位线**：每个会话读到哪一步（`seq`）、是否读完，都记在 state 里，**只有切换成功才推进**。没切换、失败都不移动水位线；撤销一次切换会把那批会话放回待处理，下一轮重新覆盖；只读了一部分的长会话下一轮从断点继续；已读完的会话有新内容时只读新增部分。

**Wiki 页面。** Dream 还会把跨多条笔记和多个会话的主题（一种工作流、一个模块、一套环境、一类设备）综合成 wiki 页面：扁平文件 `wiki_<名称>.md`，frontmatter `type: wiki`，写明做法、适用条件与例外、如何验证、陷阱，并用 `[[文件名]]` 链接相关页面和笔记；页面比它所取代的笔记更短。只有 Dream 写 wiki：主会话、auto-extract、子智能体能读（`memory_read`、`memory_search`、召回），不能写，也不能在面板里编辑，只能删除（可撤销）；要纠正一个页面，保存一条带正确事实的笔记，Dream 会并入页面。宿主只守硬边界：新页面里的每个链接必须指向存在的页面或笔记，被页面链接的文件不能被删除，单页不超过 `wikiPageMaxChars`（默认 8000 字符）、全部页面合计不超过 `wikiTotalMaxChars`（默认 40000），否则该次提交被退回并说明；每次提交的回复都带当前用量，审阅页显示 wiki 页数与字数的前后变化。一条笔记被某页面完整覆盖时，Dream 用 `moved_to` 删除它，二者在审阅中是同一个决定（拒绝页面时笔记也保留）。`MEMORY.md` 先列 wiki 页面再列笔记。页面的第一条 `STATUS:` 决定整页是否“当前”，所以让当前页面变成 `stale/superseded/…` 的改动会被拒绝，除非该改动明确写 `retire: true`（退役请用 delete）；主会话的 `memory_save`/`memory_update` 同样拒绝，且没有覆盖开关。导出到 Claude Code 时 wiki 页面按普通 `reference` 笔记写出；导入时名为 `wiki_*.md` 的文件还原为 wiki 页面。

开始前可以用 `POST /dream {action:'estimate'}`（界面的估算按钮）查看粗略的输入 token 用量。每轮 Dream 用一个宿主子智能体（`standard` 预设）。它拿到当前索引、可疑笔记清单和最多 `dreamMaxTasks` 个候选会话（最近未整理的会话，加上可疑笔记所来自的会话），自己决定读哪些，提交带引用的改动。Dream 的主要工作依次是：提炼跨会话的教训（反复出现的错误、变通办法、做成一件事的方式及其验证；以工具结果为准，助手说“已修好”只是声明）、让笔记与实际发生的事一致、让索引保持小而高信号。它看到的会话转写包含工具调用与结果（带退出码等尾部标记），宿主能搜索时还可用 `dream_search_sessions`、`dream_search_events`、`dream_read_event` 在本项目允许的其他会话里查找；这些会话不计入已整理，读过的事件可被引用。宿主只核对引用的原话确实在对应的会话事件或笔记里，并记下是谁说的（用户、用户粘贴、助手）。会话读到末尾或被子智能体标为“没有可复用内容”才算已整理，其余留到下一轮。每次提交后插件保存检查点。运行暂停且检查点有效时，可以用 `/memory dream resume <runId>` 继续。来源变动导致检查点失效时，需启动一轮新的 Dream。

安全默认：自动 dream 关闭；删除默认开启但只做软删除（进 `.trash/`，可恢复）；每次改动有备份与 changelog；记忆只是背景上下文（注入文本明确「可能过时，不覆盖 AGENTS.md/CLAUDE.md 等指令」）。

## 写入边界

- `memory_save` 与 `memory_update` 都直接落盘（与 Claude Code 的 auto memory 一致，没有待审队列）。重复与反义事实不再停写，只在回执里报告。旧的 `basis`/`evidence`/`confidence`/`force` 参数仍可传，会被忽略。
- 重复与反义事实不拦，只在回执里带 `advisory:true`、`candidates`、`conflicts` 与 `hint`，模型自己决定要不要合并。`citations` 里不成立的原话列在 `citationProblems`，同样不拦写入。
- 改已有笔记时工具带上读到的版本哈希，存储层在写锁内比对；期间被别的窗口改过则返回 `STALE_WRITE`，不会静默覆盖。
- UI 保持冻结；所有行为走已有工具、命令与页面。

## 写入策略：重复与冲突（v24）

`memory_save`/`memory_update` 写入前先过 `src/policy.js`，结果只作提示（`/remember` 对人仍会停下）：

| 判定 | 阈值/条件 | 行为 |
|---|---|---|
| `allow` | 无相似、无冲突 | 正常写入（带 `advisory` 时只是提示） |
| `duplicate` | 与已有条目相似度 ≥ 0.82 | 照常写入，回执附 `candidates` 与 hint |
| `possible-duplicate` | 0.55 – 0.82 | 照常写入，回执附 `candidates` 提示 |
| `conflict` | 同主题语句 + 极性相反（喜欢/讨厌、用/不用、always/never…） | 照常写入，回执附 `conflicts` 与 hint |

- 相似度：CJK 单字+bigram、latin word 的 Dice 系数，name/description/body 加权。
- 设计原则：**写入端只守硬边界（出处存在、密钥、路径、大小、版本）**；两条笔记是否重复或矛盾由模型判断，整理交给 Dream。

## 项目身份与多记忆空间（v9）

记忆目录由 `src/identity.js` 决定，优先级：

1. 配置 `projectId`（最明确，适合非 git 目录/多人共享）；
2. workspace 标记文件（向上查找）：`.cc-memory.json`（`{"projectId":"my-project"}`）或 `.dsh-memory-project`（纯文本 id）；
3. git 仓库根；
4. 普通工作目录（**会提示“多个会话共享记忆”的健康警告**）。

非 git 工作区想隔离时，在项目根放一个标记文件即可：`echo '{"projectId":"rent-calculator"}' > .cc-memory.json`。

只有一份记忆目录（项目级），对齐 Claude Code 每个项目一份；注入预算默认 **200 行/25KB**（先到为准），超限时写入仍成功、回执带 `error` 要求重写索引。

## 会话内即时刷新（v9）

冻结注入的默认策略不变（第一轮注入、会话内稳定），但不再“只能等下一个会话”：

- `/dream run|status|switch|history|undo`：等价于 `/memory dream …`。
- `/memory refresh`（命令/UI）：**立即重建当前会话注入**（冻结模式也强制）；
- 配置/规则变更、compaction 仍照旧刷新。

## dream 就绪度、健康度与成本模式（v9）

- **就绪度**：`/memory dream status` 与 UI Dream 卡显示 `eligible`、`nextEligibleAt`、阻塞原因（auto 关闭/未到 24h/会话数不足/节流/退避/有等待切换的副本/锁）；`/status.readiness` 可机读。
- **健康度**：0–100 分 + 维度（索引预算、neverRead 比例、dream 是否过久、截断文件、规则、身份共享）+ suggestions（over-budget / many-never-read / non-git-sharing / rules-truncated）；UI 徽标 + 折叠建议。
- **副本不过期**：Dream 写出的副本一直等你处理，不会自动消失，也不阻塞自动 Dream 以外的任何东西。
- Dream 以本批工作完成为结束条件，状态会记录模型用量。自动运行由 `/memory dream on|off` 管理。用 `/memory dream cancel <runId>` 停止正在运行的任务。

## P1 新增：恢复/编辑/检索/指标/互通/一致性（v10）

- **恢复语义**：每次切换生成 `.dreams/<ts>/meta.json`（含被改/新建/删除的文件与切换后的哈希）；`/memory undo`（或 UI Dream 历史里的 Restore）只还原被那次切换改过的笔记、只把新建的文件移入 `.trash/`，其余保持你现在的修改；连续 undo 会逐个批次回退；Dream 标签的历史列出批次。
- **编辑/合并/审计**：`POST /file`、`POST /merge`、`GET /file-history` + UI（Edit 表单、文件多选 Merge、History 折叠）替代“只能靠工具改”。
- **检索**：`memory_search` + `/memory search` + UI 搜索框；相关度 = name(5)/description(3)/body(1) + phrase bonus + 30 天 recency，支持 type/scope 过滤与分页；语义检索（embedding）仍留作路线。
- **指标价值**：daily 桶（60 天）、adoption 计数、dream quality（appliedOps/planOps、dropped、rollbacks、applyRate/dropRate）；`GET /metrics?days=7` 与效果卡 7 日趋势。
- **Claude Code 互通**：`/memory import <dir>` 读取 CC 的 `memory/MEMORY.md`+topic 文件（有/无 frontmatter 均可，重复跳过）；`/memory export <dir>` 产出同款布局 + `rules` 写到 `.claude/rules/dsh-memory.md`。
- **团队/子会话**：`subagentMemory` 明确归属；所有写工具/写命令对 `off` 模式下的 subagent 返回 `subagent-readonly`，只读工具照常；`shared` 写项目库，`own` 只写自己的目录。
- **事务一致性**：`src/lock.js` 跨进程写锁包裹 store 所有 mutating 方法（`.write.lock`，TTL 30s），与 dream 的 `.consolidate-lock` 互补；各 op 写入 + reconcile 仍是“最终一致”，不是跨文件事务。
- **会话压缩**：压缩后从当前 `MEMORY.md` 重建快照。

## 撤销、工具和写入策略

- **撤销 Dream**：从切换记录恢复改过的笔记，将新建文件移入回收站。发现后续修改时整批返回 `conflict`，避免覆盖用户改动。旧格式记录不参与撤销。
- **模型侧 4 工具 + recall 并入 search**：工具定义总量受 3000 字符预算约束；list/status/dream/refresh 仅通过 `/memory`、UI、HTTP 提供，模型删除记忆走 `memory_update` 的 `delete`。
- **写入策略**：短正文直接写；冲突/疑似重复只加 `advisory` 提示；只有高度重复（≥0.82）与同主题反义才停写；没有待审队列，也没有 `writeMode`。
- **规则文件**：内置规则默认空白（与官方一致）；只有你自己写的 `memory-rules.md` 会被注入。
- **Dream 真正整理**：prompt 从“保留每个事实”改为“保留仍然成立的事实，被新会话取代的状态直接替换”；禁止记录版本号/测试数/提交哈希/行数/进度流水账/一次性事务；`dreamAllowDelete` 默认开启（软删除）。
- **桌面 API**：页面通过同源 `GET /api/cc-memory/bridge` 获取令牌，数据请求由宿主协议转发。
- **机密扫描分级**：明确格式（sk-proj-/sk-ant-/github_pat_/gho_/AIza/JWT/带密码连接串/中文「密码：」/AWS/私钥/slack）→ **deny 拒写**；泛化赋值/Bearer/高熵 → warn；`secretScan:'deny'` 仍为“全部拒绝”严格档，`off` 跳过。

## 运行时行为

- **运行时开关即时生效**：DreamAgent/MemoryStore 通过 live config provider 读取当前配置；`/memory on|off` 不再需要重载插件。
- **写入不回执队列**：`memory_save`/`memory_update` 直接落盘并返回版本号；重复与反义事实只提示，不停写。
- **回滚不丢并发写**：失败回滚只处理 touched 文件且校验应用后哈希；未触碰/被并发修改的文件保留，冲突写入 `conflicts` 并留痕 `.dreams/<ts>-rollback/`。
- **lastPlan 不再误清**：`applyLastPlan` 仅在 `applied:true` 时清计划；锁冲突返回 `{applied:false,error:'dream-locked'}` 并保留指针。
- **会话缓存清理**：`agent/disposed` 调 `runtime.forgetSession`，`bySession` 上限 500，长期运行不泄漏。
- **模型覆写留历史**：`.history/<file>/<ts>-<hash8>.md`，`keepHistory`/`historyMaxPerFile` 控制；模型 update/save 与 dream 写入前都保留旧版本。
- **单一作用域**：记忆只有项目作用域（`scope:'user'` 已删除，传 `'user'` 抛 `INVALID_SCOPE`）；跨项目偏好写进全局 `memory-rules.md`。
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
| `autoMemoryEnabled` | `true` | auto memory 开关：注入 + 自动写入；`/memory on/off` 写这个 |
| `memoryRoot` | `''` | 记忆根目录，空 = `$DSH_HOME/cc-memory`；支持 `~/` |
| `recallMode` | `model` | 自动召回：`model`（唯一 selector）/ `off`；`lexical` 与 `autoRecall` 已删除 |
| `recallProvider` / `recallModel` | `''` | selector 模型对；空 = 默认模型 |
| `recallTimeoutMs` / `recallMaxCandidates` | `4000` / `200` | selector 超时 / manifest 候选上限 |
| `autoRecallMaxFiles` / `autoRecallMaxChars` | `3` / `3000` | 每条消息最多附加的记忆数 / 总字符数 |
| `autoExtract` | `true` | turn/end 后自动抽取；进程内工具循环，直接过 `memory_save` |
| `autoExtractEveryTurns` | `3` | 每 N 个主线 turn 最多抽一次 |
| `autoExtractMaxItems` / `autoExtractMaxChars` | `5` / `12000` | 单次最多写入条数 / 转写预算 |
| `autoExtractTimeoutMs` | `60000` | 单次抽取总超时 |
| `subagentMemory` | `off` | 子代理记忆唯一策略：`off` / `shared` / `own` |
| `agentMemoryPresets` | `[]` | `own` 的 preset 白名单 |
| `indexMaxLines` / `indexMaxBytes` | `200` / `25600` | 每次注入的索引预算（官方 200 行/25KB；token 成本更高） |
| `autoDreamEnabled` | `false` | 自动 dreaming（建议先手动跑几次再开） |
| `minHours` / `minSessions` | `24` / `5` | 自动 dream 闸门 |
| `scanThrottleMs` | `600000` | 扫描节流 |
| `lockTtlMs` | `3600000` | 锁过期回收 |
| `dreamAllowDelete` | `true` | 允许 Dream 在副本里删掉笔记（切换时进 `.trash/`，可恢复） |
| `dreamMaxFileChars` | `100000` | 单次写入的正文上限；模型想写的正文超了就拒绝这条写入 |
| `rulesMaxChars` | `8000` | 注入规则（memory-rules.md）允许的最大字符数，超出拒绝保存 |
| `secretScan` | `warn` | 写记忆/dream 写文件/改 rules 前的机密扫描：`warn`（写入但带 warnings）/ `deny`（拒绝）/ `off` |
| `policyDuplicateThreshold` / `policySuggestThreshold` | `0.82` / `0.55` | 重复阈值 / 相似候选阈值 |
| `projectId` | `''` | **v9** 显式项目身份（优先级最高）；空则读 workspace 标记 > git root > workspace |
| `tools` / `commands` / `ui` | `true` | 各面开关 |
| `evalMode` | `false` | **仅评估用**：为 true 时额外注册 `memory_eval_dream`（正常使用不要开启） |
| `contextOrder` | `850` | 注入 context 的排序 |

## 数据安全与可恢复性

- **软删除**：`/memory delete`、UI、HTTP 与 dream 的 delete 操作都移到 `<projectDir>/.trash/<ts>/`（可手工恢复），不会物理删除。
- **覆写历史**：`saveEntry` 覆盖已有文件、`updateEntry`、`writeRawEntry`（含 dream apply）在写入前把旧内容快照到 `<projectDir>/.history/<file>/<ts>-<hash8>.md`；`keepHistory`（默认 true）、`historyMaxPerFile`（默认 20）控制，失败不阻塞主写入。
- **索引一致性**：每次 dream apply 之后调用 `reconcileIndex()`：索引缺失的文件自动补一行、指向不存在文件的悬空行移除，避免「文件在磁盘但永远不注入」的孤儿。
- **计划可审**：Dream 的分析结果先落到 `.dreams/shadow/`，你可以直接翻那份副本确认，再决定切换。
- **失败不污染记忆**：分析失败、成本超限、切换冲突都不会改动现有记忆；切换中途出错时仍保留 `meta.json` 与备份，可 undo 或从备份恢复。
- **可恢复**：`.dreams/<ts>` 备份与 `.trash/<ts>` 回收站可通过 `/memory backups|trash`、UI「备份与回收站」卡或 `POST /restore` 恢复整批/单文件（写 changelog + reconcile）。
- **provenance**：新写入的记忆 frontmatter 带 `created`/`source_session`/`via`（tool/command/dream），可追溯来源；`/memory list` 与 UI 文件行展示。
- **机密扫描**：写记忆/改规则/dream 写文件前扫描 19 条规则（AWS key、私钥块、sk-*/sk-proj-/sk-ant-、github_pat_/gho_/ghp_、AIza、JWT、密码连接串、中文「密码：」、slack 等明确格式 → **deny 拒写**；Bearer、`api_key=`/`password=` 赋值、高熵 base64 → **warn**）；`secretScan: warn|deny|off`（默认 warn，明确格式的密钥即使在 warn 下也拒绝；deny 全部拒绝；off 跳过），只记录前 12 字符摘要，不入日志。
- `<projectDir>/.metrics.json` 记录注入、读写、搜索、Dream 接受率和最近用量。`/status.metrics`、`GET /metrics`、`/memory metrics` 与 UI「效果」卡均可查询。

## 与 Claude Code 的差异（有意为之）

- **Dream 产物可审计**：整目录副本 + `meta.json` + 备份 + changelog；删除只进可恢复的 `.trash/`（`dreamAllowDelete:false` 可关闭）。
- **笔记不会被动过**：Dream 只写副本，只有你说切换时才动真实记忆；切换会先整目录备份。
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

- **宿主依赖**：HTTP API 在 `webServer` 就绪后挂载。页面通过 `/bridge` 获取 token；不可用时显示刷新入口。
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

集成验证在 Harness 内进行：`plugin_manager` 安装/重载 → `cordis_inspect_list` 确认工具（应为 4 个：save/update/read/search）→ 调用 `memory_save` / `memory_search` → `/memory status`、`/memory dream run` → `/memory dream status <runId>` → `/memory dream switch` → Web 页面刷新。

## 已知限制

**与 Claude Code auto memory 的已知差异**

完整清单见 [ARCHITECTURE §5.6](ARCHITECTURE.md#56-与-claude-code-auto-memory-的对照)。实现层面最值得记住的是：

- 自动抽取默认开启：主线每 N 个 `turn/end` 后，在进程内跑一次最多 5 turn 的工具循环（`memory_read/search/save/update`），只读上次游标之后的转写，写入直接过 `memory_save` 门。官方是每轮 query loop 后的 forked agent；插件不创建 live Agent/session，工具结果和轮数都有硬上限。
- 召回默认由模型选择器执行，每轮附加条数受 `autoRecallMaxFiles` 限制。失败或超时则本轮跳过自动召回。
- 子代理默认不注入（与官方一致）；`subagentMemory:'own'` 时带 `agentPreset` 的子代理有独立的 `agents/<preset>/memory`，只注入/只写自己的目录，但没有官方的 `memory` frontmatter、user/project/local 三种 scope 与快照合并。
- 没有团队记忆（`team/` 服务器同步、secret scanner、团队 scope 规则）与 `autoMemoryDirectory`/每项目开关；只有全局 `memoryRoot`/`projectId`。
- Dream 由宿主子智能体执行（0.25）。每轮复用一个子智能体，按页读取脱敏来源并逐段提交草稿。Dream 页列出本工作区各对话的整理状态。审阅时能看到改动对应的 `session #seq — quote` 证据，最终由人切换、放弃或撤销。
- 系统提示是 19 行紧凑手册，覆盖四类型、保存/不保存、`**Why:**`/`**How to apply:**`、绝对日期与“推荐前先核验”，但不是官方完整 auto-memory 段的等价实现。
- Worktree 已共享主仓库记忆；Windows 盘符大小写已归一。
- 超预算时只注入头部，超出部分不加载；回执要求重写索引，索引行超过约 200 字符会截断 hook，模型可用 `memory_update` 合并与删除。
- Dream 将会话分块送给分析器；每轮未纳入的会话保留待处理。
- **证据校验的边界**：操作级引用检查来源位置，不证明语义推断正确；既有用户类事实可保留搬运。粘贴检测（`[user-pasted]`）是启发式，短粘贴和转述识别不出。
- Dream 只写副本：分析结果落 `.dreams/shadow/`，你不切换就不会影响任何自动回忆。
- “写入混入推断”：已加默认规则（区分用户原话与推断），**效果未验证**；规则是否真的减少推断混入，需要下一轮评测。

**仍未做 / 待观察**

- ⏳ **效果价值评估**：v8 已统计“使用量/接受率/neverRead/成本”，但还不能证明记忆“让回答更好”；需要 A/B 或人工评估层（路线图第一优先级）。
- ⏳ **浏览器 E2E**：v7/v8 新 UI（diff/恢复/效果卡/成本）有 vm+shim 测试，仍需真实页面刷新验收；无 Playwright 覆盖。
- ✅ 项目身份已补 marker/config `projectId` 与 user 独立空间；**团队/多用户共享**仍未设计。
- ✅ v10 已实现与 Claude Code 记忆格式互通（`/memory import|export`，含 `.claude/rules` 导出）。
- ⏳ 机密扫描仍是启发式（格式规则 + 熵），无 HTTP 限流；本机多用户/权限隔离未做（单用户设计）。
- ⚠️ `dream switch` 写回时会检查「运行期间是否有人改过笔记」，改过就整次拒绝（`conflict`），不带自动合并；需要先丢弃副本再重跑。
- ⚠️ dream 锁冲突在 HTTP 侧以 `{ok:false,error:'dream-locked'}`（结果对象）返回，未映射成 409；UI 以错误文案呈现。
- ⚠️ 客户端视觉（挂载/交互细节）需在真实页面刷新后验收；仓库内已有 vm+React shim 测试，但不是浏览器 E2E。
- ⚠️ 有等待切换的副本时会阻塞自动 dream（有意的「等人处理」语义），副本不会自动过期。

**语义/边界**

- 写入后可用 `/memory refresh` 刷新当前会话；新会话会读取最新索引。
- `runtime.context` 是**尾部 user 消息**（`agent-loop`: `messages:[...claimed, context]`），文本不变不重复追加；`session` 冻结把变化限制在会话边界/compaction。
- 浏览器版（Chrome）访问必须使用 `dsh web` 打印的带 token URL，桌面版不受影响；历史里已经产生的旧 `memory · …` 轨迹行不会被删除（只保证不再新增）。
- 运行时开关（`/memory plugin on|off`、UI pills）写在根目录 `.plugin-state.json`，是**全局**的（影响所有项目）；UI 与命令输出都标注「全局」。
- 覆盖率（v7 前）：行 79% / 分支 62%；`client.js` 已有入库测试，scheduler/commands/tools 分支覆盖仍偏低。


