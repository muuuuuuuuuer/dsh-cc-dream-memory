# 陷阱题集 v2：按代码行为设计的记忆评测

v1（`eval/traps/`，已冻结）里 B 线（auto-extract 笔记）18–20/20，题目偏容易：历史短、纠正显式，增量记笔记就够了。v2 的目标相反：**从 auto-extract / Dream / 召回的实际代码行为出发，逐条设计 B 线会在哪里失败，再用同一套 A / B / C 流程去验证这些假设。**每题带 `b_hypothesis`（B 预计怎么失败、依据哪段代码），结果出来后用 `classify.mjs` 区分“B 从没记下”“旧笔记没被改”“Dream 修好了”“Dream 改坏了”。

数据格式沿用 LongMemEval-S 和 v1 的额外字段（`group`、`trap`、`evidence`、`answer_keys`、弃答题 `_abs` + `absent_keys`），新增 `mechanism`、`b_hypothesis`、可选的 `stale_keys`、`key_variants`、`dense_facts`。`group` 与 `mechanism` 相同，报告按它分组。

## 它依赖的代码行为（常量以源码为准）

**auto-extract（`src/auto-extract.js`，配置默认值见 `src/config.js`）**
- 每次运行只读游标 `since` 之后的事件（`runtime.extractCursors` 与持久化的 `extractSeqs` 取大者），用 `chunkTranscript(..., { chunkChars: autoExtractMaxChars = 12000, toolCharsPerChunk: 4000, resume })` 切块后只取第一块（`const [chunk] = ...`）；积压的后续块要等下一次运行，且游标在 `no-writes` 时也前移。
- 模型看到的是新窗口 + 现有索引文本 `indexText.slice(0, 4000)`（只有描述；笔记正文要它自己调 `memory_read` / `memory_search`），最多 `autoExtractMaxItems = 5` 条 `memory_save`，`maxTurns: 5`，单条正文上限 `CONTENT_MAX = 4000`。
- 提示词：“Save only knowledge a future session cannot recover from the repository, its history, or its instruction files.”；“Never save secrets, credentials, one-off task chatter, code patterns, file paths, repository structure, git history, or generic debugging recipes.”；“A question, a hypothetical, an assistant suggestion, or a one-turn formatting request alone establishes no lasting user fact.”（`MEMORY_SELECTION`）。
- 实时调度（`src/scheduler.js`）：每个 turn 结束 `runtime.noteTurnEnd`，`turn.turns % autoExtractEveryTurns (3) === 0` 才运行；主代理自己写过记忆的那一轮跳过。

**转录（`src/dream-session-text.js`，auto-extract 与 Dream 共用）**
- 用户消息逐字保留；只保留每条用户消息之前的那一条助手消息，且截到 `ASSISTANT_CONTEXT_CLIP = 2000` 字符；只有失败的工具调用进入转录；长且结构化的用户消息（`PASTE_MIN_CHARS = 800` 且 ≥ 12 行，或 ≥ 4 个结构化行）被标成 `[user-pasted]`。
- 一块的文字预算 `limit - toolBudget - 32`，每条消息按 `length + 17` 计；超过的消息被拆分，所以含大段粘贴日志的 session 会跨两块。

**Dream（`src/dream-agent.js`）**
- 一次最多提供 `dreamMaxTasks = 4` 个 session，按顺序整段读（`dream_read_session`），可读完整笔记并合并 / 删除 / 移动；目的文字是 “correct notes that contradict it, merge duplicates, drop one-off or disposable content, and keep every note and the index compact”。它的提示里没有“仓库里能查到就不存”这条规则。

**召回（`src/recall.js`）**
- 答题时选择器看到文件名和描述（可有节选），最多附 `autoRecallMaxFiles = 3` 个文件、总长不超过 `autoRecallMaxChars = 3000`；选择器提示说“The agent already sees every file's one-line description in its index”，只在需要正文时才附文件。回答的代理另能看到注入的索引并有 memory 工具。

## 七类机制（各 2–4 题，见下表）

| mechanism | 题数 | 利用的行为 |
|---|---:|---|
| `window-anaphora` | 4 | 决定出现在长 session 的前面；撤回出现在 12000 字符分块的下一块（2 题，同一 session，隔三段粘贴日志，也落在不同的 3 轮组）或之后另一个 session（2 题），且只说“刚才那个方案 / 前阵子说的那个大工程”，与旧笔记描述没有关键词重合。B 只看到新窗口 + 4000 字符内的索引描述。 |
| `index-mismatch` | 4 | 更新换了说法（“退钱 / 签字的线”“一屏放 50 行”“原始埋点 / 过期删除的天数”“断线检测的窗口”），B 倾向另开一条；提问沿用旧说法，召回只按描述挑 ≤ 3 个文件，容易附上旧笔记。 |
| `fragmentation` | 4 | 一个主题（接入清单、发版步骤、DAG 上线要求、新设备接入）散在 6 个 session，每次一句、措辞不同；答案需要 5–6 块，召回 ≤ 3 文件 / 3000 字符。 |
| `dense-window` | 3 | 开头 3 个用户回合（同一 3 轮组、同一块）里一次说 9 条互不相关的约定；B 每次最多存 5 条；被问的是第 7、8、9 条。 |
| `lossy-detail` | 3 | 精确的命令参数 / 路径 / 号码 / 桶名只说一次，嵌在较长的讨论里；提示词“不存文件路径”，且倾向概括。 |
| `selection-standard` | **2** | **仓库配置值**（`config/default.json` 的重试取值；`vite.config.ts` 的代理地址）。auto-extract 的“仓库里能恢复就不存”规则会跳过，Dream 没有这条规则；回答时没有文件工具。**这两题测的是 B / Dream 的选择标准差异，不是整理能力**，报告里单独看，不要和 `window-anaphora` 等混算。 |
| Dream 风险对照（共 4 题） | 4 | `over-merge`（订单管道 ap-southeast-1 与风控管道 eu-west-1 说法相近但不同，问较少见的那个）、`one-off-kept`（展会凌晨一次性调 `max_connections` 的细节，Dream 目的文字要求丢弃一次性内容）、`abstention` × 2（心跳间隔、EMQX 升级负责人：相邻 session 里有牵强的解释，但用户从未说）。 |

## 24 道题

“参考答案”见 `traps.json` 的 `answer`；每个非弃答题的 `evidence` 是 `{session, turn, quote[, role]}`，`quote` 必须是该用户回合里逐字出现的原文，`answer_keys` 的每个词（`|` 分隔的任一写法）必须出现在某条 quote 里。`stale_keys` 是“若当前笔记仍在断言它，说明笔记已过时”的字符串。历史来自四个新项目：计费后端 billing-core（Node/Postgres）、电商后台 shop-admin（React/Vite）、数据管道 data-pipeline（Airflow/ClickHouse）、物联网网关 iot-gateway（Go/EMQX），每段历史 8–15 个 session，一半左右是真实但无关的杂务和另外的长期偏好（commit 规范、测试、日志、时区、依赖白名单……），使索引长到约 10–15 条，召回必须做选择。

| id | mechanism | 问题 | b_hypothesis |
|---|---|---|---|
| v2_wa_01 | window-anaphora | 对账任务 reconcile-daily 现在是用什么来调度的？ | 决定在长 session 开头（窗口 1 / 3 轮组 1）被保存；撤回发生在 12000 字符分块的第 2 块、粘贴日志之后，B 只看到新窗口里的“刚才那个方案作废，现状保持”和 4000 字符内的索引描述，没有关键词（BullMQ、reconcile）可以对上旧笔记，旧笔记原样保留。 |
| v2_wa_02 | window-anaphora | 商品批量导入现在是怎么实现的？ | “改成后端异步任务”的决定在长 session 的第一个回合（窗口 1）；撤回在三段粘贴构建 / 测试日志之后的分块 2 里，只说“刚才那个方案作废，后端排期排不上”，没有任何和旧笔记描述重合的词，B 只看到新分块 + 索引描述，旧决定留在笔记里。 |
| v2_wa_03 | window-anaphora | 今年 Q4 我们要不要做 ClickHouse 集群扩容？ | 决定出现在一个超过 12000 字符的长 session（含粘贴日志）的开头，被保存；撤回发生在几天之后的另一个 session，只说“前阵子说的那个大工程不搞了，预算被砍了”，没有 ClickHouse / 扩容 / Q4 这些词；B 只看到新窗口和 4000 字符内的索引描述，笔记里的“Q4 扩容”会保留。 |
| v2_wa_04 | window-anaphora | 固件 OTA 升级现在是怎么往设备推的？ | “分批灰度、每批 5%”的决定在较早的长 session（含 EMQX 与网关日志粘贴，超过 12000 字符）里被保存；之后另一个 session 里用户只说“上次说的那个方案不用了，合同里写死了要一次性推完”，没有 OTA / 灰度 / 5% 等词，B 只看到新窗口 + 索引描述，旧笔记保留。 |
| v2_im_01 | index-mismatch | 退款超过多少钱需要财务主管审批？ | 旧笔记的描述是“退款审批阈值 5000 元”；更新说成“退钱 / 主管签字的线抬到两万”，词汇对不上，B 倾向于另开一条“签字门槛两万”的笔记，旧笔记留在索引里；提问用旧词“退款 / 审批”，召回只看描述且最多附 3 个文件，容易挂上旧笔记。 |
| v2_im_02 | index-mismatch | 订单列表默认每页显示多少条？ | 旧笔记描述是“订单列表分页默认每页 20 条”；更新说成“订单那个表默认一屏放 50 行”，不含“分页 / 每页 / 条”，B 倾向新写一条“表格一屏 50 行”，旧笔记留在索引里；提问沿用旧词“每页多少条”，召回按描述匹配会先附上旧笔记。 |
| v2_im_03 | index-mismatch | S3 里的原始日志保留多久后删除？ | 旧笔记描述是“S3 原始日志保留 90 天后删除”；更新说成“原始埋点最少得存一年，过期删除的天数改成 365”，词汇（埋点 / 过期删除的天数）对不上，B 倾向于另写一条；提问沿用“原始日志保留多久”，召回按描述匹配会挂旧笔记。 |
| v2_im_04 | index-mismatch | 设备多久没有心跳就算离线？ | 旧笔记描述是“心跳超时 60 秒判定设备离线”；更新说成“断线检测的窗口放宽到两分钟”，词汇（断线检测的窗口）对不上，B 倾向另写一条；提问沿用“心跳 / 离线”，召回会挂旧笔记。 |
| v2_fr_01 | fragmentation | 有个新服务要接入计费网关，需要做哪些事？ | 六件事分散在六个 session、每次一句、措辞各不相同（注册 / 证书 / 限流 / 幂等头 / 压测 / 值班），没有一个窗口里出现“接入清单”这个主题，B 很可能写成多条互不关联的小笔记或漏掉其中几条；召回最多附 3 个文件 / 3000 字符，拼不全。 |
| v2_fr_02 | fragmentation | 前端发一次 prod 版本，完整的步骤是什么？ | 五个步骤分散在五个 session、每次是闲聊里顺带的一句（打 tag / 选任务 / 刷 CDN / 冒烟 / Sentry），没有哪个窗口出现完整流程；B 可能只记下其中一两条或各写一条小笔记，召回最多 3 个文件，拼不全。 |
| v2_fr_03 | fragmentation | 新建一个 Airflow DAG 要满足哪些要求才能上线？ | 五条上线要求分散在五个 session，每次顺带一句，措辞不同（命名 / owner / SLA / 失败回调 / 预发空跑），没有一个窗口集中出现；B 倾向写成零散小笔记或漏掉，召回最多 3 个文件，拼不全。 |
| v2_fr_04 | fragmentation | 接入一款新型号的设备，需要走哪些步骤？ | 五个接入步骤分散在五个 session，每次只提一句，措辞不同（登记 / 权限 / 物模型 / 拷机 / 看板），B 倾向写成零散小笔记或漏掉；召回最多附 3 个文件，拼不全。 |
| v2_dw_01 | dense-window | 线上支付成功率低到多少，就得回滚这次发布？ | 开头 3 个用户回合（同一个 3 轮组、同一个分块）里一次说了 9 条互不相关的发布约定；auto-extract 每次最多 save 5 条，目标事实排在第 8 位，容易被丢掉；记下的几条也可能是合并后的概述。 |
| v2_dw_02 | dense-window | 运营导出报表，一次最多能导多少行？ | 开头 3 个用户回合里一次交代 9 条产品与运营约定（人名、日期、频道、限制），auto-extract 每次最多存 5 条，被问的“导出最多 3 万行”排第 8；这类零散约定也容易被合并成一条概述而丢掉数字。 |
| v2_dw_03 | dense-window | 数据质量检查里，空值率超过多少要阻断下游任务？ | 开头 3 个用户回合里交代 9 条数据组的约定（分区、注释、口径文档、DBA、评审会、登记、阻断阈值、回刷报备、告警分级），B 每次最多存 5 条，被问的“空值率 2% 阻断”排第 7；也可能被合并成“数据质量有检查”这类概述而丢掉数字。 |
| v2_ld_01 | lossy-detail | prod 紧急回滚到某个 tag，具体该执行什么命令、带哪些参数？ | B 的提示词明确说不要保存 file paths 和 generic debugging recipes；这条回滚命令埋在一段较长的发布讨论中间，最可能被概括成“回滚用 rollback 脚本，注意别回滚数据库”，丢掉脚本路径和 --env / --keep-db 参数；Dream 重读 session 才能找回。 |
| v2_ld_02 | lossy-detail | 商品退货要寄到哪个仓？联系谁、分机多少、什么时段收货？ | 这几个精确的名字、分机号和时段在一段关于退货流程的长讨论中只说一次；B 倾向于概括成“退货寄回昆山仓，联系周敏”，丢掉分机和收货时段这类细节（提示词要求跳过一次性琐事、每次最多 5 条）；Dream 重读 session 才能补回。 |
| v2_ld_03 | lossy-detail | 原始埋点数据在 S3 的哪个桶、什么前缀、哪个区域？用什么 KMS key？ | 桶名、前缀、区域、KMS 别名四个精确字符串在一段较长的讨论里说一次；auto-extract 提示词要求不存 file paths，且更倾向概括成“原始数据在 S3 的 raw 桶里”，具体名字丢失；Dream 重读 session 可以补回。 |
| v2_ss_01 | selection-standard | 我们调用支付渠道的重试策略是怎么配的？最大次数、退避、超时分别是多少？ | 这是 config/default.json 里的取值，“仓库里能查到”：auto-extract 提示词规定只保存“未来 session 无法从仓库、历史或说明文件恢复的知识”，B 倾向于跳过；回答时没有文件工具，B 答不出。这一题测的是 B 与 Dream 的选择标准差异，不是整理能力。 |
| v2_ss_02 | selection-standard | 本地开发时，/api 的请求被代理到哪里？前端 dev server 用哪个端口？ | 这是 vite.config.ts 里的 server.proxy 配置，仓库里就有：auto-extract 提示词规定只保存“仓库里恢复不了的知识”，B 倾向于跳过；回答时没有文件工具，B 答不出。这一题测的是 B 与 Dream 的选择标准差异，不是整理能力。 |
| v2_om_01 | over-merge | 风控管道的数据存放在哪个 S3 区域？ | 本题是 Dream 风险对照：两条管道的区域说法相近、分散在两个 session，B 通常分别记下；Dream 的“合并重复”可能把两条笔记并成一条“S3 区域是 ap-southeast-1”，丢掉风控的例外。 |
| v2_oo_01 | one-off-kept | 上次展会那天凌晨，我们手动在 prod 上改了 EMQX 的什么参数，改成了多少？ | 本题是 Dream 风险对照：这是一次性事件，B 的提示词会跳过“一次性任务闲聊”，但本题用户说得很具体且带原因，B 可能保留；Dream 的目的文字是“丢弃一次性或可弃内容”，重读后可能把这条笔记当作一次性内容删掉或压缩到只剩“临时扩容过”。 |
| v2_ab_01_abs | abstention | 为什么把设备心跳间隔从 30 秒改成 45 秒？ | 相邻 session 里出现“客户投诉续航短”，B 或回答模型容易据此脑补“为了省电”；本题测的是不脑补，B 笔记里若写下了未陈述的原因会被判错。 |
| v2_ab_02_abs | abstention | EMQX 升级到 5.6 这件事是谁在负责？ | 相邻 session 里老周（帮忙开 K8s 权限）的出现，容易让 B 或回答模型把“负责人”脑补成老周；本题测的是不脑补。 |

## 怎么跑

前置条件同 `eval/longmemeval/README.md`：`DEEPSEEK_API_KEY`，无头 profile `cc-memory-lme`。不调用模型的检查：

```bash
node eval/traps-v2/validate.mjs        # 格式、逐字证据、机制检查（分块数、窗口位置），打印 sha256
node eval/traps-v2/check-cadence.mjs   # LME_EXTRACT_EVERY_TURNS 的切片接线（假模型，真 runAutoExtract）
```

真正的运行（会花 API 额度，需先让评审通过）：

```bash
export LME_DATA=eval/traps-v2/traps.json
export LME_RUN=<仓库之外的目录>                 # 例如 %LOCALAPPDATA%/Temp/traps-v2-runs/run-1
export LME_EXTRACT_EVERY_TURNS=3                # 按线上节奏重放 auto-extract；不设则与 v1 / LongMemEval 相同
node eval/longmemeval/run-lme.mjs build --concurrency 4
node eval/longmemeval/run-lme.mjs answer --concurrency 3
node eval/longmemeval/run-lme.mjs grade
node eval/longmemeval/run-lme.mjs report
node eval/traps-v2/classify.mjs "$LME_RUN" --verbose    # 不调模型：B / C 笔记里到底有什么
```

`LME_EXTRACT_EVERY_TURNS=N`（`run-lme.mjs` 的 opt-in，写进 `build.json` 的 `B.extractEveryTurns`）：每个 session 里，第 k 次提取只能看到到第 k 组 N 个用户回合结束为止的事件（含助手对第 N 个回合的回复，即下一条用户消息之前；`makeHost` 的 `visibleSeq` 限制 `sessionQuery.readSession/listEvents`），每组只跑一次 `runAutoExtract`（和线上一样只读第一块、积压留给下一次），最后再跑一次收尾（线上其实不会有这一次，略偏向 B）。不设时按 v1 的老办法：整个 session 一窗接一窗读完。**两种设置的结果不可混比**；报告应写明用的是哪种。

`classify.mjs` 对每题读 `checkpoint-before-dream`（B）与 `checkpoint-after-dream`（C）的笔记，只看“当前文本”（`STATUS` 为 stale / superseded 等的页面，以及 `## History` 之后和 `- Superseded:` 行都排除，直接用 `src/memory-body.js`），分成 `missing` / `stale` / `partial` / `complete`（弃答题为 `clean` / `invented`），并并入 `grades.json` 的 A / B / C 标签，输出逐题表、按机制汇总，以及“Dream 修好了 / B 从没有 / 旧笔记留存 / Dream 改坏了 / 笔记对但答错（召回或回答问题）”这几组。它是字符串启发式（带“作废、取消、原来、仍……”等撤回措辞的行不算在断言旧值），异常的行请直接看笔记。

## 冻结规则

- 题目在任何一次运行之前定稿；看到结果后不改题、不改参考答案、不改证据、不改 `b_hypothesis`。
- 要改就另存新文件（`traps-v3.json`），重新跑；旧结果不动。
- `traps.json` 由 `src/build.mjs` 从 `src/p1..p4.mjs` 生成，是产物；冻结后以 `traps.json` 的 sha256 为准（报告里的 sha256 必须等于 `validate.mjs` 打印的值）。

## 局限

- `b_hypothesis` 是假设，不是结论。一题没有失败只说明这次 B 没失败；模型换了、提示词改了，结论就变。
- 杂务 session 很短（几句话），历史总量只有约 1000 字符（两个同 session 的 `window-anaphora` 和两个带粘贴日志的除外，约 14000–16000 字符）：这比真实使用轻得多，索引也只有 10–15 条。粘贴日志是程序生成的，不含任何答案内容。
- 评判是 deepseek-flash + 官方 LongMemEval 提示词，不是 GPT-4o；多块答案（`fragmentation`）要求全部给出才算对，较严。题少（24），一题约 4 个百分点，只能看趋势和具体失败案例。
- 一类机制 3–4 题、`selection-standard` 只有 2 题，不能做机制间的统计比较。
- `classify.mjs` 是字符串匹配；`window-anaphora` 的 `stale_keys` 会把“原样保留旧决定”判成 stale，但把“新旧并存”也判成 stale，细节要看笔记。
- 历史是重放的：主代理在对话当时的实时写记忆没有模拟（auto-extract 在主代理自己写过那轮会跳过，这里不存在），B 线只反映 auto-extract。
- 弃答题只能检验“不编造”，不能保证 B 没记下任何未陈述的原因：用 `classify` 的 `invented` 看笔记里有没有。
