<div align="center">

# dsh-cc-dream-memory

**为 DeepSeek Harness 带来 Claude Code 式的自动记忆和 Dream。**

让 agent 跨会话记住事情。Dream 提出的每一处改动，你都能先审阅，也能撤销。

[![npm](https://img.shields.io/npm/v/dsh-cc-dream-memory)](https://www.npmjs.com/package/dsh-cc-dream-memory)
[![CI](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

[English](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/README.md) · 简体中文

</div>

## 测试结果

### LongMemEval-S，30 题

每道题附带约 50 场历史会话。三组用同一个模型（`deepseek-flash`）回答同一批问题，每题都在全新的无界面 DeepSeek Harness 会话中进行，关闭 shell、文件、网页和子代理工具：

- **A**：不启用插件。
- **B**：插件的自动抽取逐场读取历史并写笔记。
- **C**：在 B 的笔记基础上，再对同一批历史运行 Dream。

| 分组 | 题数 | A 无插件 | B 记忆 | C 记忆 + Dream |
|---|---:|---:|---:|---:|
| **全部** | 30 | 8/30 (27%) | **26/30 (87%)** | 25/30 (83%) |
| 知识更新 | 10 | 0/10 | **10/10** | 9/10 |
| 跨会话 | 10 | 0/10 | **9/10** | **9/10** |
| 拒答 | 10 | **8/10** | 7/10 | 7/10 |

结论：

- **提升来自记忆。** 不装插件时 agent 看不到以前的会话，知识更新和跨会话的 20 题一题没答对；有了记忆，答对 19 题。
- **Dream 在这里没有提高准确率。** C 比 B 多对 1 题、多错 2 题。Dream 提出的 1,137 处改动中，证据检查暂缓了 1,001 处（88%）。
- **有记忆时拒答略差。** 不装插件的 agent 更常正确地回答“不知道”，因为它没有可以误读的笔记。

局限：这是固定的 30 题诊断样本（每组 10 题），不是完整的 500 题。评分用 DeepSeek 加官方 LongMemEval 判分提示词，不是官方的 GPT-4o 评委。本次运行使用 0.25.0 的代码。0.26.0 改了 Dream 挑选和编辑笔记的方式，之后没有重跑这 30 题。[实验设置与样本](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/longmemeval/README.md)（英文） · [Dream 的时间花在哪里](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/longmemeval/DREAM-SELECTION.zh.md)

### 召回，合成用例

六个合成召回场景，每个版本各跑两次，经插件的召回钩子调用 DeepSeek Flash：

| 版本 | 附加了预期笔记 | 回答正确 |
|---|---:|---:|
| 0.21.0 | 2/12 | 6/12 |
| 0.22.1 | 12/12 | 12/12 |

0.23.1 用七个问题各跑两次复查：无关消息带入的笔记从 11 篇降到 2 篇，目标笔记仍全部选中。[配对验证](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/RECALL-0.22.0.md) · [回放脚本](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/recall-passages.mjs)

### 测试套件

`npm run verify` 在 80 个测试文件中通过 702 条断言。CI 在 Windows 和 Ubuntu 上用 Node 22 与 24 运行。

## 安装

需要 Node 22 或更新版本，以及 DeepSeek Harness 0.2.2-rc.1 或更新版本。

npm 上目前仍是 0.12.0，请从 GitHub 安装当前版本：

```bash
dsh plugin --profile web add github:muuuuuuuuuer/dsh-cc-dream-memory#v0.26.0
```

如果 `dsh` 不在 PATH 中，用 `npx`：

```bash
npx @deepseek-ai/dsh plugin --profile web add github:muuuuuuuuuer/dsh-cc-dream-memory#v0.26.0
```

重启 DeepSeek Harness，然后新建会话。

## 上手

下面的命令都在会话里运行。

1. 告诉 agent 值得记住的事，或者自己保存一条：

   ```text
   /remember --type=project Release notes live in docs/releases.md
   ```

2. 新建一个会话。agent 能看到 `MEMORY.md` 的开头，召回会附加与当前消息相关的笔记，其他笔记 agent 可以按需读取。

3. 过几个会话后，启动后台 Dream 并查看进度：

   ```text
   /memory dream run
   /memory dream status <runId>
   ```

4. 在 **Dream** 标签里审阅结果，然后切换。改主意了可以撤销：

   ```text
   /memory dream switch
   /memory dream undo
   ```

其他命令见[命令参考](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md)（英文）或[使用手册](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/manual.zh.md)。

## 工作方式

**记忆。** 笔记是纯 Markdown，目录结构和 Claude Code 兼容：一个 `MEMORY.md` 索引，加上每个主题一个文件，类型为 `user`、`feedback`、`project` 或 `reference`。每个文件都能自己打开和修改。聊天旁边有一个 **记忆** 标签，跟随宿主的明暗主题，界面有中英文。

**自动抽取。** 默认开启。每 3 轮只读取对话中新增的部分，通过 agent 自己用的同一个工具保存值得留下的内容。纠正会修改已有笔记中对应的段落，而不是新建一篇。每次写入都经过重复、冲突和密钥检查。

**召回。** 按标题、简介和笔记正文生成候选，每轮调用一次模型挑选，默认最多附加 3 篇。长笔记只附加命中的段落，连同标题和适用条件。聊天里会显示附加了哪些笔记，每篇都有“不相关”按钮。

**Dream。** Dream 根据过去的会话整理笔记。它作为宿主子代理运行，读取尚未复查的会话，把改动写进单独的副本。每条新事实都必须引用来源会话的原文，没有通过核验的改动会被暂缓。切换之前你的笔记不会变；切换时先备份当前笔记，撤销会恢复它们。自动 Dream 默认关闭。开启后只在有明确目标时运行：你纠正过的笔记、来源文件有变的笔记、被召回的笔记，最后是归档候选。

## 从 Claude Code 迁移

```text
/memory import ~/.claude/projects/<你的项目>
```

导入时会读取 `MEMORY.md` 和主题文件，保留 `name`、`description`、`type`。已存在的文件会跳过，密钥扫描照常生效。`/memory export <路径>` 可以按同样的结构导出。

和 Claude Code 的不同之处：

| | 本插件 |
|---|---|
| 整理方式 | 先审阅副本，再切换或丢弃，带备份和撤销 |
| Dream 写入的新事实 | 必须引用会话原文 |
| 召回 | 每轮一次模型调用挑选笔记，聊天里显示附加了什么 |
| 来源 | 笔记可以列出它依赖的仓库文件；来源已失效的笔记不再被召回 |
| 用户记忆 | `user` 类型笔记由本机所有项目共享，其余仍按项目保存 |
| 单个对话 | `/memory session use off` 不加载记忆；`/memory session learn off` 让该对话不参与自动抽取和 Dream |
| 子代理 | 默认不带记忆（`subagentMemory: off`），可选 `shared` 或按代理分目录的 `own` |

## 适合你吗

如果你想看清并修正 agent 记住的内容，并且长期在同一批项目上工作，它比较合适。

这些情况可以看看别的插件：

- **需要向量检索或托管的记忆服务。** 本插件使用本地 Markdown 和词法排序，问题与笔记措辞差异较大时可能漏召回。`@openviking/dsh-memory-plugin`、`@honcho-ai/dsh-honcho` 和 `dsh-tdai-memory` 走的是其他路线。
- **每次写入都要审批。** 自动抽取和普通保存一样直接写入，只有 Dream 的结果会等你审阅。

## 你的数据与成本

- 记忆保存在你自己的机器上，位于 `$DSH_HOME/cc-memory/`。插件没有遥测。
- 召回模型会收到候选简介和短片段。选中的笔记会作为上下文发给模型服务。
- Dream 会把会话文本和笔记发给你配置的模型服务，开销不小。在 LongMemEval 运行中，对约 50 场会话建立记忆并运行 Dream，每题约用 680 万输入 token，其中 93% 是缓存读取。`/memory dream estimate` 可以在运行前给出粗略估计，`/memory dream cancel <runId>` 可以停止运行。
- 符合常见密钥格式的写入会被拒绝。这是启发式检查，不能保证拦住所有密钥。详见 [SECURITY.md](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md)。

## 现状

**实验性。** DeepSeek Harness 本身还是预览版，插件 API 可能变化。

- 上面的 LongMemEval 数字来自 30 题样本，Dream 在其中还没有表现出准确率提升。
- 0.26.0 的 Dream 改动经过回放和定向用例检查，没有在完整样本上重跑。
- 我们需要真实项目上长期使用的反馈。如果你试用了，欢迎[告诉我们它做对和做错了什么](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/issues/new?template=feedback.yml)。

已知局限：

- 引用只能证明会话里有这些话，不能证明从中得出的结论正确，所以切换前请审阅 Dream 的结果。
- 区分你亲手输入的文字和粘贴的文字靠启发式判断，较短的粘贴会漏过。

## 更多

- [命令参考](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md)（英文） · [更新日志](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CHANGELOG.md)
- [使用手册](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/manual.zh.md) · [架构说明](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/ARCHITECTURE.md)
- [评测怎么做](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/README.md)
- [参与贡献](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CONTRIBUTING.md) · [安全](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md)

## 贡献者

- [muuuuuuuuuer](https://github.com/muuuuuuuuuer) — 维护者。
- [Claude](https://github.com/claude) — 通过 Claude Code 提供 AI 编码协助。

## 致谢

开发过程中也使用了 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

## 许可证

[MIT](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

这是一个独立的社区插件，与 Anthropic 或 DeepSeek 无关，也未获其认可。Claude Code 是 Anthropic 的产品。
