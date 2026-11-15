# 2026-11-15 审计修复报告

## 结论

本轮先修数据丢失与并发（P0），再修正确性、成本和状态（P1）。随后按用户
要求删除旧 `DreamPipeline` 与 `dreamAgent` 开关，Dream 只剩 `DreamAgent`
一套实现。修复后 `npm test` 477 个测试、476 通过、1 个既有跳过；
`node scripts/verify.mjs` PASS（64 个测试文件，476 条断言）。

## P0 数据丢失 / 并发

1. **Dream 文件锁实际未获取**
   - `src/lock.js`：`waitMs:0` 时循环一次都不执行，`fn()` 在无锁下运行。
   - 修复：改为至少尝试一次（`do...while`），并新增 `strict:true` 时
     `LOCK_BUSY` 错误。
   - `src/dream-agent.js`：Dream 改用 `waitMs:2000, strict:true`。

2. **Dream 切换会删掉运行期间新建的笔记**
   - `src/dream-shadow.js`：`shadowConflicts` 过去只检查 `base` 里的文件。
   - 修复：磁盘上存在、但 `base` 里没有的文件一律作为
     `created while the dream ran` 冲突，`switchShadow` 拒绝切换。

3. **会话读取记录接错，Dream 永远重复读同一批会话**
   - `src/dream-agent.js`：`toolsFor` 增加独立的 `onReadSession`；
     `session_search`/`session_read` 走 `(sessionId, seq)`，不再写成
     `memory:<session>` 键；`readRecords` 按候选会话的 `lastSeq` 判断
     `complete`，完成会话不再带 `partial`。

4. **人工/API Dream 会覆盖未切换的副本，且 no-diff 留下悬空 pending**
   - `src/dream-agent.js`：运行前检查 `shadowPending`。目录仍存在时直接
     返回 `pending-switch`；目录已丢失时清掉陈旧状态。no-diff 分支同时
     `clearShadowPending()`。

5. **自动抽取可借 `memory_update.delete` 删除记忆**
   - `src/auto-extract.js`：抽取路径强制剥离 `delete` 与 `expectedHash`，
     只能更新，不能删除。

6. **Dream 会话工具可读任意会话**
   - `src/dream-agent.js`：`session_search`/`session_read` 只接受候选
     会话 id，非候选返回错误，不调用 `sessionQuery`。

## P1 正确性 / 可用性 / 成本

7. **Dream 没有总超时，取消被记为失败**
   - `src/config.js` 新增 `dreamTimeoutMs`（默认 600000）。
   - `src/dream-agent.js` 用 `AbortSignal.timeout` 与外部 cancel 合并；
     超时/取消清掉 shadow，返回 `timeout`/`cancelled`，不清失败退避。

8. **Dream 忽略配置的 provider/model**
   - `src/dream-agent.js` 改为 `resolveModel(ctx, {provider, model})`。

9. **抽取与 Dream 并发写同一项目**
   - `src/scheduler.js` 增加每项目串行队列：先抽取，再 Dream；不再并行
     快照与写入。

10. **抽取游标只在内存，重启后重复抽取**
    - `src/state.js` 新增持久化 `extractSeqs` 与 `noteExtractSeq()`。
    - `src/auto-extract.js` 取 `max(runtime 游标, 持久化游标)`；成功后写入
      状态。

11. **无写入时无条件推进游标，丢掉该 turn**
    - `src/auto-extract.js` 只有在工具循环正常结束且确实调用过工具时才推进
      游标；没有工具调用返回 `no-tool-use`，下轮重试。

12. **Dream `status` 对未知 run 永远返回 done**
    - `src/dream-agent.js` 读取 `runDir/manifest.json`，返回真实的
      `status/stage/skipReason/error/counts`；只有运行中的 active run 才
      报 `running`。

## 验证

- 新回归测试：`test/audit-fixes-v25.test.mjs`，覆盖锁、运行期新建文件、
  pending 副本、会话完成、抽取删除、候选限制、超时、manifest 状态、
  配置模型。
- 全量：`npm test` = 477 tests / 476 pass / 1 skip / 0 fail。
- 验证器：`node scripts/verify.mjs` = structure 2/2、syntax 120 files、
  tests 65/65，PASS（64 test files / 476 assertions）。

## 仍未完成（明确遗留）

- 旧 `DreamPipeline` 与其 21 个测试已删除；`config.dreamAgent` 已移除并忽略。
- `injectionMode`、`injectHotOnly`、`compactionDigest` 已无源码引用
  （grep 确认），不在当前遗留。
- `.trash`/`.dreams` 仍无 GC；Dream 已有 `memory_delete`（可删任意 shadow
  页），但没有对陈旧页的自动独立 prune；引用/证据只展示给人工，不做自动门。
- Inbox 自动抽取提案已删除，Inbox 只展示待切换的 Dream 结果；UI 文案按
  最小解冻只删了旧提案区，其他未动。
- `session_read` 的完成判断依赖候选 `lastSeq`；Host 若不给 `lastSeq`，
  该会话仍会以 `partial` 重读。
- `resume` 仍是“以同一 runId 重新开始”，没有真正的单元级续跑；界面上的
  “Continue”语义需要后续对齐或移除。
