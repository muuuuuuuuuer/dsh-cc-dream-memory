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
