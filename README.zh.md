<div align="center">

<img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/icon.png" width="88" alt="">

# dsh-cc-dream-memory

**为 DeepSeek Harness 带来 Claude Code 式的自动记忆和 Dream。**

让 agent 跨会话记住事情。Dream 提出的每一处改动，你都能先审阅，也能撤销。

[![npm](https://img.shields.io/npm/v/dsh-cc-dream-memory)](https://www.npmjs.com/package/dsh-cc-dream-memory)
[![CI](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

[English](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/README.md) · 简体中文

</div>

## 装之前和装之后

告诉 agent 一件事，然后新建会话再问。同一个项目、同一个模型、同一个问题，唯一的区别是有没有装插件。

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/before-after.png" width="860" alt="同一个请求的两份回答。不装插件时，回答用了标题，并让你运行已废弃的 legacy-deploy.sh。装了插件，回答先写结论和风险，并让你运行 make release。">
  <br>
  <sub>图里是英文会话和英文界面，插件界面也有中文。</sub>
</p>

不装插件时，agent 回了一句 “Both noted”（都记下了），还保证不再推荐旧脚本，到了下一个会话却推荐了它。装了插件，它自己存了两条记忆，下一个会话直接用上。

第二个会话两边各跑了 3 次。不装插件时，3 次的部署步骤都是 `legacy-deploy.sh`；装了插件，3 次都是 `make release`。图里是各自的第一次运行。项目是虚构的，它的 README 有意保留了旧脚本。这只是一个例子，不是评测，详见[现状](#现状)。

用中文再跑一轮：不装插件时，3 次都没给出 `make release`（1 次让你跑旧脚本，2 次说仓库里没有可用的部署方式）；装了插件，3 次都是 `make release`。

## 安装

**GitHub v0.20.0** 可用下方指定 GitHub 标签的命令安装。npm 命令安装的是 npm 上已发布的版本。

需要 Node 22 或更新版本，以及 DeepSeek Harness 0.2.2-rc.1 或更新版本。

```bash
dsh plugin --profile web add dsh-cc-dream-memory
```

重启 DeepSeek Harness，新建一个会话。如果 PATH 上没有 `dsh`，用 `npx`：

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-cc-dream-memory
```

桌面版可以打开**插件 → 添加插件**，输入 `dsh-cc-dream-memory`。

也可以直接从 GitHub 安装：

```bash
dsh plugin --profile web add github:muuuuuuuuuer/dsh-cc-dream-memory#v0.20.0
```

## Dream

记忆会过时。这个例子里，三个会话改变了事实，五条旧记忆却没有跟上。Dream 读完这些会话后提出了六处改动，这次全部应用了。

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/dream-before-after.png" width="860" alt="Dream 前后的记忆列表。之前五条，有两条重复，部署和冻结信息已过时。之后四条，重复项已合并，信息已更正，并加入了交接格式。">
</p>

截图展示的是旧版界面。当前 Dream 生成一份副本，审阅后可切换或丢弃，一条命令就能撤销切换。

## 界面

每个会话的“对话”旁边都有一个**记忆**标签，状态栏会显示这个项目有多少条记忆。

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/memory-tab.png" width="860" alt="打开记忆标签的 DeepSeek Harness，列出四条记忆，带搜索、类型筛选和新建按钮">
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/dream-plan.png" alt="Dream 方案，列出六项可勾选的改动，其中一项展开显示新内容">
      <br>
      <b>Dream。</b>审阅副本中的改动，再决定是否切换。
    </td>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/settings.png" alt="设置页，有记忆和自动 Dream 的开关，以及可编辑的记忆规则">
      <br>
      <b>设置。</b>记忆和自动 Dream 的开关，以及哪些内容值得保存的规则。
    </td>
  </tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/memory-light.png" width="680" alt="浅色主题下的记忆列表">
  <br>
  <sub>界面跟随宿主的深浅色主题。所有截图都来自真实的 DeepSeek Harness，项目是虚构的。</sub>
</p>

## 为什么选它

**记忆能带过来。** 记忆是纯 Markdown，目录结构和 Claude Code 兼容：一个 `MEMORY.md` 索引，加上每个主题一个文件。已有 Claude Code 记忆的话，用 `/memory import` 就能导入。每个文件都能直接用编辑器打开。

**Dream 给出来源。** Dream 分块读取会话，每条新事实都须引用对话原文。被推翻的旧值留在笔记历史中。

**切换后仍可撤销。** Dream 先生成副本，切换时备份当前记忆。自动 Dream 默认关闭。

## 上手

下面的命令都在会话里运行。

1. 告诉 agent 值得记住的事，或者自己保存一条：

   ```text
   /remember --type=project Release notes live in docs/releases.md
   ```

2. 新建一个会话。模型收到一份 `MEMORY.md` 开头的快照，默认最多 200 行或 25 KB。会话压缩、配置或规则变更、`/memory refresh` 会重建快照。每轮由模型选择相关记忆，其他主题按需读取。

3. 启动后台 Dream。命令返回运行 ID，Dream 把结果写入副本。

   ```text
   /memory dream run
   /memory dream status <runId>
   ```

   长会话按顺序分块分析。`/memory dream cancel` 停止运行并保留已完成的分块，`/memory dream resume` 继续未完成的部分。`/memory dream run --wait` 等待运行结束。

4. 审阅后切换到副本，需要时可以撤销。

   ```text
   /memory dream switch
   /memory dream undo
   ```

第 3、4 步也可以在记忆页的 **Dream** 标签里完成。其他命令见[命令参考](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md)（英文）或[使用手册](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/manual.zh.md)。

## 从 Claude Code 迁移

```text
/memory import ~/.claude/projects/<你的项目>
```

导入时会读取 `MEMORY.md` 和主题文件，保留 `name`、`description`、`type`。已存在的文件会跳过，密钥扫描照常生效。`/memory export <路径>` 可以按同样的结构导出。

和 Claude Code 的不同之处：

| | 本插件 |
|---|---|
| 整理方式 | 插件校验并生成副本，支持切换、丢弃和撤销 |
| Dream 写入的新事实 | 必须引用会话原文 |
| 自动 Dream | 默认关闭 |
| 召回 | 模型根据笔记元数据选择候选 |
| 子代理 | 默认不注入记忆 |

## 适合你吗

如果你想看清并修正 agent 记住的内容，并且长期在同一批项目上工作，它比较合适。

这些情况可以看看别的插件：

- **需要向量检索或托管的记忆服务。** 本插件都没有。模型按笔记元数据选择候选，可能漏召回。`@openviking/dsh-memory-plugin`、`@honcho-ai/dsh-honcho` 和 `dsh-tdai-memory` 走的是其他路线。
- **每次写入都要审批。** Inbox 提供自动抽取的提案审阅，普通记忆写入直接经过写入策略。

## 你的数据

- 记忆保存在你自己的机器上，位于 `$DSH_HOME/cc-memory/`。插件没有遥测。
- 记忆内容会随正常提示词发给你的模型服务。
- Dream 会把会话文本和记忆发给你配置的模型服务。虚构的三个短会话演示用了 6,500 到 11,000 tokens；一次真实项目批次记录为 **149,984 总 tokens、约 263 秒**，随后应用了两次记忆写入和一次索引更新。两者工作量不同，不能当作典型成本。见[脱敏汇总](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/REAL-WORKSPACE-OBSERVATIONS-2026-11-09.md)。
- 运行 Dream 会调用模型。启动前可用 `/memory dream estimate`，或查看界面启动 Dream 时显示的输入估算；单独估算不调用模型。实际总用量可能高于粗略输入估算。`dreamMaxTotalTokens: 0` 表示不限；需要成本保护时，请配置明确的预算和 `dreamCostMode: block`。
- 符合常见密钥格式的写入会被拒绝。这是启发式检查，不能保证拦住所有密钥。详见 [SECURITY.md](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md)。

## 现状

**这是实验性插件，它到底有多大帮助，我们还不知道。** DeepSeek Harness 本身也是预览版，插件 API 可能变化。

已经验证的：

- 测试在 Windows 和 Ubuntu、Node 22 和 24 上运行。
- 打包后的插件安装到了 DeepSeek Harness 0.2.2-rc.1 的干净 profile，并用真实模型和虚构会话跑完了一轮 Dream：生成方案、预览、选择性应用、撤销。

还没有验证的：

- **记忆总体上能不能让回答变好。** 开头的对比只是为了展示差别而设计的一个场景。在一次[小型试点](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/RELIABILITY-REPORT-2026-11-08.md)里，记忆对稳定偏好有帮助；“只写一段话”的指令上，有无记忆都没通过；用户纠正那一项的结果我们并不信任。那次 Dream 没有做任何改动，所以说明不了 Dream 的效果。
- **在真实项目上长期使用。** 我们正需要这方面的反馈。如果你在真实工作中用了 Dream，请[告诉我们它哪里对、哪里错](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/issues/new?template=feedback.yml)。

已知局限：

- 引用只能证明这段话确实在会话里，不能证明由它得出的结论是对的，所以方案还是要看一眼。
- 区分亲手输入和粘贴内容靠启发式判断，短粘贴识别不出来。
- 界面只有英文和中文。

## 更多

- [使用手册](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/manual.zh.md)和[架构说明](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/ARCHITECTURE.md)
- [评测方法](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/README.md)
- [命令参考](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md)（英文）
- [贡献指南](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CONTRIBUTING.md) · [安全](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md) · [更新日志](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CHANGELOG.md)

## 贡献者

- [muuuuuuuuuer](https://github.com/muuuuuuuuuer) — 维护者。
- [Claude](https://github.com/claude) — 通过 Claude Code 提供 AI 编码协助。

## 致谢

开发过程中也使用了 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

## 许可证

[MIT](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

这是独立的社区插件，与 Anthropic、DeepSeek 无关，也未获其认可。Claude Code 是 Anthropic 的产品。
