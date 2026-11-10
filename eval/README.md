# 同场景配对实验（A/B/C）

目标：回答两个问题——**跨会话记忆有没有帮助**，以及 **Dream 是否带来额外收益**。正式结论前，先用开发场景校准评分与隔离，再扩大样本。

## 条件（配对，同一检查点派生）

| 组 | 配置 | 回答 |
|---|---|---|
| A：无记忆无工具 | 关闭注入与记忆工具；历史不保存 | 模型自身能完成多少 |
| B0：相同工具+空记忆 | 工具/注入同 B，但记忆为空 | 排除“工具可用性”影响 |
| B：保存+召回 | 正常自动保存、搜索、读取；关闭 Dream | B−A / B−B0 = 跨会话记忆收益 |
| C：整理后 | 从 **Dream 后**快照复制，测试 | C−B = Dream 的额外收益/损失 |

两轮：第一轮 C 只整理已有记忆（不挖掘历史）；第二轮允许完整 Dream（读相同历史材料）。

## 关键装置

- **隔离**：记忆场景用 tool lock（禁用 fs/pwsh 等模型侧基础工具，只留 memory 工具）；开放工具编码场景（`eval/scenarios.coding.dev.json`）使用系统临时目录下的独立 git 工作区，不暴露插件仓库/rubric，并运行 `node --test` + 测试文件哈希检查；`--plan` 也会先校验覆盖所有场景文件的 frozen manifest。
- **两个不可变快照**：`checkpoint-before-dream`（B 测试恢复）与 `checkpoint-after-dream`（C 测试恢复）；测试前校验 sha256，`restoredHashOk` 记录在结果中。
- **Dream**：记忆场景默认纯整理（`noSessions: true`，`sessionsReviewed=0`）；`eval/scenarios.dream-session.dev.json` 的 C 组用 `sessions:true`，并先清空 C 的记忆，所以写进去的内容只可能来自 transcript，要求 `sessionsReviewed>0`。
- **冻结资产**：`node eval/freeze.mjs` 写入 `eval/frozen-manifest.json`，覆盖**所有** `scenarios*.json`、rubric、插件版本与 contract；runner 在 `--plan` 之前校验，任何场景文件不一致即拒跑。
- **运行有效性**：每个条件记录 `validity`/`failureKind`。tool 发现失败、manifest 不匹配 → 拒跑；snapshot 哈希不符、Dream 结果缺失或 `sessionsReviewed≠0` → device-invalid，不参与比较；模型失败/超时 → task-failed；judge 缺失 → grading-missing（重评）。
- **行为测试**：`test/eval-harness.test.mjs` 验证上述失败路径；`eval/assert-harness.mjs` 只做无模型环境/资产校验。
- **评分**：`eval/scenarios.dev.json` 中每个用例带 deterministic + semantic rubric；judge 为独立 headless 会话，匿名、随机顺序、带已知历史与材料。旧评分保存在原始 `records.json`，不覆盖。

## 场景（6 个 + 1 变体）

稳定偏好（含"当前指令优先"变体 v2）、用户纠正、跨会话组合（事实只在历史里）、项目约定区分（同工作区两项目；存储隔离另测）、噪声与过期状态、信息不足。

dev-01 变体 rubric 有 v1（旧，有歧义，保留复现）与 v2（冻结、任务无歧义）。

另有两个开放工具场景文件：`scenarios.coding.dev.json`（普通编码；含只在历史里出现的 JSDoc 约定场景 dev-08，任务文本不提该约定；客观检查 `node --test` 退出码 + 测试文件哈希）与 `scenarios.dream-session.dev.json`（Dream 读 transcript 的 C 组）。

## 运行

前置：`DEEPSEEK_API_KEY`；已创建 `cc-memory-eval` headless profile 并 link 本插件。

无模型预检会读取评估 profile 的 `package.json` 和已安装包元数据，并核对包名、版本及真实目录。只安装同版本的其他 checkout、仍启用旧 `dsh-cc-memory` bundle、或没有正确 link，都拒绝通过。真实模型 runner 也在发现工具和调用模型前执行此检查；`--fake-model` 使用合成环境，不检查本机部署。

默认要求 profile 链接当前 checkout。若明确评估另一份已发布目录，可设置 `EVAL_PLUGIN_ROOT` 为该目录；输出的 `SOURCE` 行记录实际包版本和 canonical target。此变量不会改变 profile 的依赖，先用包管理器修正链接再预检。检查不输出完整配置或 API key。

```powershell
# 无模型：场景/泄漏/装置断言（27 项）+ 冻结 manifest 校验
node eval/validate.mjs
node eval/assert-harness.mjs

# 不调模型，完整跑一遍编排（--plan 不会走到这些路径；test/eval-run-smoke 也跑它）
node eval/run.mjs --fake-model --only dev-02-correction --runs 1

# 小验证（先只跑一个场景）
node eval/run.mjs --only dev-01-stable-preference --runs 1

# 冻结装置后的正式开发试点（每组至少重复 3 次；先小样本）
node eval/run.mjs --runs 3

# 开放工具编码场景与 Dream transcript 场景
node eval/run.mjs --scenario-file eval/scenarios.coding.dev.json --runs 1
node eval/run.mjs --scenario-file eval/scenarios.dream-session.dev.json --runs 1
```

输出（`EVAL_RUNS_DIR` 可改目录）：`eval/runs/<timestamp>/report.md`、`records.json`、每个场景的 snapshot 与测试回答。`eval/rescore.mjs --run <run>` 是"旧答案对 v2 约束的兼容性检查"，不能据此断言旧答案违反了当时指令。

## 指标（分开命名，不混用）

- `raw`：确定性检查 + judge 门槛（runner report 的"主指标"）。
- `deterministic`：仅确定性检查。
- `judge`：任务完成 ∧ 无边界失败 ∧ 无编造。
- 另报：沿用过时信息比例、无依据历史事实、项目串用/违反当前指令、Dream 后有效事实保留、成本（保存/整理/查询分账）。

调用次数写作 **headless 执行次数**（一次可能含多次模型请求）；样本描述写"历史场景数 / 查询用例数 / 每组重复次数"，不只写 n=1。

## 当前状态

- 首轮运行发现 A 污染、C 快照被覆盖、变体 rubric 有歧义，均已修复；首轮数据只保留为装置诊断，不作效果结论。
- 干净 dev-01 小验证：工具隔离生效、Dream `sessionsReviewed=0`、pre/post 快照恢复校验通过；失败标签（格式 vs 内容）仍需人工校准，见 `eval/PILOT-REPORT.md`。
- 0.11.1 统一模型写入边界，补强逐行引文与自动审阅。合成场景真实模型试点记录在 [RELIABILITY-REPORT-2026-11-08.md](RELIABILITY-REPORT-2026-11-08.md)；小样本只用于诊断，`--fake-model` 仍只证明编排能走通。
- 下一步：用冻结装置跑 6 场景 × ≥3 次，必要时加第二个 judge / 人工抽检，再决定是否改记忆策略。
