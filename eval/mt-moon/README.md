# Mt. Moon 回归用例

名字来自一个 agent：它写下一条错笔记，之后一直信它，只有回头重读原始 transcript 才纠正过来。这里的用例就是：**记忆里已经有一条错笔记，源会话里写着真相，Dream 必须能据 transcript 改对。**

（共 11 个，下表按加入顺序。）

这是行为测试（做对了没有），不是 A/B 收益对比；每个用例单独判 pass / fail。

## 用例

数据在 [cases.json](cases.json)，两层共用同一份数据与同一个评分函数（[lib.mjs](lib.mjs)）。

| 用例 | 错笔记 | 源会话里实际发生的 | 触发 Dream 看它的方式 |
|---|---|---|---|
| wrong-fact | 部署 region 是 us-east-1 | 用户说 region 是 eu-central-1，us-east-1 已下线（会话里还有一条宿主注入的召回事件，重复了错值） | 会话未审阅，笔记 `source_session` 指向它 |
| env-exception | 发版统一用 `make release` | 生产用 `make release`，staging 仍用 `./scripts/release-old.sh` | 会话已审阅过；用户纠正过该笔记 |
| one-off-as-default | 项目统一使用 npm | “这次先用 npm，平时还是 pnpm” | 会话未审阅 |
| pasted-as-decision | 用户已决定放弃 Postgres | 这句只出现在用户贴的同事报告里（`user-pasted`），用户自己说“我还没决定” | 会话已审阅过；用户在召回里把该笔记标为不相关 |
| control-correct-note | Node 22 / CI 22（正确） | 会话一致 | 无；笔记必须逐字节不变，且不能多出新笔记 |
| stale-by-later-session | 发布日期 下周五 (11-28)（来自第 1 个会话） | 之后的会话里用户说发布改到 12-05，没说原因：必须写 12-05、11-28 进 History、不得编造原因 | 第 1 个会话已审阅；第 2 个未审阅，笔记没有可疑信号，靠笔记列表和描述找到它 |
| assistant-claim-as-fact | 登录超时问题已修复（改了 token TTL） | 助手声称已修复，用户说“还是会超时”：不能再把“已修复”当现状；改正引用用户事件，助手引文被记为 `assistant` | 会话未审阅 |
| scope-overgeneralized | 项目统一用 2 空格缩进 | 只有前端 `web/` 用 2 空格，Python 服务用 4：两个范围都要写 | 会话未审阅 |
| negation-lost | 用户希望缩进使用 tabs | 用户说“不要用 tabs，用空格” | 会话未审阅 |
| contradicting-notes | 两条笔记：一条写 `npm test`，一条写 `pnpm test` | 用户裁决用 pnpm test：两条笔记合起来只能留一个现行值，旧值只在 History 或消失 | 会话未审阅，两条笔记都指向它 |
| hard-negative-control | deploy region 是 eu-central-1（正确） | 会话提到 us-east-1，但说的是另一个 billing 服务：该笔记必须逐字节不变。允许多出一条 billing 笔记（合理的跨服务参考），所以不要求 `noNewNotes`；要防的是误改 deploy 笔记 | 会话未审阅 |

期望结果同样是数据：`contains` / `notContains` 只看正文（`## History` 与 `- Superseded:` 行之外），`historyContains` 看旧值是否进了 History（软检查：模型整页重写也算改对，只报告不判 fail），`unchanged` 要求字节相同，`acrossFiles` 要求几条笔记合起来只剩一个现行值，`containsAny` 容许措辞变化，`allowDeleted` 容许模型删掉整条笔记。

## 两层

- **A 层，确定性，进 CI**：`test/dream-mt-moon.test.mjs`。真实的 DreamAgent 跑在播种好的 store/会话上，用脚本化的假子代理（行为像合格的模型：读被提供的会话、带引文提交修正、不静默跳过、对照组不动）。证明管线让一个正确的模型能改对：错笔记的源会话确实被提供（含已审阅会话的回看）、事件读得到、引文成立且角色正确（pasted 用例里，改正引用 `user` 事件，引用粘贴文本被记为 `user-pasted`）、旧值进 History、对照组不变；并断言子代理被告知的内容（提示里有被提供的会话、可疑笔记，以及笔记列表里的 `(from offered session <id>)`）。
- **B 层，真实模型**：`eval/mt-moon/run.mjs`（本文件说明的这个）。真实模型模式不在 CI 里跑。`test/mt-moon-run-smoke.test.mjs` 只跑它的 `--fake-model`。

## 运行（B 层）

与 [../longmemeval](../longmemeval/README.md) 同一种方式：进程内的 `MemoryRuntime` + `lme-lib.mjs` 的 `makeHost`，Dream 的子代理由真实模型（DeepSeek Messages API）通过插件自己的受限工具（`dream_read_session` / `dream_read_note` / `dream_submit` 与 `structured_output`）扮演。不需要 DSH profile、不需要 headless（headless 没有 agent presets，起不了 `standard` 子代理）。只需要环境变量 `DEEPSEEK_API_KEY`。

```powershell
# 无模型：脚本化“理想修正”应全部通过
node eval/mt-moon/run.mjs --fake-model
# 无模型：Dream 什么都不改，应该所有错笔记 fail、两个对照组 pass（证明评分能区分）
node eval/mt-moon/run.mjs --fake-model=noop

# 真实模型：先只跑一个
node eval/mt-moon/run.mjs --only wrong-fact
# 全部 11 个
node eval/mt-moon/run.mjs
```

每个用例各用独立的 memory root，流程：

1. 把 fixture 的会话原样作为宿主会话提供给 Dream（全部事件，包括宿主注入事件和粘贴块）。
2. 播种错笔记（`source_session` 指向这些会话）和 `.state.json`：已审阅的会话、被纠正过 / 被召回标为不相关的笔记。
3. 跑一次 Dream（`runtime.dream`，暂停则续跑），再用 `switchDream` 走正常切换路径把待审副本切进来。
4. 用同一份期望数据给笔记评分。

输出 `eval/runs/mt-moon-<时间戳>/report.json`（`EVAL_RUNS_DIR` 可改目录）：每个用例的 `pass`、逐项 `checks`、Dream 结果（ready / skipReason / 会话数 / usage）、子代理步数与用量（`children`）、引文证据与角色（`evidence`）、最终笔记全文（`notesAfter`）。Dream 报错、因非预期原因跳过（`nothing-new` 与 `incomplete-review` 是正常结果）、没有子代理运行、子代理出错或切换失败的用例标记 `validity: "invalid"`，不计入通过也不代表模型错了，进程以非零码退出。

## 成本

每个用例一个 Dream 子代理（读会话、读笔记、提交；通常 4–10 步，每步一次 Messages 请求，上下文随读到的会话增长），没有回放。11 个用例合计约 50–110 次请求；真实花费随会话长度变化，先用 `--only` 试一个。`--fake-model` 不调用任何模型，不产生费用。

## 局限

- 子代理由 lme-lib 里的轻量循环驱动：同一模型、同一组受限工具，但没有 DSH `standard` 预设自己的 persona 提示和文件工具。
- 单次运行只回答“这一次做对没有”，要看稳定性需要重复运行并自行汇总 `report.json`。
- 评分只看笔记正文的字面检查；措辞变化超出 `containsAny` 之外的正确改法会被判 fail，需要人工看 `notesAfter` 再决定是否放宽数据。
