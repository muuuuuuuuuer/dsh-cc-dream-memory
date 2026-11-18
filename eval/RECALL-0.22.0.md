# 0.22.0 召回段落配对验证

## 为什么测这一层

0.21.0 已经能用笔记正文生成候选。问题出在选中文件之后：长页从开头截断，同页的 `Applies when` 等标记被抽到页尾，同名标记只保留最后一项。0.22.0 将候选片段对应的源位置传给附加步骤，长页保留命中段落、标题和相邻条件，短页保持原文顺序。紧预算时保留 `memory_read` 指针，优先压缩可附加的文件数量。

OpenClaw 的 `memory_get` 支持具体行范围，LangChain 的 ParentDocumentRetriever 使用小块定位再取上级上下文。Anthropic 的 Contextual Retrieval 在索引阶段给片段补上下文，LongMemEval 则分别研究索引、检索和阅读。这些设计启发本次保留源位置，并分别检查候选、附加和回答。 [OpenClaw](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md) · [LangChain](https://github.com/langchain-ai/langchain/blob/master/libs/langchain/langchain_classic/retrievers/parent_document_retriever.py) · [Anthropic](https://www.anthropic.com/research/contextual-retrieval) · [LongMemEval](https://arxiv.org/html/2410.10813v2)

## 实验

2026-11-18。对照组使用 `abcd82c` 的召回和存储代码，新版使用 0.22.0。两组读同一批合成 Markdown，每个场景每组跑两次，交替执行。`agent/pre-step` 收到真实选择模型的结果，再将附加后的消息发给回答模型。两阶段均使用 DeepSeek Flash，关闭思考，选择超时设为 12 秒。五个场景用 620 字符的附加上限，长例外场景用 430 字符。回答阶段没有提供工具，测量的是自动附加提供的信息。 [API 参考](https://api-docs.deepseek.com/api/create-chat-completion/)

| 场景 | 0.21.0 附加符合预期 / 回答正确 | 0.22.0 附加符合预期 / 回答正确 |
|---|---:|---:|
| 命中长笔记后段 | 0/2 · 0/2 | 2/2 · 2/2 |
| 同页两个环境走不同命令 | 0/2 · 0/2 | 2/2 · 2/2 |
| 短页有两条不同适用条件 | 0/2 · 0/2 | 2/2 · 2/2 |
| 极紧预算下保留读取指针 | 0/2 · 2/2 | 2/2 · 2/2 |
| 普通短笔记 | 2/2 · 2/2 | 2/2 · 2/2 |
| 无相关记忆 | 0/2 · 2/2 | 0/2 · 2/2 |
| **合计** | **2/12 · 6/12** | **10/12 · 12/12** |

有目标页的 10 次试验中，两版都让目标页进入候选并附加。每轮均调用一次选择模型，平均 402.7 总 token。回答请求平均总 token 从 165.5 降至 158.3。召回阶段耗时中位数分别为 1,027 和 976 ms，包含本地处理和网络请求。样本量与网络波动限制了对一般延迟或准确率的推断。

无相关记忆的场景中，两版的选择模型都误选了三个文件，回答模型仍给出预期的 `UNKNOWN`。离线探针用确定性的选择器回放时，两版都能正确处理空选择。这暴露了选择层的拒答问题，与附加段落的完整性是两项独立结果。

## 复跑

```powershell
node eval/recall-passages.mjs
node eval/recall-passages.mjs --live
```

离线运行输出候选及附加结果。`--live` 读取 `DEEPSEEK_API_KEY` 并输出回答、用量和耗时。两种模式都需要能读取基线提交 `abcd82c`。真实运行通过 API 适配器调用插件钩子，桌面安装仍需单独验证。
