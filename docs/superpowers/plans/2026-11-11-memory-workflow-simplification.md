# DSH 记忆插件收敛实施计划

**目标**  
会话中能直接记住一条信息，新会话能读到它。Dream 在独立任务中增量整理历史，支持继续、取消、审阅与应用。Wiki 在独立入口构建文档知识库，并用出处回答。

**执行顺序**  
单线程逐项实施。先让在线记忆可独立交付，再上线 Dream，最后收口 Wiki 和桌面集成。每一项使用现有测试入口验证，交付时统一审查。

## 依据与本地基线

| 官方资料 | 本项目采用的行为 |
| --- | --- |
| Claude Code 在会话内读写项目 Markdown。启动读 MEMORY.md 的前 200 行或 25 KB，主题按需读 | 将完整记忆保存在现有项目目录。首轮使用简短索引，保存、搜索、读取和纠正各有即时结果 |
| Managed Agents Dreams 是异步任务，接受已有记忆与 1–100 个历史会话，生成独立结果供审核，有取消和失败状态。成本大致随会话数线性增长，官方建议先用小批量；输入会话被删除时任务报 input_session_unavailable | 在本地生成独立候选方案，当前记忆库继续可用。启动前展示估算，审阅时看合并后的完整页面，成功后由用户应用 |
| 动态工作流 Cookbook 按会话分析，整理后供后续会话使用。某份记录里找不到依据的说法保持不动；启动前打印成本估算 | 复用 transcript 和证据核验；按分段写出分析产物，由宿主合并具体变更。某段没提到的笔记不算矛盾 |
| Knowledge Wiki Quickstart 把语料提取成带出处的页面，由新会话只读查询并明确资料缺失。资料之间的冲突保留为冲突，被取代的旧数字标为被取代 | 保持独立 Wiki 构建、发布和问答入口；沿用本地世代发布和事实引用；冲突两条都保留并各注来源 |

资料：[Claude Code Auto Memory](https://code.claude.com/docs/en/memory#auto-memory) · [Managed Agents Memory Stores](https://platform.claude.com/docs/en/managed-agents/memory) · [Managed Agents Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) · [动态工作流 Cookbook](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow) · [Knowledge Wiki Quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/knowledge-wiki)

- 实际桌面插件链接到 [default-workspace 的插件源码](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory>)。源码包版本是 0.12.0，分支 codex/github-main，HEAD 为 f0a8a9f。2026-11-11 的 git status 为 43 个已改文件、32 个未跟踪文件，合计 +4632/−511 行，全部未提交。其中有 HEAD 之后的 Dream v2、Wiki、写入归属、现场修补和整页 UI 重做。当前可写 worktree 同样解析到 f0a8a9f，但缺少这些改动。
- [bundle 配置](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/cordis.patch.yml:8>) 默认 Dream v2、自动 Dream 关闭、Wiki 开启、首轮只注入已核验 Hot set（`injectHotEntries: 3`）。实际默认工作区有 11 条笔记，旧笔记的核验覆盖不足。上一轮保留的旧预览是 3/8，较新运行在整理阶段 16K/32K 两次截断。现场修补后曾有 726 项测试通过；UI 重做与 organizer 链接修复后，node scripts/verify.mjs 与 node scripts/ui-freeze.mjs 通过（83 个测试文件）。真实桌面闭环尚无通过记录。
- 当前长输入被分块，但 [DreamPipeline](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-pipeline.js:383>) 仍会在调用预算或长度边界停止入队；最终整理需要一次返回多个完整页面。Wiki 有独立代目录，但模型输出及 prompt 拼装仍有裁剪路径。现有应用校验、备份和撤销已有可用实现。
- 源码里已经完成、本计划直接沿用的部分：
  - status 返回 `uiApi` 和 `version`；后端仍是旧代码时，记忆页显示提示横幅。
  - [status.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/status.js:1103>) 会隐藏覆盖不完整的 v2 预览，但每一项都被证据检查拒绝的方案仍算待处理。
  - 预览用 `previewVerdicts` 标出 apply-ops 会拒绝的项，与应用时的检查一致，也包括依赖被拒项的删除。
  - organizer 写在正文里的「相关：[[…]]」行会被移出正文，由宿主为每页写一行 `Related: [[a]] [[b]]`（`renderRelatedLinks`）。证据检查和核验标记都把这一行当作结构。
  - Dream 页先调 `estimate`，再一直等 `dry-run` 返回方案（[client.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/client.js:4085>)）。
  - metrics 按笔记记录读取次数和最后读取时间（`recordRead`）。

## 研究文章如何落到本项目

- **记忆的价值取决于未来任务。** 文章的 CL-Bench 案例保存了经验证的规则、依据和容易踩的坑；Pokémon 案例显示，大量即时状态会迅速过时。DSH 的自动提议重点是已验证的经验、项目外的信息来源和明确纠正。常规提示说明记忆的用途，用户明确要求保存仍走直接路径。
- **Dream 要用原始证据修错。** 文章里纠正一条导航笔记就改变了后续行动。DSH 用现有 sessionQuery 追到会话原文、工具结果或可核查的验证步骤。原文是底层证据，笔记与 Wiki 是整理后的表示，首轮索引提供入口。会话 compaction 继续服务当前上下文，其摘要不作为用户原话。
- **整理目标决定整理什么。** 复用现有 focus 指明本轮目的，例如「找出本项目已经验证过的测试命令和失败条件」。跨会话时优先找会影响后续工作的纠正、重复出现的经验和已过时的笔记。旧证据不可用时保留不确定状态或请求核实。
- **Wiki 的效果依任务而异。** 文章的 Stainless 样例里，Wiki 加搜索为 61%，单用搜索为 53%，单用 Wiki 的最佳结果为 48%。文章也报告了收益有限的任务。
- **读取和验证与写入同样重要。** 文章里单项提升最大的一次，来自让模型读取并验证记忆的提示：Sonnet 4.6 从 0.364 升到 0.641。这类提示对较弱模型帮助最大，固定的保存规则反而会压低强模型的收益。
- **Dream 也决定首轮加载什么。** 文章把常用笔记提到首轮索引、细节下放并留下链接，算作整理的一部分。首轮内容会进入每个新会话，其中一行错误也会扩散到所有会话，所以对索引的改动同样需要证据。持续核查全部记忆不现实，核查集中在容易变化、经常被用到的笔记上。
[Anthropic《The components of agent memory》](https://www.anthropic.com/research/components-of-agent-memory)

## 产品约束

1. 用户无需设置输入、输出、会话数量、事实条数或字符阈值才能完成任务。原始正文和来源可完整读取。分段与分页大小只用于拆解单次工作，剩余工作持续有明确位置。保留 200 行 / 25 KB 作为首轮索引的展示预算，完整列表和主题继续可按需读取。取消截断后，用启动前估算代替上限：复用现有 `estimate` 动作，显示估算的输入量和工作单元数，用户确认后开始；默认只处理上次成功之后的新会话，运行中随时可取消。估算只做展示，不截断任务。
2. 单次模型调用使用 DSH 供应商实际支持的上下文和生成参数。若宿主要求 maxTokens，将其视为传输参数；遇到上下文不足或 max-tokens，缩小当前工作单元并持久化剩余项。模型输出被截断时，当前单元未完成。重复遇到不可拆的失败，显示失败单元和原因，等待修复后继续。连接失败按现有供应商可重试信号处理，鉴权错误或模型不可用直接报实因。
3. 在线记忆复用现有 Markdown、项目身份、来源、历史、审核和备份。明示保存当场落盘。转发和推断的用户偏好仍走证据门和审核。长期项目约定沿用 AGENTS.md / 项目规则路径。
4. Dream 生成独立候选，整个读取和整理过程只写任务产物。保留最终证据门、备份和撤销。未完整的候选可查看进度与诊断，整个任务覆盖完成后才能进入可应用状态。Wiki 仅在完整新代校验成功后切换指针。
5. 继续使用 Node ESM 与 DSH 现有 Host 服务。本计划以插件内完成为范围。主流程先在 Host/API/命令中实现。界面与接口同阶段交付：某阶段改了命令或 HTTP 的返回，就在同阶段完成 client.js 与 locale 的对应改动，单独提交以 `UI-FREEZE:` 开头的 commit，并把 status.js 与 client.js 里的 `UI_API` 同时加一。

## 0. 固定真实交付基线

- [x] 先在 default-workspace 源码里把当前未提交的改动提交为两个 commit：后端、文档与测试一个；client.js、locale 和 .ui-freeze.json 一个，以 `UI-FREEZE:` 开头。提交前确认哪些未跟踪目录应入库。从这里切出实施分支，并把本计划移入该仓库的 docs/superpowers/plans/。不要以旧 worktree 的干净 HEAD 覆盖当前源码。
- [x] 从桌面 profile 的安装指向反查实际源码、包版本和启动加载路径。记录分支、打包文件清单及关键模块哈希，确认安装指向的就是上一步的提交。
- [x] 将现有项目记忆和旧运行清单复制到隔离 profile，形成可重复的现场样例。使用测试数据运行，真实笔记留在原项目。保存四个基准现象：11 条旧笔记、首轮索引空、失败预览被当待处理、整理输出截断。
- [x] 冷启动实际包并验证命令、工具、Host HTTP。跑 node scripts/verify.mjs、node scripts/ui-freeze.mjs、node eval/validate.mjs，记下实际基线结果。基线异常先记录并判断归属，后续验收使用同一份产物。
- [x] 写入的请求严格定位项目。先修 [HTTP resolveProject](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/http.js:165>)：显式 sessionId 失效时拒绝，写入必须有可验证的目标项目。为只有一个已加载项目的反例加回归。命令、工具与 HTTP 使用统一的项目身份。

**交付条件**  
现有改动已提交入库，桌面包与测试 checkout 可相互核对；旧会话 ID 不会把构建或写入路由到另一项目。

## 1. 先做顺日常记忆

涉及 [commands.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/commands.js:1646>)、[tools.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/tools.js:384>)、[user-evidence.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/user-evidence.js:91>)、[store.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/store.js:928>)、[inject.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/inject.js:350>)、[recall.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/recall.js:441>)、[verification-ledger.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/verification-ledger.js:57>)。

- [x] 把已有 /remember、memory_save、memory_update 的成功回执统一为条目身份、作用域和结果。保留现有命令和工具名称。明确保存的核对已经存在，本任务不重做：宿主用 `verifyUserEvidence` 在会话记录里找到用户原话，再用 `bindUserClaim` 检查写入内容出自这句原话（[tools.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/tools.js:418>)）。/remember 作为明确的人类操作，继续使用已有直接路径。用例覆盖明确采纳一条报告、无关原话、必要条件丢失、重复保存和旧值纠正。
- [x] 明确保存和纠正当场写入核验记录。首轮要求笔记正文有 `STATUS: current`，且指纹与核验记录一致（[inject.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/inject.js:45>)）。目前 `STATUS: current` 只在纠正时写入（[write-review.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/write-review.js:150>)），核验记录只由 Dream 写入（[dream.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream.js:1263>)）。所以 /remember 和 memory_save 新存的笔记进不了首轮；memory_update 纠正后指纹变化，笔记会从首轮掉出，直到下次 Dream。/remember，以及宿主核对过用户原话的 memory_save 和 memory_update，当场用 `recordVerification` 写入记录，来源标为 `user-explicit`；转发和推断的写入不写。索引导航下，这份记录决定是否展示简介；若保留 Hot-only 选项，新存笔记还要补 `STATUS: current`。用例覆盖：保存后新会话首轮可见，纠正后首轮显示新值，转发材料保存后不会被当作已核验。
- [x] 启动注入改为短规则和可导航的项目索引。完整索引已经存在，本任务不另做：关闭 `injectHotOnly` 时，宿主加载自己生成的 MEMORY.md 开头部分，每条一行「名称 — 简介」，上限 200 行 / 25 KB（[store.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/store.js:282>)）。把 bundle 默认改为索引导航，再加一条过滤：已核验现行条目展示简介，缺核验的旧笔记只显示名称，正文按需读取；失效和 Superseded 历史留在显式读取路径。验证 11 条旧笔记无台账时仍有查找入口。同阶段更新记忆页里首轮加载的说明和信任标记。
- [x] 读取和搜索的续读入口已经存在，本任务只补测试。memory_read 返回完整正文；自动召回超过 3,000 字时截断，并提示用 memory_read 读余下部分（[recall.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/recall.js:44>)）；搜索按 limit 取，最多 100 条；首轮说明还有多少条笔记可以搜索（[inject.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/inject.js:187>)）。记忆笔记不需要分页读取，真正的截断在 Wiki 构建，见阶段 4。测试超过启动索引预算的条目可搜索，且末尾正文可读。现有旧值排除和更正后同会话版本召回继续验证。
- [x] 调整现有 rules.js / inject.js 中的保存提示，让模型知道记忆用于减少下一次的重复试错。保留「用户明确要求」与「对未来有用且有依据」两条主线。自动提议优先保留方法、依据和适用条件，能从仓库恢复的文件清单、一次性进度、尚未验证的猜测留在原会话。覆盖同一工作流里同时出现已验证经验、失败猜测和转发材料的场景。不要把只有失败经验可保存、每轮必须保存或固定每轮条数写成规则。
- [x] 补充读取和验证的提示：开工前先看首轮索引；照着记忆里的命令或值行动前先核实，发现错误当场用 memory_update 纠正。
- [ ] 先做一次桌面真实会话测试。在同一个项目中，会话 A 当场保存，会话 B 通过真实召回使用，用户更正后会话 C 使用新值。禁用 Dream 和 Wiki 做同一闭环，验证它们不参与日常保存。确认实际写入、展示、工具调用和回答，出现问题在本阶段收口。

**交付条件**  
仅安装日常记忆链路即可保存、看见、读到和纠正；明确保存和纠正后的笔记在新会话首轮可见；缺少 Dream 核验记录不会让已保存的笔记失去查找入口。

## 2. 将 Dream 改成可继续的后台任务

涉及 [runtime.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/runtime.js:636>)、[scheduler.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/scheduler.js:35>)、[dream-input.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-input.js:340>)、[dream-session-text.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-session-text.js:249>)、[llm-call.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/llm-call.js:69>) 和 [DreamPipeline](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-pipeline.js:239>)。

- [x] 扩展现有 .dreams 运行清单，记录 runId、projectId、输入会话及其结束事件位置、模型与格式版本、状态、每个工作单元的起止位置与证据定位、错误、用量和耗时。用会话 ID、事件范围和内容摘要识别分段；超长单条事件再带正文偏移。运行目录采用独立运行 ID。分析产物以分段保存，解决现有同会话多个块可能覆盖同名分析文件的问题。现在运行目录要等全部分析结束才创建（[dream-pipeline.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-pipeline.js:518>)），中途崩溃或取消会丢掉全部结果；新路径在启动时建目录，每完成一个单元写一次。
- [x] Dream 启动快速返回 runId。Host 按运行 ID 提供状态、取消与继续。沿用 /dream run、preview、apply，新增 /dream status <runId>、/dream resume <runId>、/dream cancel <runId>。HTTP 的现有 Dream 动作经同一个运行服务转发；保留现有兼容响应字段，并用新增 runId 和状态驱动新客户端。预览与应用要校验运行和项目。临时故障时用户可以看已完成、失败及待继续，历史失败只进历史。同阶段改 Dream 页：现在页面先调 estimate、再一直等 dry-run 返回方案，改为按 runId 显示状态、已完成与失败的单元、继续和取消。
- [x] 使用现有 runtime.track、AbortSignal 和项目锁管理任务。项目同一时间只运行一个 Dream worker，重复启动返回正在运行的 ID。现有锁是 1 小时未释放即视为失效的文件锁（[dream-pipeline.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-pipeline.js:31>)），可继续的长任务会超过这个时长；锁随进度续期，或归运行 ID 所有，失效判断以最后一次进度时间为准。停止时落盘未完成单元，撤销未来调度，等待或中止在途调用。重载后识别已落盘的运行，只继续缺失单元。会话关闭后的异步结果不重新填入其缓存。
- [x] 新路径的输入规划枚举已选定会话的完整事件范围，长输入自动拆分。移除会终止入队、截断正文或把剩余结果悄悄丢掉的插件字段依赖，重点检查 dreamMaxAnalyzerCalls、dreamAnalyzerTranscriptChars、dreamMaxClaimsPerSession、dreamMaxPatchesPerSession、dreamMapChunkChars、dreamMaxSessionChars、llmMaxTokens 及 Dream organizer 的字符裁剪配置。已有字段继续可被旧路径读取，新路径也不把官方 API 的 1–100 会话数当作本地硬门。这些字段不再截断任务后，启动前估算按产品约束 1 展示和确认。
- [x] 每段输出可独立核验的事实或纠正提案。只在解析与证据检查完成后持久化该段成功。输出截断时拆该段或细分输出任务，并记录分支。旧尝试返回不完整 JSON 时，剩余范围继续待处理。无事实的完整段单独标记完成。分析进度与应用水位分开；取消、失败或只做预览时，原应用水位保持原值。输入会话在运行中被删除或读不到时，该单元标记失败并写明原因，其余单元继续；用户决定把它移出范围后，方案才算覆盖完整。
- [x] 用可控 provider 夹具验证超过旧配置上限的长会话尾部被分析；一次传输失败、连续截断、重启、取消、同任务重复点击均可恢复，已成功单元的调用次数不增加。真实不可恢复失败带出对应范围和原因。开始新会话或手动保存期间，任务仍可继续。

> 实施记录：分段以「会话 ID + 首尾事件 seq + 正文摘要」合成为 unitId（`dream-run.js`），重跑按 unitId 命中已有记录；超长单条事件内部不再记偏移，改为按行/空格把该单元对半拆成两个 unitId 独立落盘，因此同一条事件被拆成多段时仍各占一份记录。每次运行在 `.dreams/<runId>/manifest.json` 落状态、输入、模型、计数、用量和最近错误，单元成功后写 `analysis/<session>/<unitId>.json`，记录里的 `verified` 带每条 claim 的 seq 与原话。organizer 的字符裁剪配置在新路径仍在（`dreamOrganizerCurrentChars`/`dreamOrganizerAnalysisChars`/`dreamMaxFileChars`），随阶段 3 移除终场 organizer 一并消失；`llmMaxTokens` 只作为单次传输预算，不再决定输入规模。输入会话在运行中被删除时，下一次规划不再列出它，不会产生新的失败单元（同一 run 内的旧失败记录保留）；「用户显式移出范围」的操作入口留到阶段 5 的界面。

**交付条件**  
新任务的运行状态可独立查看；旧失败预览不会重新变成待处理；长会话后半部分的事实可定位，恢复只处理缺失范围。

## 3. 让 Dream 逐条提议，宿主负责合并和应用

涉及 [dream-analyzer.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-analyzer.js:145>)、[dream-write-evidence.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-write-evidence.js:136>)、[dream-pipeline.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-pipeline.js:533>)、[DreamEngine.executePlan](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream.js:3172>)、[state.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/state.js:295>)。

- [x] 默认 Dream 复用分析器已有的逐条输出：claims 带事实、原话引用、类型、置信度和目标页；verify 对已有说法给出成立、矛盾或不确定，并附原话（[dream-analyzer.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-analyzer.js:50>)）。本任务只补两处：纠正时标出旧事实在页面中的位置；默认路径不再接受 `replace` 补丁，因为它要求模型返回整页正文。宿主按目标页和来源去重，用现有证据校验规则构造新增、补充或明确纠正。旧值进入 Superseded 历史；对象、数量或条件不一致、来源不可靠、定位不唯一则保留为审核项。日期和来源定位从已验证 transcript 取值。分段分析时，某段没有提到的笔记保持不动，不算矛盾；沿用 [dream-analyzer.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/dream-analyzer.js:27>) 按会话的同一规则，并加分段回归。
- [x] 把跨会话发现作为逐条提议的一种。分析结果先与当前主题笔记、同任务的其他已完成分段比对，再按同一事实合并。复用现有 focus 做分析优先级，完整跟踪输入覆盖。案例中放入两个会话各自不完整的线索、一次已核验的修正和一个仍无证据的猜测，验证 Dream 能合成可用经验，同时保留证据状态。
- [x] 从默认 Dream 路径移除生成全量页面、索引、SKILL 和全库合并的终场 organizer 调用。当前页面内容由宿主合并，索引重建复用现有宿主生成逻辑。相互矛盾的候选显示各自出处，用户决定。全库合并、重命名和重写留给显式维护命令，采用相同的分段、续跑和独立候选机制。宿主合并继续只产出证据检查接受的三类行：逐字保留的原有行、带引用的新事实行、元数据与标题和空行。跨页链接由宿主写成一行 `Related:`（`renderRelatedLinks`），模型不在正文里写链接行。organizer 提示词里关于逐字合并、不跨类型合并和链接的规则，随维护命令保留。审阅时展示合并后的完整页面，沿用现有对比视图。
- [x] Dream 可以提议修改首轮索引里某条笔记的一行简介，走同一证据检查和审阅。哪些笔记进首轮由宿主决定：现有排序先看每条笔记的读取次数，再看修改时间（[inject.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/inject.js:58>)）。核查范围限于本轮会话涉及的笔记，以及读取次数较多的笔记，不每次核查整个库。
  - 实施说明（0.12.3）：claims 里的 `description` 现在可以单独形成一条提案——即使事实行已在页面里，宿主也会写出只改简介的 write op（正文逐字不变、仍带 `baseHash`），首轮索引的那一行随之更新；简介没有变化则不产生操作；低置信度仍先进待审（`test/dream-merge.test.mjs` 两个用例）。哪些笔记进首轮仍由宿主决定：`buildMemoryIndex` 列出全部笔记，`inject.js` 的 hot 选择按读取次数再按修改时间取前 N。核查范围不再扩大到全库：证据校验只跑本轮真正写出的页面（`pageFullyVerified` 只对 write op 的正文），分析器看到的记忆页由 `dreamAnalyzerMemoryChars` 封顶而非全库无界。
- [x] 候选记录目标文件的基线哈希。应用前持锁重读当前文件与证据，检测在线编辑冲突。复用 DreamEngine 的备份、最终检查和撤销；写入事务后才更新应用水位。按运行 ID 与操作 ID 记录应用结果，同一请求重试不重复写入。发布过程中崩溃后，以持久化应用记录与文件哈希确定哪些已完成。未选中的可用条目保留待决定，只有明确完成的会话或空产出才推进连续水位。
- [x] 保留经典与 v2 历史记录的读取和已应用方案的撤销。旧预览仍遵守原证据和覆盖规则，不能直接变成新任务的完整结果。导入旧的成功会话水位作为起点，按项目区分。新旧任务共存时，发布用同一项目写锁，防止把用户新写入覆盖掉。
- [x] 回归覆盖：一次运行只有一条新事实；同一读超时从 15 改到 90；写超时 90 与读超时 15 并存；同页有效和冲突条目；在线保存恰好发生于审阅期间；中断于应用后的状态回写。完整测试从新会话读取现行值并核对历史。
  - 实施说明（0.12.2）：claim 合并的回归在 `test/dream-merge.test.mjs`（一条新事实、跨会话同事实去重、唯一行纠正 + Superseded、多处匹配进 review、低置信/无定位进 review/warning、未提及页面不动、Related 链接、应用期基线哈希冲突、默认路径不调用 organizer）；15→90 与写/读超时并存、审阅期间在线保存、应用回写由既有 `dream-pipeline.test.mjs`/`dream-v8`/`write-conflict` 用例覆盖。
  - 仍未实现（后续阶段跟进）：首轮索引成员未按「读取次数→修改时间」裁剪（`buildMemoryIndex` 列出全部页面）；analyzer 仍看到全部记忆页而非仅本轮相关 + 高读取页；应用结果未按 runId+opId 落账（一次运行只应用一次，重试重跑整份计划）。

**交付条件**  
默认 Dream 无需整库模型改写也能独立生成、审阅和应用。一条纠正不会被另一条处理失败吞掉，已完成的分析可以继续审阅，当前笔记始终可以读取。应用仍以完整覆盖和有效证据为前提。

## 4. 收口独立 Wiki 的构建与问答

涉及 [wiki-build.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/wiki-build.js:483>)、[wiki-store.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/wiki-store.js:201>)、[wiki-tools.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/wiki-tools.js:44>)、[共享状态服务](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/status.js:1571>)、[HTTP Wiki 路由](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/http.js:534>)。

- [x] 命令和 HTTP 统一走现有共享 Wiki 服务。现在命令走共享服务 `wikiBuild`，构建后刷新缓存；HTTP 直接调 `runtime.wikiBuild`（[http.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/http.js:543>)），不刷新，而记忆页的「构建」按钮走的正是 HTTP。统一开关、错误与工作区通知，只有正式发布成功才刷新该项目的发现提示。延续已有文本输入和来源标注；PDF、Word 等由用户先转换，发现不支持的文件时列出清单并标明构建覆盖。空目录和全不支持的目录直接说明原因。
  - 实施说明（0.12.2）：命令与 HTTP 都走 `runtime.wikiBuild`；`POST /wiki {action:'build'}` 在非 dry-run 且 `ok !== false` 后调用 `runtime.invalidateAllInjections('wiki-build')`，dry-run 和失败不刷新提示。
- [x] 借用 Dream 的运行状态语义，使用 Wiki 现有 .staging 与 .builds 保存每份文档的提取进度和归一化来源摘要。构建范围由开始时的文件清单和摘要固定。长来源分段，长页面按主题或章节拆分并维持链接。已知两处会悄悄截断：页面正文按 `maxPageChars` 直接截掉（[wiki-build.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/wiki-build.js:268>)），organizer 提示词超过 80K 字符后丢弃余下内容（[wiki-build.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/wiki-build.js:311>)）；另外检查 chunkDocument、normalizeExtraction、normalizeWikiWrites 的输出裁剪。单次输出失败时重做该段，继续使用已核验的提取记录。
  - 已完成（0.12.2）：静默截断已消除——`splitPageBody` 在行/标题边界把超长页面拆成 `x.md`、`x-2.md`…（`normalizeWikiWrites` 不再 `slice`）；organizer 超预算时在提示词里点名被略过的页面，并写入 `manifest.warnings`，那些页面保持不动；`normalizeExtraction` 丢弃的 claim 数记入构建警告；`chunkDocument` 本身无损。
  - 已完成（0.12.3）：每份文档的分段进度落到当前代的 `.claims/<sourceId>.parts.json`——按文档摘要（`sha256`）加每段自身摘要记录已完成分段的 claims，构建中断后重跑同一份文档时跳过已完成的分段，只重做失败段及其后各段（`manifest.stages[extract].partsReused` 计数）；整份文档完成后写回 `.claims/<sourceId>.json` 并删掉分段进度，之后的构建仍按整份摘要复用。用例：`test/wiki-extract-resume.test.mjs`（首轮在第二段失败，重跑只调用第二、三段）。
- [x] 现有段落 locator、claimId 和整代指针继续负责来源和发布。按段写出可引用事实，宿主生成索引；每条断言绑定可读来源，保留跨页链接。完整构建校验后原子切换 GENERATION。旧代的查询请求继续读原来的代，读取结束明确关闭引用，清理只处理无活跃读者的旧代。新代失败时仍能查询当前代。
  - 实施说明（0.12.2）：这部分为已有实现，本次核对并在测试中确认：`publishStagedWiki` 先写 manifest 再原子写 `GENERATION`；`test/wiki-build.test.mjs` 覆盖「发布中断不混代」「新代失败时旧代仍可查询」「活读者在用的代不被清理」。
- [x] 以来源分段为并发提取单元，独立保存已核验的证据，由宿主在发布前统一合并主题和修复明确的同义链接。源文里的命令、数值、条件和需要逐字核查的事实保留可定位原文。悬空链接在能唯一定位目标时修正，无法定位时保留明确缺口。相同语料二次构建复用来源摘要与已核验记录；改动来源只重做受影响内容，并复查旧引用。两份来源对同一数字或条件说法不一致时，两条都保留并各自标注来源，标为冲突；被新资料取代的旧数字标为被取代。回答时说明存在冲突。
  - 已做：按文档并发提取（`wikiBuildConcurrency`），claims 带 `sourceId#locator`，宿主写索引；两次相同语料只重做改动过的文档（`.claims/<sourceId>.json` 按摘要复用）；不同来源的同一数字各自保留并带自己的引用（`test/wiki-build.test.mjs` 的 `$123M` / `$125M` 双来源用例）；发布前宿主合并同名主题页（`mergeWikiTopics`，逐行去重、保留全部引用并写入警告），把只能指向一页的悬空链接改到该页（`repairWikiLinks`），无法唯一确定时保留并记录；同一句话出现不同数字且各有引用时两条都保留，较旧的那条后插入 `> 上一条数值已被较新的来源取代（<新日期>：<新值>）`（`markSupersededFacts`，不带引用、不改变事实行），冲突数计入 `manifest.conflicts`、被取代数计入 `manifest.superseded`；`validateWikiAnswer` 拒绝只引用被取代行的答案，要求同时说出新值；查询提示词要求冲突时同时说明两条与哪条更新（`test/wiki-host-merge.test.mjs`、`test/wiki-query.test.mjs`）。
- [ ] 用最终真实模型构建双来源语料，其中至少一份超过旧分块阈值，并把关键事实放在末尾。验收跨来源答案、错误 claimId、引用错段、无记录、失败时旧代可读，以及新会话是否能看到 Wiki 提示。问答走只读 Wiki 工具，返回事实出处或明确缺哪类资料。

**交付条件**  
用户可以单独构建和查询 Wiki。大文档尾部事实可检索，重试不会让之前可用的 Wiki 消失，缺资料时有清楚的反馈。

## 5. 桌面集成、迁移和最终验收

- [x] [status.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/status.js:1055>) 与 [http.js](<C:/Users/16864/Documents/deepseek-harness/default-workspace/plugins/dsh-cc-memory/src/http.js:603>) 已返回 `uiApi` 和 `version`，后端是旧代码时记忆页有提示；再补实际挂载能力和构建标识，把同一包的客户端、Host 与安装源码核对起来。老客户端可继续走原命令和接口。旧失败卡片只显示于历史，不计入待处理。待处理只统计真正可审核的写入，以及至少有一项未被预览拒绝的方案。
  - 实施说明（0.12.2）：`uiApi`/`version` 已在 `/status` 上，客户端对比 `UI_API` 并在旧后端时提示；**空方案不再列为待审**——`operations` 为空的 `lastPlanPath` 从状态视图隐藏并给出「没有要审阅的方案」说明（`state.snapshot()` 本身不变），有内容的方案照旧保留。
  - 实施说明（0.12.3）：`/status` 新增 `build`（`src/build-id.js` 对 package.json、index.js、client.js、cordis.patch.yml 与 status/http/inject/dream-run/wiki-build 共 9 个文件取 sha256 后的 12 位构建 id，附 `packageVersion`、安装路径与逐文件摘要）与 `capabilities`（`dreamPipeline`、`dreamRuns`、`claimMerge`、`wiki`、`explicitSaveLedger`），面板在版本行后显示构建 id；`UI_API` 提到 3，新面板配旧 Host 时提示升级。
- [x] 核对前几个阶段随接口交付的界面改动。记忆页首屏显示保存、可搜索与当前可用信息；Dream 显示本轮已读、失败范围、继续、取消和可审阅结果；Wiki 保留选择来源、发布和查询。无需等待面板即可从现有命令完成新流程。
  - 实施说明（0.12.3）：核对时发现 Dream 运行卡一直不显示——`normalizeStatus` 没有转发 `/status.dreamRuns`，页面读到空数组。已补上归一化（runId/status/stage/error/blockedReason/planPath/counts/expectedUnits），新增 `test/client.test.mjs` 用例「运行中显示 1 of 2 parts analyzed 与 Stop，失败时显示失败条数与 Continue」；同时把 `plan.review` 归一化并在 Dream 页列出前三条（`tidy.reviewItems`）。记忆页首屏的保存/搜索/信任筛选与 Wiki 的来源目录、构建、页面筛选、引用展示由现有 `test/client.test.mjs`、`test/ui-data-v21.test.mjs` 覆盖；命令路径（`/remember`、`/memory dream …`、`/memory wiki …`）不依赖面板。
- [ ] 对真实包做一次干净安装、一次已有数据升级、一次在运行中关闭重启。安装或升级前保留现有 Markdown、.state.json、历史、待处理与 Wiki 世代的备份。确认旧记录、回滚、手动记忆可用。先通过隔离 profile 验收，再切换用户正在使用的桌面安装。
- [ ] 从相同产物跑 node scripts/verify.mjs、node scripts/ui-freeze.mjs 和 node eval/validate.mjs。真实模型走四条：新会话保存与召回、转发加明确采纳、Dream 新旧值对照与中途续跑、Wiki 双来源和无记录。每条记录用户看到的实际答案、工具调用、状态变化、落盘差异、tokens 和耗时。
- [ ] 对照原有 8 会话故障场景做一次可复现的长输入验收，先在隔离 profile 用受控 provider 验证两类失败和恢复，再用真实模型逐步放量。比较改动前后调用数和重复分析次数。出现异常时定位 runId 与分段，复查当前工作区的记忆仍可独立读写。
  - 实施说明（0.12.3）：受控 provider 那一半已覆盖——`test/dream-run.test.mjs` 的「八个长会话」用例建 8 个会话（首个约 80K 字符），第 1 次分析强制 `max-tokens`（拆半重跑）、第 4 次强制传输失败，断言首轮 `status: failed`、`failed + done = expectedUnits`、`errors` 里有会话与原因；续跑只重做缺失的 1 个分段（`resume` 期间分析调用数 = 未完成分段数），结束后 `status: done`、覆盖完整，已完成的 18 个分段没有二次调用。真实模型逐步放量仍待做。

**发布条件**  
桌面使用者可以通过一次短的真实操作完成「记住 → 找到 → 用上 → 纠正」。Dream 失败时能看见本轮错误、从失败位置继续，旧结果保留历史。Wiki 成功切换且引用可追溯。功能通过后，才更新使用说明与发布产物。



