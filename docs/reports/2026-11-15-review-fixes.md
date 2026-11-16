# 2026-11-15 外部评审修复报告

## 结论

评审的 8 条中，已修复 6.5 条：Dream 会话进度、合并审阅绑定、switch/undo 事务化、写入版本冲突、背景规则共享、插件注入证据过滤，以及召回去重/排序的版本不一致。仍未实现的是截断读取的分页（#5）与召回的 stale 预过滤/分层检索（#8 的后半），产品语义（reject/forget、保留标准、效果评估）需要用户决定。

## 已修复

1. **会话进度**：删除对不存在的 `header.lastSeq` 的依赖，改用 `sessionQuery.listEvents()` 推导每个会话的末端 seq；新增 `session_done` 工具，只有显式完成且已读到末端才记为 completed。未读会话保持候选。
2. **合并绑定**：`memory_write` 增加 `merges`，`memory_delete` 增加 `moved_to`，Dream 把这些关系写入 `state.shadowPending.links`，审阅时一个合并单元共享接受/拒绝。
3. **switch/undo 事务**：`switchShadow` 在项目锁内执行，写入失败从备份回滚并返回 partial；`undoLastDream` 支持幂等重试，部分失败不标记整批完成；`archiveShadow` 修正 `node:fs/promises` 上调用 `existsSync` 的错误。
4. **过期写入**：`memory_read` 返回内容 hash；`memory_update` 接受 `expectedHash`，与当前文件不一致时返回 `STALE`，不覆盖。
5. **规则共享**：Dream 与 auto-extract 的提示词都读取 `runtime.rulesFor(pctx).text`。
6. **证据来源**：session 搜索/读取跳过 `plugin:` 注入内容，事件片段标注 user/assistant/tool/plugin；`quoteMatches` 拒绝插件注入。
7. **召回版本**：已展示集合改为按文件名去重，manifest 按 `modified` 倒序，避免 content-hash 与 modified 不一致导致重复占用名额。

## 未完成

- #5 分页：`session_read` 仍返回截断片段且无 offset；`memory_read` 可被截断而 `memory_write` 可整页替换；auto-extract 的游标仍只有 seq，没有字符偏移。
- #8 后半：选择前未预过滤 stale 页面，也未做相关性分页/分层索引。
- 产品语义：reject 是否等于 forget、保留标准、Dream 效果评估协议。

## 验证

- `npm test`：500 tests / 499 pass / 1 skip / 0 fail。
- `npm run verify`：PASS，67 个测试文件、499 条断言。
- 受影响的定向测试：`audit-fixes-v25` 12/12，`dream-agent-v25` 4/4，`dream-agent-fixes-v26` 7/7，`recall-model-v20` 7/7。

## 运行注意

当前 GUI 进程仍加载旧模块；需要重启 Host 后，`session_done`、`expectedHash`、事务化 switch/undo 才生效。
