# DSH 插件开发前提知识

这些参考文档取自 DSH `0.2.2-rc.3`。本机更新到 `0.2.2-rc.5` 后，已从安装包逐篇比对，11 篇正文一致。原始位置在 Desktop 的 `app.asar` 内：

```text
C:\Users\16864\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\dsh-doc\references\
```

`app.asar` 不能被普通编辑器或 `ls/cat/grep` 直接打开，所以把核心文档复制到了这个目录。原始来源是 `dsh-doc` skill 的 reference 目录；更新 DSH 后应以安装目录里的版本为准。

## 建议阅读顺序

1. **`plugin-development.md`** — 插件就是一个 bundle：从工作区写包、安装、启用、调试的完整流程。先读这个。
2. **`host-plugin.md`** — `package.json` 的 `dsh` 清单、Host 导出、Config、locale、detail 文档、图标与安装。
3. **`practices.md`** — 扩展点怎么选：Service、Event、Tool、Prompt、Agent context、Client Slot、状态放在哪里。
4. **`tool-design.md`** — 工具定义、skill、workflow 的写法与边界。
5. **`ui-plugin.md`** + **`user-actions.md`** — Web UI 的 Client manifest、模块加载、Slot 注册，以及 UI 操作如何复用 agent 工具。
6. **`configuration.md`** — 插件配置与凭据保存。
7. **`verification.md`** — 装完后怎么验证页面/面板；没有浏览器控制时怎么检查。
8. **`locate-docs.md`** — 以后怎么定位当前安装版本的文档和源码（ASAR 读取、包解析、版本确认）。
9. **`compositions.md`** / **`mcp-bundle.md`** — agent preset / loader patch / MCP 配置型 bundle，按需读。

## 源码比文档更权威

插件开发真正要对照的接口，在当前安装的这些包里：

```text
...\app.asar\dsh\node_modules\@deepseek-ai\
  dsh-llm\src\message.ts        # 消息、content block、finish 语义
  dsh-llm\src\types.ts          # GenerateOptions / StreamChunk / ToolSchema
  dsh-agent-loop\src\agent.ts   # llm.stream + tool-call + tool result 循环
  dsh-session-query\src\       # readSession / listEvents / searchEvents / readEvent
  dsh-tools\src\               # 工具注册与执行
  dsh-system-prompt\src\       # systemPrompt.context
  dsh-working-directory\src\   # workspace 解析
  dsh-agent-preset\skills\dsh-doc\templates\decoration\  # UI 插件模板
```

运行时优先用 `cordis_inspect_list` / `cordis_inspect_query` 核实，再读源码；不要凭记忆猜 API。

## 本项目自己的前提文档

- `ARCHITECTURE.md` — 这个插件的实际实现结构、Dream/auto-extract/recall 的数据流。
- `INTERFACES.md` — 本插件对 Host 暴露的接口、状态与所有权边界。
- `docs/reports/` — 每轮改造的原因、取舍和剩余债务。

## 一句话

先读 `plugin-development.md` 建立 bundle 心智模型，再用 `practices.md` 选扩展点，最后以 `dsh-*` 源码为准核对具体 API。不要先写代码再猜接口。
