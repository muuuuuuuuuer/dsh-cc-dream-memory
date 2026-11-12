# Memory 与 Dream 实施计划

**交付目标**　日常写入能区分用户确认、转发材料和已验证的工程经验。Dream 能针对一条旧笔记查证和纠错，并能生成一张可持续更新的专题页。新会话能从正常入口使用更新后的记忆。

**代码基线**　以下文件和函数以本地 `archive/0.11.1`、`27e927f` 为准。已有未跟踪的 `.planning/`。实现时在隔离 checkout 上开工。若交付到公开版，先从 `0.12.0` 的 `f0a8a9f` 起实现，再把下面的接线点映射过去。公开版已有费用预估、用户范围召回和更强的 Dream 合并保护，应直接复用。两条基线的 Dream 引文规则也不同，改动应保留各自已有的证据检查。

**技术边界**　JavaScript ESM、Node ≥22、`node:test`。复用 Markdown、现有会话查询、存储锁、待审、预览和回滚。四个模型工具的描述及参数 schema 总长度继续满足 3000 字符测试。首版功能从工具和命令进入，适用现有 UI 冻结检查。验收使用独立 `memoryRoot` 和精简夹具。

## 0. 建立开工基线

- [ ] 在实施 checkout 确认 `git status --short`、`git rev-parse --short HEAD` 和包版本。
- [ ] 跑 `node scripts/verify.mjs` 和 `node scripts/ui-freeze.mjs`。Windows 若默认临时目录出现 `EPERM ... rename ... MEMORY.md`，在当前 PowerShell 进程把 `TMP`、`TEMP` 指向同一个已创建的、仓库之外的可写临时目录，再跑原命令。当前本地基线已用这个方法通过全量验证（62 个测试文件、462 项断言），UI 冻结检查也通过。
- [ ] 用真实事件结构搭两个最小夹具。夹具 A 先给转发清单，再给用户明确确认「以后交接文档先写结论」的对照消息。夹具 B 先记旧项目说明，再给新版源码和包含真实路由验证结果的会话。每个夹具用独立记忆根目录。

## 1. Memory 写入能说明用户确认了什么

**入口**　`src/tools.js` 的 `memory_save`、`memory_update` → `src/write-review.js` 的 `reviewWrite()` → `src/pending-writes.js` 或 `src/store.js`。

- [ ] 在 `test/write-boundary.test.mjs` 加四个回归：转发清单加 `force:true` 不写成有效偏好；`project` 笔记中的「用户要求」同样走审阅；明确确认过的单条要求可以写入；注入消息、子代理简报和工具输出不能作为用户确认。
- [ ] 给保存和更新工具增加同一个可选参数 `quote`，供模型定位相关原句。新增 `src/memory-evidence.js`，提供 `resolveSessionQuote({ sessionQuery, sessionId, quote })`，返回宿主查到的 `{ sessionId, seq, kind }`，或返回 `null`。从当前已解析的会话取 ID，复用 `src/dream-session-text.js` 的来源识别。只有宿主确认的来源位置可落盘。没有可靠的宿主会话来源、匹配有歧义或无法区分转发和确认时走现有待审。
- [ ] 给 `reviewWrite()` 增加可选 `evidence` 和 `authority` 入参。`user`、`feedback` 以及其他类型中显式声称用户采纳的新声明，都检查这条规则。第一版只有可直接对应明确确认的单条声明自动写入，混合声明或范围扩大的改写进入待审。描述和名称中的归因也检查。现有 `/remember`、手动编辑和明确批准仍是直接用户入口。
- [ ] 让待审记录携带宿主找到的证据位置和已有 `expectedHash`。待审期间原笔记不变。批准过期提案仍应拒绝覆盖。运行 `node --test test/write-boundary.test.mjs test/tools-v11.test.mjs test/user-scope-v12.test.mjs`，同时检查两个工具预算用例。

## 2. Memory 更正后能召回现行值

**入口**　`src/store.js` 的 `_composeFrontmatter()`、`saveEntry()`、`updateEntry()`、`renameEntry()`、`writeRawEntry()`，以及 `src/recall.js`、`src/inject.js`、`memory_read`。

- [ ] 增加可选标量 frontmatter。`memory_status` 取 `active` 或 `needs-review`，旧文件缺省按 `active` 读取。`evidence_refs` 用现有标量序列化器保存 JSON 文本，条目为 `{ claim, sessionId, seq, kind }`，其中 `claim` 是对应的现行声明。沿用 `source_session`、`via` 记录文件写入来源。每个写入口保留未改声明的引用，移除已改声明的旧引用。`memory_read` 返回解析后的状态及来源位置。
- [ ] 明确纠正走原文件更新，用 `expectedHash` 保证引用和正文对应同一版本。用 `_recordHistory()` 保留旧值，通过 `/memory history` 追溯。扩展历史测试时覆盖同名项目笔记和用户笔记。历史版本的写入与读取使用同一 scope，现有项目历史继续可读。
- [ ] `selectRecall()` 过滤 `needs-review`，用 `scope + file + version` 做去重。版本使用文件内容的可靠版本标识，避免同一毫秒内的更新被旧记录压住。`attachRecall()` 以实际读取并成功附带的版本记账。保留现有项目/用户范围开关。首轮注入用当前的简短索引，并排除待核实条目。显式 `memory_read` 仍可读待核实笔记，并返回状态。
- [ ] 在 `test/store.test.mjs`、`test/history-v12.test.mjs`、`test/memory-recall.test.mjs`、`test/injection-v4.test.mjs` 覆盖旧格式读取、保存或批准后的出处、纠正后历史可读、同一会话召回新版、待核实条目不上首轮或自动召回、不同 scope 同名互不影响。用 `node --test test/store.test.mjs test/history-v12.test.mjs test/memory-recall.test.mjs test/injection-v4.test.mjs` 验收。

## 3. Dream 按一条笔记查证并产生可审阅修正

**接线**　`src/commands.js` 的 `memoryDream()` → `src/status.js` 的 `dream()` → `src/runtime.js` 的 `dream()` → `src/dream.js` 的 `DreamEngine.run()` → `src/dream-input.js` 的 `gatherDreamInput()`。

- [ ] 接入 `/memory dream estimate --topic <file>` 和 `/memory dream run --dry-run --topic <file>`。公开版复用已有 `estimate`，本地基线增加对应的只读分支。两个入口把同一个 `topic` 选项传给 `gatherDreamInput()`。已有 `--focus` 继续表达用户关心的问题。
- [ ] `gatherDreamInput({ ..., topic })` 用 `store.readEntry()` 验证项目范围的目标文件。把已记录的来源会话与本项目 `sessionLookback` 内的候选会话合并，先保留直接证据，再用标题、描述和相关命令选片段，保留命中的整条消息及配对工具事件。局部核对可复查以前读过的证据，继续过滤子会话和注入消息。复用现有字符、分块及 token 配置。返回目标文件、实际选中的 `{id, firstSeq, lastSeq}`、截断或缺失情况。预估走同一条选择路径并显示输入规模。
- [ ] 核对当前代码时，两个命令都接受 `--source <file1,file2>`，参数为相对仓库根目录的路径。沿同一路径传给收集器，只读经仓库根目录校验的已跟踪文本文件，计入同一输入预算。交给模型的证据带相对路径和行号，计划附源码指纹。应用前源码变动则要求重新核对。夹具用 `src/config.js` 查当前默认值，用 `package.json` 查当前项目定位，分别检查能回查出处和应用后笔记内容。
- [ ] 在 `src/dream-map.js` 的分析输出增加针对旧结论的 `support | contradict | uncertain` 结果和引用。`src/dream-prompt.js` 用这些结果提出修正，`src/dream-evidence.js` 复用步骤 1 的来源规则。会话没提到旧结论时保留它。审计夹具里的配置副本移出正文，保留已核对的源码入口和路由验证经验。旧说法的归档由步骤 2 的历史记录承担。
- [ ] 局部计划持久化目标和输入范围。`validateDreamPlan()` 只允许修改目标文件，拒绝模型提供的删除、其他文件写入和整表索引操作。`writeRawEntry()` 已会维护对应索引行，局部 `executePlan()` 使用这个路径，跳过全局索引重整。`applyPending()`、`applyPlanOperations()` 和撤销都识别局部计划。局部运行保留 `sessionsSince` 和 `dreamProcessedSessions`，包括当前 `apply-ops` 会调用 `clearSessions()` 的路径。旧全量计划继续走原分支。
- [ ] 验收命令：`node --test test/commands.test.mjs test/dream-gather.test.mjs test/dream-map.test.mjs test/dream-evidence.test.mjs test/dream-boundary.test.mjs test/watermark-v16.test.mjs`。预估与运行的选源在同一快照下一致。截断目标、过期提案和越界写入不会应用。应用及撤销后，其他文件的内容和全量会话状态保持正确。

## 4. 交付可更新的「项目验证经验」专题页

- [ ] 复用步骤 3 的局部计划。增加 `/memory dream run --dry-run --page <slug> --from <file1,file2>`。来源笔记按项目 scope 解析并作为只读输入，唯一可写目标是 `project_<slug>.md`。用现有 `project` 类型，页面包含现行结论、验证步骤、适用条件、例外和来源链接。
- [ ] 首张页由两个来源生成。一个记录直接调用 handler 通过而真实入口返回 404，另一个记录修复后通过真实入口验证、以及尾斜杠合法的情况。更新第二份证据后再跑一次，复用同一 slug。写入前用原文件指纹保护并发编辑。
- [ ] 在 Dream 边界测试里检查同一页可创建、更新和撤销，来源文件未被改写。通过 `memory_search` 和正常召回找到页面，通过 `memory_read` 读出现行规则并回查证据。

## 5. 通过正常入口验收首版

- [ ] 新会话遵循用户纠正后的规则，能追溯旧值，并且不会把只转发的报告当长期偏好。
- [ ] 对审计夹具先预览、再应用 Dream 修正。新会话查询当前配置时能指到源码，路由经验仍可召回。撤销能恢复原笔记。
- [ ] 在独立测试工作区给新会话一个不同的路由改动。用真实路由调用及测试退出码检查验证方法，另有一个合法尾斜杠用例。
- [ ] 新会话通过专题页综合多段历史，说明规则为何改、现在如何执行、例外是什么，并给出处。
- [ ] 在 `eval/scenarios.dream-session.dev.json` 增加 `dreamTopic` 场景，把目标文件传给 `src/tools.js` 中仅在评测模式注册的 `memory_eval_dream`，用它走同一 Dream 引擎。现有 `eval/run.mjs` 对 `dreamSessions: true` 会清空 C 组记忆，带 `dreamTopic` 的场景保留旧笔记，原 Aurora 用例继续清空。用 `test/eval-run-smoke.test.mjs` 验证两条路径。更新后跑 `node eval/freeze.mjs`、`node eval/assert-harness.mjs`，先以 `--fake-model` 验证装置，再在隔离宿主里执行四个新会话任务。记录 Dream 和查询的用量、耗时和实际输出。
- [ ] 跑全量 `node scripts/verify.mjs` 和 `node scripts/ui-freeze.mjs`。四个端到端场景与回归通过后，Memory、Dream 和专题页一起交付。

参考：[Anthropic Agent Memory 报告](https://www.anthropic.com/research/components-of-agent-memory) · [Dynamic Dream 示例](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow) · [Knowledge Wiki 示例](https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/knowledge-wiki)
