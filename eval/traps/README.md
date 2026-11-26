# 陷阱题集：无插件 / 记忆 / 记忆 + Dream

一份我们自己写的 20 题评测，沿用 LongMemEval-S 的数据格式和 `eval/longmemeval/run-lme.mjs` 的完整流程，用来回答一个问题：**按 session 逐步记笔记，再由 Dream 整理，会不会比不整理更好，有没有被整理坏。**

## 测什么

同一个项目（Node 后端 orbit，开发者是中文用户）的 20 段独立历史，每段 4–8 个 session，其中 2–4 个是无关的杂务 session（eslint、git、正则、SQL 等）。每个问题都是用户在新 session 里会自然问的话，不带“后来改了吗”之类的提示。

题目针对的是增量记笔记的真实失败方式：早先的事实后来被改掉、一次性覆盖被当成默认、例外被泛化、粘贴材料或助手自己的说法被当成用户的决定、散在多个 session 的信息只记了一部分、没说过的细节被脑补。另有两道对照题，用来发现 Dream 把本来正确的笔记改坏。

## 三条线

| 线 | 记忆 |
|---|---|
| A 无插件 | 插件禁用，新 session 直接回答。 |
| B 记忆 | 插件的 auto-extract 按时间顺序逐 session 读历史并写笔记，冻结为 `checkpoint-before-dream`。 |
| C 记忆 + Dream | 从同一份 B 的笔记出发，Dream（真实模型子代理，正常的证据检查与切换流程）跑完所有 session；无引用的改动会被推迟，不会应用。 |

三条线用同一个模型、同样的提示（`Current date: <question_date>` + 问题 + `Answer directly.`），各自在新的无头 DSH session 里回答。参考答案、`group`、`trap`、`evidence` 等字段不会进入插件：`sessionsOf()` 只读 `haystack_session_ids`、`haystack_dates`、`haystack_sessions`。

## 20 道题

| id | group | 陷阱 |
|---|---|---|
| trap_ku_01 | correction-later | 早先定的上线日期 10/15 在后来的 session 里被顺口改成 10/22，笔记里可能只留下旧日期或两个日期并存。 |
| trap_ku_02 | correction-later | 工具从 pnpm 换成 bun 是在讨论 CI 缓存时顺口说的，README 里助手写的 pnpm 容易留在笔记里。 |
| trap_ku_03 | correction-later | 用户先说了 6380，助手据此写进配置；之后用户在排查连接失败时更正为 6381，旧值容易留在笔记里。 |
| trap_ku_04 | correction-later | 先定了 cursor 分页，后来因运营要跳页而推翻；笔记可能保留最初的决定。 |
| trap_ov_01 | one-off-vs-default | “这次用中文”是一次性覆盖，笔记可能把它记成新的默认。 |
| trap_ov_02 | one-off-vs-default | 这次的手动发布是一次性特例，笔记可能把它和默认流程混为一谈或丢掉。 |
| trap_ov_03 | one-off-vs-default | 事故时临时降低到 1 人 approve 是一次性例外，笔记可能把它当成新规则。 |
| trap_sc_01 | scope-exception | “所有包 strict” 是通用规则，legacy-importer 是例外；笔记可能只记通用规则。 |
| trap_sc_02 | scope-exception | “发布前必须 e2e” 是通用规则，dev 环境是例外；笔记可能只记通用规则。 |
| trap_sc_03 | scope-exception | scripts/ 目录对 console.log 的例外容易被泛化成“可以用 console.log”。 |
| trap_pv_01 | provenance | 供应商邮件（粘贴材料）里的 24 小时建议可能被当作用户的决定记下来。 |
| trap_pv_02 | provenance | 助手在 Dockerfile 里凭空写了 “线上 Node 18”，用户从未说过，后来才否认；笔记可能记下助手的说法。 |
| trap_pv_03 | provenance | 同事的复盘草稿（粘贴材料）里的错误归因 “Kafka 重复消费” 容易被当成事实记下，用户后来才纠正。 |
| trap_sy_01 | synthesis | 发版步骤分散在三个 session，增量记笔记容易只留下其中一部分。 |
| trap_sy_02 | synthesis | 四个坑分散在四个 session，每次只提一个，笔记可能只留最近的一两个。 |
| trap_sy_03 | synthesis | 三个环境的部署位置分散在三个 session，笔记可能只记其中一两个或把 staging 和 prod 混淆。 |
| trap_ab_01_abs | abstention | 相邻 session 里出现的“小周请假”是诱人的牵强解释；用户从未说过推迟的原因。 |
| trap_ab_02_abs | abstention | “老板要压缩成本”容易让人推断是老板批的，但用户从未说过谁批准。 |
| trap_ct_01 | control | 事实稳定且重复出现，旁边有相似的内部前缀 /admin/v1 作干扰；B 应已答对，用来发现 Dream 把它改坏。 |
| trap_ct_02 | control | 事实只说一次，旁边有相似的展示层时区 Asia/Shanghai 作干扰；B 应已答对，用来发现 Dream 把它改坏。 |

完整的问题、参考答案和证据在 `traps.json`。每个非弃答题的 `evidence` 是 `{session, turn, quote}` 列表，`quote` 必须是该用户回合里逐字出现的原文；`answer_keys` 是正确回答必须传达的短语，每个都必须出现在某条 quote 里。两道弃答题（id 以 `_abs` 结尾）改用 `absent_keys`：这些词在整段历史里都不能出现。`validate.mjs` 会强制检查这些。

## 怎么跑

前置条件同 `eval/longmemeval/README.md`：设置 `DEEPSEEK_API_KEY`，并有无头 profile `cc-memory-lme`（含 `dsh-base`、`dsh-headless`、`dsh-cc-dream-memory`，链接到本仓库）。

```bash
node eval/traps/validate.mjs                     # 不调用模型：校验格式与证据，打印 sha256

export LME_DATA=eval/traps/traps.json
export LME_RUN=<仓库之外的目录>                   # 例如 %LOCALAPPDATA%/Temp/traps-runs/run-1
export LME_PROFILE=cc-memory-lme                 # 默认值

node eval/longmemeval/run-lme.mjs build --concurrency 5
node eval/longmemeval/run-lme.mjs answer --concurrency 3
node eval/longmemeval/run-lme.mjs grade
node eval/longmemeval/run-lme.mjs report
```

数据集的每道题都带 `group` 时，harness 会跑全部题目（不做哈希抽样），报告按 `group` 首次出现的顺序分组，标题用数据集文件名，并把数据集的 sha256 写进 `sample.json` 和报告。

## 冻结规则

- 题目在任何一次运行之前定稿；看到结果之后不改题、不改参考答案、不改证据。
- 要改就另存新版本（新文件名，例如 `traps-v2.json`），新版本重新跑，旧结果不动。
- 报告里的 sha256 必须等于 `validate.mjs` 打印的值，用来确认跑的是冻结版本。

## 局限

- 评判模型是 deepseek-flash（官方 LongMemEval 提示词），不是官方的 GPT-4o；个别题可能被误判，所以报告里要看逐题的回答，不只看比例。
- 历史是重放的：主代理在对话当时的实时记忆写入没有被模拟，B 线只反映 auto-extract 对历史的处理。
- 题目少（20 题，每组 2–4 题），一题的差别就是 5 个百分点，只能看趋势和具体失败案例，不能当统计结论。
- 题目由我们编写，历史是合成的对话，比真实对话更干净、更集中。
