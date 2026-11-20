# DSH 宿主实测 · 0.22.1

2026-11-18，在 Windows 安装的 DSH 0.2.2-rc.3 中运行提交 `f4eaa6c`，模型为 DeepSeek Flash。使用独立 DSH_HOME、评测 profile、合成笔记和新会话。本机旧评测 profile 实际链接 0.12.0，临时 profile 重新链接当前 checkout 后通过来源预检。此次覆盖 headless 的真实模型、工具、会话和磁盘路径，桌面窗口交互未测。 [DSH headless 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)

## 长页召回遗漏中文例外

在一份笔记开头放入约 4,800 字符的背景，在下一节写入以下内容。对照页仅将 `例外：` 改成 `Exception: `。

```text
## Procedure
For EALIAS in shared mode run amber-bolt-76.

例外：On shared resolvers use violet-fan-93 instead.
```

附加预算设为 620 字符，选择器超时设为 12 秒。每次在新会话询问 “EALIAS in shared mode on a shared resolver: which command? Reply with the command only. No tools.”。要求本轮不用工具，是为了单独测自动附加。

| 例外标签 | 原版插件，两次独立会话 | 额外记录实际附加文本的一次诊断运行 |
|---|---|---|
| 英文 | 两次均返回 violet-fan-93 | 正文和例外均在附加消息内，回答正确 |
| 中文 | 一次拒绝给命令，一次给出基础命令 amber-bolt-76 | 只附加基础命令和全文读取提示，回答为 amber-bolt-76 |

诊断副本只增加日志。两份笔记均被选择，命中的都是 Procedure 节同一行。差异发生在 `src/recall.js` 的 `matchedPassage`，它在空行后用只列英文标签的 `CAVEAT_LINE` 决定是否继续附加。早期探索中也出现过只附加全文读取提示的 UNKNOWN，故没有用 UNKNOWN 或读取中的计数器推断选择器是否运行。

## 代码示例中的标题截断当前正文

关闭自动召回，要求 agent 调用 `memory_read` 打开同一文件名，返回 NIXEL 当前发布标识。两份正文只有示例标题一词不同。

~~~~markdown
How the generated document looks:
```markdown
## History
A generated heading example.
```

## Active configuration
The NIXEL release identifier is TORCH-8746.
~~~~

实验页返回 `ok: true` 和文件大小 230 字节，但工具返回的 body 只到开头的代码围栏。模型又调用了两次 `memory_search`，最后回答 UNKNOWN。对照把代码块中的 History 换成 Timeline，模型一次读取就答出 TORCH-8746。磁盘原文在两次实验中均完整。`src/memory-body.js` 的 `currentBody` 逐行遇到 History 标题就结束，未跟踪围栏。 [CommonMark 围栏代码块规范](https://spec.commonmark.org/0.31.2/#fenced-code-blocks)

## 跨会话纠正与评测脚本

运行 `node eval/run.mjs --only dev-02-correction --runs 1 --no-judge --keep`。历史会话先要求详细回答，后纠正为简洁。无记忆 A 和空库 B0 未通过格式判定，保存历史的 B 和执行 Dream 的 C 均通过。此次只看确定性判定，四组的语义评分均为空。另发现两处会影响实验解释的具体问题。

- 该宿主已通过 profile 选定 headless。脚本额外传入位置参数 `headless`。诊断记录的实际用户消息以 `headless EALIAS` 开头，删去该参数后相同消息以 `EALIAS` 开头。跨会话场景的原始提示里没有该词，而实际保存的偏好被限定为 “In headless runs”。 [官方 CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- Dream 返回 `ready: true`、`applied: false`、2 个操作和 1 个改动文件。runner 随后拍摄 C 组快照。前后正式笔记 SHA-256 均为 `241BF877B601633BAC0FDD7F5B7B6E150A6AC664EE204E236A0AAE662B9B5CFD`，索引均为 `4BD19F929A33158B6E1FB27D534B8E2ABA3414B628DD57E1BF8AC073468DC4B5`。本次 C 的回答使用了应用草稿之前的正式笔记，因此无法衡量这份草稿的效果。

## 修复后复测

- **真实 headless 会话**。修复后，中文例外场景答出 `violet-fan-93`。围栏场景一次 `memory_read` 就取得 `TORCH-8746`。回归还覆盖围栏里的 `STATUS`、`Superseded` 和代码示例标题对事实归属的影响。
- **Windows 原生窗口**。用隔离的 Desktop profile 启动 DSH，发送真实模型消息。在记忆面板新建了一份包含围栏标题的笔记，用 `NIXEL` 搜到并编辑摘要，确认代码块后的值仍显示。随后从 Dream 面板估算、启动、展开差异、接受并应用 1 项改动。完成二次确认后，界面显示「已撤销」。正式笔记与 `MEMORY.md` 的 SHA-256 都与应用前备份一致。
- **评测 C 组**。纠正场景和会话整理场景的真实 Dream 均提出草稿，但应用都被证据检查拒绝。会话整理场景读取 3 个会话，完整复查为 0，错误为 `evidence-required`。修复后的脚本将 C 标记为不可比较，保留结构化失败结果。
- **桌面新发现**。手动保存的笔记显示「Dream 用来源对话逐字核对」。这条记录实际来自用户编辑，提示语误报了核实来源。
- **自动校验**。`npm run verify` 通过 75 个测试文件、612 项断言。评测资产校验通过。

## 0.23.0 复测

在隔离的 DSH 0.2.2-rc.3 headless 配置中，用 DeepSeek Flash 各运行了一次带明确整理目标的用例。两个批次都通过正常的证据检查完成应用，每批复查 1/1 个会话。随后用独立新会话读取记忆。

| 用例 | 已应用的改动 | 新会话结果 | Dream 总 token |
|---|---|---|---:|
| 中文会话 | 原句写入代号 SABLE-873 | SABLE-873 | 18,881 |
| 发布命令纠正 | 默认命令改为 pnpm release，保留 staging 的 npm release | 两个命令及其适用范围均正确 | 46,070 |

开放整理的 `dev-09-dream-session` 和 `dev-02-correction` 仍产生过带未支持标题、解释或改写的草稿。证据检查拒绝应用，这两次 C 组不可比较。上述两个成功用例用于验证基于证据的落盘链路。条件交换和跨句拼接的拒绝路径另有自动回归覆盖。

## 0.24.0 桌面实测

2026-11-18，Windows 上的 DSH 0.2.2-rc.3 桌面版，隔离的 DSH_HOME 和窗口配置，profile 只启用 base、web-app 和本插件，模型为 DeepSeek-V4.1-Flash。测试仓库只有 `src/server.js`（含 `DEV_PORT = 4317`）。预置三条项目笔记和一条用户层笔记（要求回答以 FIELDOK 结尾）。

- **用户层**。新会话问开发端口，回答「4317（定义在 src/server.js）FIELDOK」。用户层索引注入生效。端口来自索引简介，选择器没有附加笔记，metrics 召回次数为 0，符合 0.23.1 的选择规则。
- **召回行**。答案只在正文里的发布检查清单问题答对了（`npm run smoke -- --region=eu-west-3 --keep=7`），会话日志里有对应的 `plugin:cc-memory-recall` 消息，但聊天里看不到召回行。用控制台诊断确认：定义注册、匹配、构建和渲染都执行了，渲染出的行在已完成轮次的过程折叠组里，带 `hidden`。原因是节点没有声明 `groupTree`，Chat 把 Step 级节点收进过程组。给节点加 `groupTree: 'turn'` 后，行显示在回答上方：「已召回 1 条记忆: project_release_checklist.md」，展开可见正文。点「不相关」后按钮变为「已标记为不相关」，metrics 记录 `dismissed: 1`，对应笔记 `dismissals: 1`。
- **会话开关**。`/memory session status` 输出两个开关。在新会话先执行 `/memory session use off`，状态文件记录 `use: false`；同一会话问端口，回答「不知道」，没有 FIELDOK。
- **记忆面板**。深色主题下列表和标签显示正常。面板标题显示 `default-workspace`，原因是测试 profile 固定了 `projectId`，所有工作区共用一个项目；未在默认配置下复查。
- **未测**。出处失效笔记的 `memory_read` 提示、自动 Dream 的焦点清单和 `learn off` 只有自动测试覆盖，本次没有在窗口里触发。

## 0.25.0 桌面实测

2026-11-18，同一个隔离的 DSH 0.2.2-rc.3 桌面实例，去掉了测试 profile 固定的 `projectId`，记忆面板因此按工作区区分（标题为 `dsh-0240-fixture`）。该工作区有 0.24.0 实测留下的两个对话。模型为 DeepSeek-V4.1-Flash。

- **任务列表**。Dream 页显示「本工作区的 Dream 任务」：进度条、按状态计数、全部/未整理/已整理筛选和对话列表。行标题起初只显示「对话 session-」，因为会话列表记录里没有标题；改为读宿主 `sessionQuery.readTitleSnapshots` 后显示对话标题。
- **子智能体 Dream**。估算后开始，标题栏显示子智能体数从 1 变为 2，两个 `standard` 预设子智能体依次完成，结构化输出被宿主接受（`done:true` 和改动列表），两个会话均检查点。子会话日志里有插件写入的 `sandbox/mode: workspace-write`（另一条来自父会话继承）和 `approval/policy: never`；子智能体读了仓库文件，只用 write/edit 写影子副本。用量从子会话的 `assistant/message` 读出：输入 22,342，输出 9,106，缓存读取 261,376，合计 292,824 token。原先的估算 30,000 偏低约十倍，已按实测改为每个任务约 140k token。
- **证据**。第一次任务说明没有要求照抄原句，子智能体用英文改写事实，3 处改动全部「没有可核对的来源」。加上「每个事实照抄来源原句、原语言、一行一句」和 `<type>_<topic>.md` 命名后重跑，`project_dev_server_port.md` 和 `project_release_smoke.md` 通过证据检查，`feedback_direct_answers.md` 仍无来源。
- **部分切换**。应用通过的两项后，两个对话都回到「未整理」：未绑定证据的暂缓改动会让整轮的会话都保持未审阅。现在待审副本记录每个文件来自哪个会话的任务，部分切换只保留暂缓改动所属的会话；这一点有自动测试，窗口里没有再现同样的组合。之后再跑一轮，子智能体复查两个对话后没有改动（约 113,597 token），任务列表变为「已整理 2」。截图见 `eval/dream-tasks-0250.jpg`。
- **未测**。`dreamYieldToSubagents` 的等待、宿主并发名额满时的重试、子智能体中途失败后的续跑，只有自动测试覆盖。

### 0.25.0 修正后复测

用户在真实项目里跑 Dream 时，一个子智能体（Dream 1/4）用了 2.6M token、40 步、约 8 分钟：它自己解压会话日志、读插件源码和状态文件、研究复查规则；来源文件 1000 行，含工具结果原文。另有三处问题：用户在宿主里暂停子智能体后 Dream 卡住；插件为子智能体的工作目录（影子副本路径）建了一个空的记忆项目，子会话的记忆页一直在加载；仓库里 `eval/runs/` 下的旧评测会话被当成项目会话挑进 Dream。

修正：子智能体只留 read/write/edit/glob/grep，来源文件只保留对话，任务说明限定读写范围；子回合结束 15 秒仍无结果按中断处理；记忆根目录下的会话不建项目；git 忽略目录里的会话不进 Dream。在隔离实例里用新对话（一句交接文档格式偏好）复测：4 步，调用只有 read、glob、write、structured_output，21,248 token，9.7 秒；第二次 30,504 token，15.8 秒。来源文件 9 行。

复测还发现主对话保存记忆时把 `feedback_handover_doc_format` 存成 `feedback_feedback_handover_doc_format.md`（类型前缀重复），已修正。Dream 子智能体把这条笔记改成用户原句，去掉的 Why/How 行没有来源，审阅时需要人工确认，符合证据规则。
