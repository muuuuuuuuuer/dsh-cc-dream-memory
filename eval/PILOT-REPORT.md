# 同场景配对实验 · 流水线诊断记录（第一轮，已修正装置）

日期：2026-11-08
**状态：流水线诊断，不是效果结论。** 首轮运行暴露了 3 个装置问题；本文件记录问题、修复与一次干净的小验证。效果结论待用冻结后的装置重跑。

> 本文件是当时的记录，所用版本早于 0.11.0。之后 Dream 输入、证据检查和自动召回都变了，这里的观察不代表当前版本。

## 已确认的装置问题（首轮结果不得用于效果判断）

1. **[P0] A 组读到评估数据，隔离失效。** 原始工具轨迹显示 A 组读取了 `eval/scenarios.dev.json`（含历史事实、测试任务、rubric），dev-06 甚至能复述历史。独立 `memoryRoot` 只隔离插件存储，普通 `read`/shell 仍可越界。
   - 修复：eval profile 对每个会话生成 **tool lock patch**，禁用 15 个模型侧工具插件（fs/fs-search/pwsh/bash/skill/subagent/workflow/web/todo/goal/jobs 等），保留 4 个 memory 工具与 executor 基础设施；一次 headless 探针验证：可用工具仅 `memory_read/save/search/update`。
2. **[P1] C 的 Dream 结果被 B 检查点覆盖。** runner 在 Dream 后仍用同一个 "checkpoint" 恢复 B、C，导致测试时 C 实际等于 Dream 前的 B。
   - 修复：两个不可变快照 `checkpoint-before-dream`（B 测试）与 `checkpoint-after-dream`（C 测试）；每次测试前按组恢复并校验 `sha256`；记录 `restoredHashOk`。
3. **[P1] "当前指令优先" rubric 与任务不一致。** 变体任务只禁止分节/待办，rubric 却额外禁止"回滚步骤"，导致三组回答都提回滚时判定不稳定。
   - 修复：冻结 rubric v2（任务明确禁止待办/验证建议/回滚操作/下一步/执行状态推断），旧 v1 保留用于复现；对旧三组回答做匿名重评分（产物只在本地，不入库）。
4. **场景命名过宽**：dev-03 原 fixture 自带 PostgreSQL + 回滚要求，A 读文件即可完成，不能证明跨会话组合；现改为"事实只存在于历史"（fixture 清空），原能力作为对照另议。dev-04 实际测的是"同工作区两个项目约定的区分"，不是存储隔离，已在场景中标注 `capabilityNote`。
5. **口径统一**：首轮原始 `success` 为 A 3/7、B 4/7、C 3/7；报告曾用 judge 口径 A 4/7、B 6/7、C 5/7。两者现在分别命名（raw / judge），runner 报告同时保留；"69 次调用"应表述为 **69 次 headless 执行**（一次执行可能含多次模型请求），样本为"6 个历史场景、7 个查询用例、每组 1 次重复"。
6. **成本**：隔离修复前 A 组有大量越界搜索/读取，token 差异不能归因于记忆；需在干净装置下重新计费，并把保存/整理/查询分账。

## 运行门禁（0.10.7）

- tool 发现（dump-config）非零退出、EPERM/EACCES 或返回空列表 → 在首个模型请求前中止，不再生成无禁用项的 patch。
- 启动时校验 `frozen-manifest.json`（场景/rubric 哈希、插件版本、contract；当前 contract 见 `eval/harness-lib.mjs`）；不一致直接退出。
- 每个条件记录 `validity` / `failureKind`：snapshot 不符、Dream 结果缺失或 `sessionsReviewed≠0` → device-invalid，不参与比较；模型失败/超时按任务失败；judge 缺失/JSON 无效 → grading-missing，进入重评。
- 行为测试在 `test/eval-harness.test.mjs`（发现失败、manifest 过期、快照/Dream 失效、评分缺失、成功门槛），不是只检查源码字符串。

## 修复后的装置状态

- 工具隔离：每个会话禁用全部模型侧基础工具，只保留 memory 工具；探针通过。
- 内存快照：Dream 前/后两个批量快照，测试前按组恢复并校验哈希；`record.restoredHashOk`。
- Dream 纯度：eval-only 工具以 `noSessions: true` 调用，`runtime.dream` 不读取 transcript；记录 `sessionsReviewed`，非 0 直接记错误（本次 0）。
- 冻结资产：`eval/frozen-manifest.json`（场景/rubric 哈希、插件版本、target model/profile）；`eval/assert-harness.mjs` 无模型校验 27 项全 PASS。
- 评分：`eval/scenarios.dev.json` + 冻结 rubric v1/v2；旧评分保留在原始 `records.json`，重评分单独输出。

## 干净小验证（dev-01，n=1，仅验收装置，不作效果结论）

- 工具轨迹：测试会话只出现 `memory_read` / `memory_search`，无文件/ shell 工具。
- Dream：`applied=true`，`sessionsReviewed=0`；pre/post 哈希不同，C 测试前恢复 post 快照且哈希校验通过；本次 0 ops（记忆已完整）。
- 结果（judge）：默认用例 A FAIL / B PASS / C PASS；"当前指令优先"变体 A PASS / B FAIL / C FAIL。**失败分类仍需人工校准**：B 的回答只是写了"未加待办/回滚"的元说明，并非实际提供操作；C 是标题+列表的格式问题。judge 已新增 `formatViolation` / `providedForbiddenContent` 区分，但本批标签在重跑前只作线索。
- 旧三组变体回答在 v2 下匿名重评分：**A、B、C 均 FAIL**。但这只是"旧答案对 v2 新增约束的兼容性检查"——旧答案没有见过这些新增限制，不能据此断言模型违反了当时收到的指令；首轮负迁移结论已因污染与 rubric 歧义撤回，但也不需要用这份重评分来"证明"它不成立。

## 下一步（按此顺序）

1. 用冻结装置的 6 个场景重跑，每组 ≥3 次、条件顺序随机交错；先跑少量案例验证隔离/快照/判分，再全量。
2. 指标分三栏：`raw`（确定性+judge 门槛）、`deterministic`、`judge`；按"记忆任务 / 边界 / 信息不足"分组报告；成本按保存/整理/查询分账。
3. judge 增加证据工具（可读取产物与工具轨迹），并用第二个 judge 或人工抽检校准；当前 judge 仍与主模型同源。
4. 只在干净实验失败轨迹稳定复现后，再改"当前指令优先"的记忆注入策略。

产物：运行与重评分目录只在本地（`eval/runs/`、`eval/rescores/` 不入库）；`eval/frozen-manifest.json` 随仓库发布。
