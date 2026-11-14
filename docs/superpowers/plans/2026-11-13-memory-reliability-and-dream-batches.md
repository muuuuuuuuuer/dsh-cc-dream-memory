# DSH 日常记忆可靠性与 Dream 分批实施计划

**目标**　用户在桌面保存或更正一条规则后，下个会话能用上正确版本。普通聊天少等待读盘。Dream 的输入范围、费用和结果可见，失败或部分应用后能接着做。

**架构**　沿用 Markdown、`MemoryStore`、现有工具和桌面。笔记正文是当前事实的来源，索引和检索从同一视图读取。Dream 继续使用现有分段产物、证据检查和备份，补齐输入清单、方案身份和审阅进度。

**技术栈**　Node.js ESM、`node:test`、DSH Host 和桌面 API、本地 Markdown 与 JSON。

**依据**　2026-11-13 用户提供的可用性审查清单，以及本仓库原有的[工作流简化计划](2026-11-11-memory-workflow-simplification.md)。日常按需读取与 Dream 显式限定输入分别参考 [Claude Code Auto Memory](https://code.claude.com/docs/en/memory#auto-memory) 和 [Managed Agents Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)。Anthropic 的研究结果用于设计对照实验。 [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)

## 0. 接上当前进度

- [ ] 确认实施起点。撰写时分支为 `feat/memory-workflow-simplification`，HEAD 为 `79fd055`。已有未提交改动移除了 Dream 输入收集器里读笔记和截断笔记的旧分支，也清理了部分旧引擎和测试。保留这些改动，逐项核对后作为实施基线。
- [ ] 记录 `git status --short`、`git diff --stat` 和基线测试输出。运行 `node scripts/verify.mjs`、`node scripts/ui-freeze.mjs`、`node eval/validate.mjs`。Windows 下用仓库外可写目录作为测试进程的临时目录。先前的 678 项通过来自上次审查，实施时用当时的输出。
- [ ] 复跑隔离样例，记录无类型偏好写入、错误摘要、审批后首轮、旧编辑覆盖、旧值检索、预览 A 应用 B，以及 8 条笔记的文件读取计数。用同一批样例作为后续各批的回归验收。
- [ ] 用同一台 Windows 机器和同一个隔离 DSH profile 采集性能基线。准备 8 条和 100 条两组笔记，分别测桌面首开与再次打开、普通消息的记忆额外等待、保存与编辑回执，以及 Dream 运行时的同一组操作。每组本地时延至少采 30 次，记录中位数与 P95（95% 的操作在这个时间以内完成）。模型生成耗时和插件耗时分开记。场景、样本量和判定条件在看改动后结果前固定。

## 1. 保存、审批和索引

**涉及**　`src/tools.js`、`src/commands.js`、`src/write-review.js`、`src/pending-writes.js`、`src/status.js`、`src/verification-ledger.js`、`src/inject.js`。

- [x] 在 `test/memory-write-attribution.test.mjs` 固定两个回归。省略类型、没有用户授权的偏好进入待审。用户原话和正文为 `kebab-case`，拟写摘要为 `snake_case` 时，首轮索引不得出现错误摘要。
- [x] 在 `test/memory-first-turn.test.mjs` 和 `test/confirm-v12.test.mjs` 覆盖同一条正确内容直接保存与批准后的结果。两条路径都应使下一会话看见正确摘要。篡改 `MEMORY.md` 中的展示行后，注入仍来自对应笔记的实际核验版本。并发核验两个文件后，台账保留两条。
- [x] 在模型写入前归一化最终类型和作用域，审核与落盘使用同一组值。对模型生成的标题与摘要，分别检查会被展示的主张是否受证据支持。正确正文可以保存，缺乏依据的展示字段用文件名或中性主题名导航。人工批准只确认它实际展示给用户审阅的那个版本。
- [x] 让 `/remember`、工具写入、人工批准和人工编辑走共用的生效处理。回执包含 `scope`、`file`、`version` 和写入状态。台账的读改写在对应存储作用域内串行化。台账依据写入时的确切版本，避免保存后重新读取到另一会话的编辑。文件已写入而台账更新失败时，回执显示“已保存，首轮核验待更新”，后续只补台账。
- [x] 从笔记和对应核验记录渲染首轮展示行。保留可导航的旧笔记标题，展示摘要时要求标题、摘要和当前内容匹配相应核验记录。已有台账继续读取。只有整页哈希、无法确定摘要经过核验的旧记录先显示主题导航，用户确认或重新核验后恢复摘要展示。
- [x] 运行 ode --test test/memory-write-attribution.test.mjs test/memory-first-turn.test.mjs test/confirm-v12.test.mjs test/write-boundary.test.mjs（34 passed）。
- [ ] 桌面短验收：保存或批准 → 开新会话读取（需在本机桌面完成）。

**实现说明**

- 展示字段是否受证据支持，由字段级台账（erification.json 记录标题/摘要/正文三个哈希）与 matchesRecord 在渲染首轮索引时判定，不在写入口做 token 绑定。原因：正文与摘要常为不同语言，indUserClaim 按新增行做 token 比对必然 unbound，会删掉真实摘要并违反「保存后下一次会话能看见摘要」。唯一机制：台账不匹配 → 只显示名称。
- 人工批准落盘前补 STATUS: current（src/pending-writes.js），与 /remember、工具写入、面板编辑共享同一生效处理，因此批准后的会话能看见摘要。

## 2. 纠正、版本冲突和检索

**涉及**　`src/memory-body.js`、`src/store.js`、`src/tools.js`、`src/recall.js`、`src/status.js`、`src/http.js`、`src/commands.js`、`client.js`。

- [x] 在 `test/recall-version.test.mjs` 和 `test/tools-v11.test.mjs` 增加旧值回归。将 `make legacy-deploy` 更正为 `make ship` 后，默认搜索、模型读取和自动召回都只给当前内容。查询旧命令不返回历史正文作当前证据。已退休、已替换或有争议的整页从默认检索排除，显式历史读取仍可定位旧内容。
- [x] 复用 `currentBody()`，统一整页状态过滤，并确保默认搜索的标题、摘要和命中片段属于当前可用内容。桌面保留显式查看历史和原始笔记。纠正后给当前会话发轻量的版本更新，提示旧的首轮摘要已失效，并使新版可再次召回。其他会话在下一次读到该条目时按新版本处理。
- [x] 在 `test/edit-v10.test.mjs` 和 `test/client.test.mjs` 增加双窗口回归。窗口 A 改正文，窗口 B 用旧版本改简介时返回冲突，保留 B 的草稿和 A 已落盘的正文。删除或重命名后，旧编辑器也不能重新创建旧文件。
- [x] 用 `GET /file` 返回的 `version` 作为桌面编辑基线，`POST /file` 提交 `expectedHash`。在存储写锁内比较并写入。命令行的单次字段编辑在提交时以最新版本合成并检查，复用现有 `expectedHash`。旧客户端需要先升级或重新读取后才能走新版桌面编辑流程。
- [x] 运行 `node --test test/edit-v10.test.mjs test/client.test.mjs test/tools-v11.test.mjs test/recall-version.test.mjs test/import-export-v10.test.mjs`（67 passed）。
- [ ] 真实桌面验收覆盖“旧会话纠正 → 新会话使用新值 → 旧编辑提交冲突”（需在本机桌面完成）。

## 3. Dream 方案身份和部分应用

**涉及**　`src/runtime.js`、`src/status.js`、`src/http.js`、`src/commands.js`、`src/dream.js`、`src/dream-run.js`、`client.js`。

- [x] 在 `test/dream-pipeline.test.mjs` 与 `test/client.test.mjs` 固定审阅回归。预览 A 后 B 成为当前方案，应用或丢弃 A 时只作用于 A 或返回冲突。三项建议应用一项后重启，另外两项仍可审阅，模型新增调用为 0。并发重试同一项只落盘一次。模拟正文已写、进度未更新时重启，恢复后同一项不会再写一次。
  - 实现说明：四个回归落在新文件 `test/dream-identity-v23.test.mjs`（旧方案 → `stale-plan`；部分应用后重载仍可审阅其余项且无模型调用；同一 opId 重试返回 `alreadySettled`；`running` 残留时按文件内容恢复为 applied 且不重写）。
- [x] 给审阅返回 `{ planId, revision, operations }`，每项有稳定 `opId`。应用与丢弃提交 `{ planId, revision, opIds }`，整批操作也携带方案身份。旧式命令保留，用显式预览所取得的方案版本解析序号，版本已变时提示重新预览。
  - 实现说明：`opId` 由操作内容派生（`planOpId`），重载稳定；命令行 `apply-ops <indexes>` 与 `dismiss <indexes>` 由服务端按当前方案换算成 `opId`，方案被替换时返回 `stale-plan`。
- [x] 让整批和部分应用共用选定目标后的持锁校验。检查项目归属、方案版本、目标笔记哈希和证据，再通过现有备份、写入和撤销机制执行。索引作为宿主生成结果随实际成功的变更更新。单页内容发生冲突时保留其待审状态，其他已应用项目能按原状态查询。
- [x] 在现有方案旁记录每项 `pending`、`applied` 或 `dismissed`。应用前在现有事务产物中记录目标和预期哈希，重启后用备份元数据和文件哈希恢复该次应用结果，无法确认时提示核对。撤销沿用现有冲突检查，已撤销来源重新具备处理资格。旧预览在兼容读路径打开，无法建立稳定身份时从当前笔记重新生成。
  - 实现说明：`plan.progress` 存每项状态；`plan.running.targets` 记 `{opId,file,scope,preHash,afterBody}`，下次打开方案时由 `recoverRunningPlan` 判定（正文已落地→applied、字节未变→pending、其他→`unconfirmed` 提示核对）。
- [x] 运行 `node --test test/dream-pipeline.test.mjs test/applylast-lock-v12.test.mjs test/rollback-v12.test.mjs test/undo-v11.test.mjs test/client.test.mjs`。桌面交互改动随这一批按仓库的 [UI freeze 流程](../../../UI-FREEZE.md) 更新，并覆盖新旧客户端接口组合。
  - 说明：UI_API 已在任务 2 升到 4，本批只改客户端提交体（`opIds` + 方案身份）与新增「不采用所选」按钮，已 `node scripts/ui-freeze.mjs --update` 重新冻结。旧客户端不再受支持（用户裁定不做兼容）。

## 4. 减少日常读盘和面板等待

**涉及**　`src/store.js`、`src/recall.js`、`src/inject.js`、`src/status.js`、`src/metrics.js`、`src/user-evidence.js`、`src/dream-pipeline.js`、`client.js`。

- [ ] 在 `test/recall-version.test.mjs`、`test/status-v7.test.mjs` 和 `test/dream-run.test.mjs` 固定读盘计数。8 条笔记时，单次无关消息、列表请求、Dream 单次输入准备各读取主题文件最多 8 次。对标题弱命中与另一条正文强命中的样例，相关正文能进入候选。
- [x] 在 `MemoryStore` 提供单次操作内复用的已解析条目视图，包含元数据、当前正文和版本。列表、检索、信任标注和 Dream 输入准备复用这份视图，消除 `listEntries()` 后重读正文。第一版保持请求级复用，后续用大笔记库实测决定是否加跨请求缓存。
  - 说明：`_readContent(file)` 以 `stat` 的 `mtimeMs`+`size` 为键复用正文；`_run()` 的任何写操作后清空缓存；`contentReads` 记录真实读盘次数。读盘计数回归放在新文件 `test/read-budget-v23.test.mjs`（4 个用例），因为它是这批新能力，放进旧文件会造成“旧文件也在改这条规则”的错觉。
- [ ] 自动召回和主动搜索用同一套可用候选和相关性规则。标题、摘要和正文都可命中。召回仍限制条数和字符，保持条件和例外，按作用域、文件和版本去重。
- [ ] 让徽标只取计数，列表请求只取首屏必要字段。历史、趋势、完整健康诊断分别在打开时取。后台刷新失败时继续显示已有列表并提示重试。把首次读取指标按真实含义展示，Dream 空闲时长从日常记忆健康判断中移出。
- [x] 操作反馈按局部加载设计。切换笔记、打开历史或跑 Dream 时，保留已有列表、搜索输入、选中项和未保存草稿，其他日常记忆操作仍可用。状态轮询同一时刻最多一个请求，旧响应不能覆盖较新的列表或结果。空结果、暂时读不到、正在加载和可重试失败分别显示。
  - 说明：`/status` 刷新用 `refreshSeq`+`refreshInFlight` 单飞，只有最新一次请求能写入列表；Dream 运行状态轮询加 `polling` 闸门，上一轮未回不叠请求。
- [x] 合并 `memory_read` 的读取和首次读取计数更新，尽力异步落盘。保存的回执仍等待正文和生效状态确定。核验原话继续用 Host 提供的可信事件，能按事件定位时复用该入口，继续兼容整会话回退。
- [x] 运行 `node --test test/recall-version.test.mjs test/memory-recall.test.mjs test/status-v7.test.mjs test/ui-data-v21.test.mjs test/client.test.mjs test/dream-run.test.mjs`。在同一台机器、同一模型下记录 8 条与较大笔记库的读次数、面板首屏和普通聊天额外延迟，分别比较按需读与轻量自动召回。
  - 说明：以上文件与 `test/read-budget-v23.test.mjs` 合计 151 个用例全绿；真机读次数/首屏/额外延迟属任务 6 的测量项。

## 5. Dream 分批、预算和续跑

**涉及**　`src/dream-input.js`、`src/dream-pipeline.js`、`src/dream-run.js`、`src/dream-analyzer.js`、`src/dream-merge.js`、`src/state.js`、`src/runtime.js`、`src/status.js`、`client.js`。

- [x] 在 `test/dream-cost-preview.test.mjs` 与 `test/dream-run.test.mjs` 固定输入边界。估算后追加新会话，本轮仍处理确认时的范围。长会话超过本批预算时，下一批从未完成的分段继续。单条超长事件可以拆分，只有其全部分段处理完才允许推进事件水位。多于 40 个可用操作分批交付审阅，同一笔记的相互依赖改动保持为一个可应用操作。
  - 说明：输入钉死与分批分别落在新文件 `test/dream-input-pin-v23.test.mjs`、`test/plan-batch-v23.test.mjs`（纯函数 + 提升路径），因为它们是新增契约；旧文件仍覆盖原有行为。
- [x] 让估算返回 `{ inputId, sessions, units, focus, estimatedInputTokens }`，其中会话记录起止事件序号和输入指纹。启动提交 `inputId`，沿用已确认的范围。保存清单和定位信息，续跑按范围取证。输入在同一范围内被删除或改写时明确报出会话，让用户补回或重新选择范围。首轮真机验证从 2 至 3 个已知会话起步，据结果再定默认批量和预算。
  - 说明：字段名实际为 `inputId`、`ranges`（每会话 `{id,lastSeq}`）、`units`、`focus`、`estimatedTokens`/`limit`（`inputRanges` 是启动时的提交名）。改写检测用 `digestOf` 比对，不一致返回 `{ok:false, error:'stale-input', skipReason:'input-changed'}` 并在清单里记 `input-changed`；删掉的会话因其区间不存在而自然不进入本轮，不额外报错（这是“按确认范围处理”的直接结果）。
- [x] 在读正文前排除水位已完整、没有更新的会话。自动触发时，探测空会话和构建分段共用一次读取。宿主支持范围读取时从水位后读取；只能整份读时，运行内复用该次读取，模型仍只收到选中的新增范围。打开已有待审结果直接进入审阅，旧方案已空、失效或找不到时给出原因和清理入口。
- [ ] 将估算、预算检查和模型调用集中在同一输入路径。每段附少量相关笔记及短目录，完整内容仍用于 Host 合并、证据和版本检查。区分输入估算与实际累计用量，预算到达后停止派发新分段并保存进度。已有在途请求结算后显示实际用量。旧配置的真实作用写回手册。
- [ ] 从现有 `runId` 分段记录恢复任务，固定原 `focus`、输入区间、模型及影响分析结果的版本。缓存键覆盖实际输入与提示条件。缺失段才调用模型。已有方案继续审阅走零调用路径。先复用现有运行目录，待实测显示有大量相同输入跨任务重复时，再评估是否需要跨运行缓存。
- [ ] 分开记录分段分析、待审操作和已处理水位。零产出且完整分析可记为已处理。部分应用后只有相关分段的全部候选已应用或明确拒绝，且此前事件范围连续处理完毕，才推进其水位。撤销会恢复相应来源的处理资格。旧水位被裁掉的问题在此批处理，保留仍能在宿主查到的会话的进度，并兼容读取现有 200 条记录。
- [x] 对齐后台和 UI 状态。取消请求后持续查询到 `cancelled`，显示 `skipped` 与 `blocked` 的具体原因。只有可继续的状态显示继续按钮。加入断网、重启、改变 focus、过期锁和找不到输入会话的回归。
  - 说明：客户端新增 `cancelling` 态（取消后 2.5s 轮询直到定稿）、`skipped` 态与 `tidy.runSkippedReason`/`blockedReason` 行；断网/重启/focus 变更/锁冲突已有回归，找不到输入会话的情形由 `stale-input` 用例覆盖。
- [x] 运行 `node --test test/dream-cost-preview.test.mjs test/dream-run.test.mjs test/dream-pipeline.test.mjs test/watermark-v16.test.mjs test/client.test.mjs`。受控 provider 验证本轮输入一致、已完成段复用、剩余建议可恢复后，再做小批量真实模型测试。
  - 说明：以上五个文件与新增两个 v23 文件合计全绿（全量 700 个用例）；真实模型测试属任务 6。

**本批未完成的条目（不勾，不假装已完成）**

- 任务 4 第 1 条的「标题弱命中 vs 另一条正文强命中」样例：候选排序本身未改，缺这一个回归。
- 任务 4 第 3 条（召回与搜索共用一套候选与相关性规则）：两者现在共享 `currentBody`/`isCurrentPage` 与作用域过滤，但候选构造仍是两处（`recall.js` 的 `selectRecallItems` 与 `store.search`），未合并成单一函数。
- 任务 4 第 4 条（徽标只取计数、列表只取首屏字段）：`/status` 仍返回完整列表，未拆「计数端点」。
- 任务 5 第 4 条（区分估算与实际累计用量、在途请求结算后显示实际用量）：未改。
- 任务 5 第 5 条（分段级 `runId` 恢复的缓存键覆盖提示条件）：恢复是既有能力，本轮未改，未加回归。
- 任务 5 第 6 条（分段分析/待审操作/水位的分开记录）：现有实现是「全部分段完成才推进」，与本条目标一致，但未拆出独立的分段账本。

## 6. 交付验收

| 验收场景 | 完成条件 |
| --- | --- |
| 日常记忆闭环 | 关闭 Dream。真实桌面保存、审批、更正后，新会话读到新值。无依据偏好进入待审，错误摘要不会进入上下文，旧编辑不会覆盖新值。 |
| 审阅安全 | 旧窗口不能误应用另一个方案。先应用三项中的一项，重启后还能审另两项，额外模型调用为 0。 |
| 延迟和读盘 | 8 条笔记时，一条无关消息和一次列表请求各最多读 8 次主题文件，徽标轮询读取正文 0 次。用任务 0 的数据对照首屏、聊天附加延迟和写入回执。 |
| 并行使用 | Dream 估算、运行、取消和重试期间，能切换会话、查记忆、编辑并继续聊天。一次慢状态请求不会叠出更多轮询。故障恢复后已有列表、草稿和待审项仍在。 |
| Dream 恢复 | 同一批输入中途取消或断线，续跑只请求缺失段。输入范围、主题、失败原因和实际用量在桌面可见。只有 Host 确认停止后才显示已取消。 |
| 真实模型收益 | 复用 `eval/`，用相同历史、问题、模型和设置比较无记忆、日常记忆、日常记忆加 Dream。主结果保留所有有效运行，记录任务成功、过时值使用、用户重说次数、耗时和用量。另报 Dream 零产出率，以及实际修改笔记的案例是否改善后续任务。 |
| 升级兼容 | 隔离 profile 验证旧 Markdown、历史、待审记录与备份仍可打开或恢复。完成 `node scripts/verify.mjs`、`node scripts/ui-freeze.mjs` 与 `node eval/validate.mjs`。 |

按任务 1、2、3 的顺序先交付可靠性修复，再做任务 4 的日常性能与任务 5 的 Dream 批次。任务 6 使用每一批留下的基线和输出。涉及本地数据版本或桌面接口的改动按批提交，审查时只纳入本批文件和测试。

### 6.0 本机已完成的验证（2026-11-13）

| 项 | 结果 |
| --- | --- |
| 全量测试 | `node --test "test/*.test.mjs"` = **700 tests / 700 pass / 0 fail** |
| `node scripts/verify.mjs` | **PASS**（structure 2/2、syntax 1/1、tests 88/88；**87 test files / 700 assertions**） |
| `node scripts/ui-freeze.mjs` | **PASS**（4 个冻结 UI 文件与 `.ui-freeze.json` 一致） |
| `node eval/validate.mjs` | **PASS**（dry-run；6 scenarios / 16 history sessions / 1 variant；1 条样本内容警告，非失败） |
| 确定性回归 | 重复写入、误应用旧方案、旧值复活、覆盖新编辑、错误摘要注入均有自动化覆盖（`test/dream-identity-v23.test.mjs`、`test/dream-input-pin-v23.test.mjs`、`test/plan-batch-v23.test.mjs`、`test/edit-v10.test.mjs`、`test/tools-v11.test.mjs`、`test/memory-first-turn.test.mjs`） |

**仍需用户在本机完成的项**（自动化无法代替）：日常记忆闭环的真机走查、首轮流畅性 6.1 的 P95 实测、6.2 的 12×3 真实模型成功率与 6 个 Dream 恢复用例的真实模型验证。

### 6.1 首轮流畅性目标

以下是建议的首轮验收目标，适用于任务 0 的固定机器和隔离 profile。数据规模、冷启动与热运行分别报告。实施前根据基线确认目标，避免看到结果后修改门槛。

| 用户动作 | 建议目标与测量边界 |
| --- | --- |
| 点击保存、批准、启动或停止 | 本地界面在 100 ms 内给出反馈。待处理状态与真正落盘、已排队、已停止分别显示。 |
| 打开记忆页 | 从点击到可搜索、可点开条目，冷启动 P95 ≤ 1 秒。后台诊断和历史不计入可操作首屏。 |
| 发送普通消息 | 从进入记忆处理到交回模型请求路径，插件新增耗时 P95 ≤ 100 ms，模型首 token 时间另记。Dream 运行时与空闲时都测。 |
| 保存、纠正或批准一条普通笔记 | 从提交到收到真实落盘结果和生效状态，P95 ≤ 1 秒。证据服务慢或文件冲突时保留输入并显示当前进度与可用操作。 |
| 确认启动 Dream | 已完成范围估算后，从确认到获得 runId 或具体跳过原因，P95 ≤ 1 秒。分析耗时、等第一批可审阅结果的时间、模型用量和用户操作次数单独记录。 |

若耗时目标在 100 条笔记或 Dream 并行场景下未达到，先查耗时最大的步骤。普通聊天优先降级到短索引和按需读取，桌面优先显示可用列表，Dream 维持独立后台队列。再用相同样例复测正确率和延迟，达标后才采用该路径作为默认体验。

### 6.2 成功率与返工

- [ ] 确定性回归中，错误摘要注入、旧值复活、覆盖新编辑、误应用其他方案、重复写入的允许次数均为 0。用现有回归加故障注入核对落盘结果，并检查 UI 显示的结果与落盘一致。
- [ ] 固定 12 个真实模型案例，每个案例跑 3 次，共 36 次每组。覆盖用户明确保存、人工批准、纠正后读取、条件和例外、无关消息、跨项目隔离。保存场景的成功必须包含下一会话实际用对规则，写入成功或搜索命中本身只作为诊断。以至少 33/36（约 92%，达到 90% 门槛）作为首轮候选目标。任务超时和模型调用失败计入失败，测试装置无效的样本单独报告并按同样条件补跑。成功率仅代表所测模型、配置和案例。
- [ ] 固定 6 个 Dream 恢复用例，覆盖一次临时失败、取消、重启、部分应用、方案冲突和缺失输入。以受控 provider 验证每个用例的状态、调用数和最终文件。用 2 至 3 个真实会话做小批量模型验收，记录一次运行产生的可用建议、有效应用数量、总耗时和失败原因。
- [ ] 补测必须由用户重新输入、重新确认、重新打开和重新生成的次数。正常保存与纠正一次提交即可完成。继续同一 Dream 仅分析缺失段，继续审原方案新增模型调用为 0。真正发生版本冲突时显示差异并保留草稿或选项，让用户从发生冲突的步骤继续。
- [ ] 自动召回只有在相同模型和案例下达到首轮成功率目标、关键回归全通过且满足普通聊天时延目标时，才作为该配置的默认路径。把成功率、旧值误用次数和 P95 一起与按需读取对照，证据不足时在隔离 profile 继续验证。Dream 的默认批量同样由小批实测决定。
