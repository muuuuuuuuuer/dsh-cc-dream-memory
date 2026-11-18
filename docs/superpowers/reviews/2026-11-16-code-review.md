# dsh-cc-memory 代码审查报告（2026-11-16）

审查对象：`dsh-cc-dream-memory` v0.20.0，基线 HEAD `4c0acd3`，外加 `src/dream-agent.js` 中未提交的 `session_read` 窗口提示改动与一个未提交测试文件。审查覆盖 `src/`（dream/evidence/shadow/store/policy/tools/commands/status/http/readiness/scheduler/recall）、`client.js` 与相关文档、测试。每条发现都经过两轮独立验证：一名对抗性 refuter 尝试用代码与运行时复现去推翻它（temp-dir harness，不改动仓库文件），一条可达性追踪从生产入口（`POST /dream`、`/memory` 与 `/dream` 斜杠命令、`memory_save`/`memory_update` 工具、web panel、`turn/end` 会话事件）走到底层调用点。确认成立 10 条（2 高 / 8 中），另有 8 条未能升级为确认的低严重度观察列在文末。

---

## /memory edit 永远无法保存：它从不发送 writeFile 要求的编辑基线

**high · bug · `src/commands.js:1300`**

**触发**：对任何已存在页面（以及任何新页面）执行 `/memory edit <file> --content="..."`。

**证据**：`memoryEdit` 只构造 `const input = { file };` 并拷贝 name/type/description/content（`src/commands.js:1294-1297`），随后 `result = await service.writeFile(status.pctx, input);`（`src/commands.js:1300`）；`grep -n expectedHash src/commands.js` 无任何命中。而 `writeFile` 只从 input 取基线：`const expectedHash = typeof input.expectedHash === 'string' ? input.expectedHash.trim() : '';`，已存在文件时 `if (expectedHash === '') { throw coded('stale-write', ``re-read ${file} before saving; an edit baseline is required``); }`（`src/status.js:601-603`）；创建分支要求 `file === ''`（`src/status.js:553`），所以 `src/commands.js:1305` 的 `result.created ? ' (created)' : ''` 也不可达。实测：`edit user_role.md --content=CHANGED` 返回 `stale-write: re-read user_role.md before saving; an edit baseline is required`，磁盘内容不变；`edit ghost.md` 返回 `stale-write: memory file not found`。回归来源是 `459da28`（reviewable Dream）给 `writeFile` 加了基线与存在性校验，HTTP/UI 编辑器同步更新（`client.js:1828-1829`），斜杠命令没有。无测试覆盖（`test/edit-v10.test.mjs` 直接调用 `service.writeFile` 并自带 `expectedHash`）。

**Fix**：在 `memoryEdit` 里先读页面并把基线带上：`const current = await service.file(status.pctx, file)`，再 `input.expectedHash = memoryHash(current.raw)`（复用 `src/write-review.js` 的 `memoryHash`），或增加 `--expected-hash=` 参数；保留 stale-write 传播以保证并发写仍失败。

---

## entrySimilarity 从不比较正文：FIELD_WEIGHTS 用 `body`，normalizeCandidate 存成 `content`，同标题下不同事实得 1.0 并被硬判 DUPLICATE

**high · bug · `src/policy.js:238`**

**触发**：`memory_save`（以及共用 `evaluateWrite` 的 `memory_update`、`/remember`）写入一条 name+description 与已有页面相似、但正文记录的是不同事实的笔记——正是模型在"同一标题下重记一个已变化的事实"而不是调用 `memory_update` 时会做的事。

**证据**：`const FIELD_WEIGHTS = Object.freeze({ name: 0.45, description: 0.25, body: 0.3 });`（`src/policy.js:25`），但 `normalizeCandidate`（`src/policy.js:155-169`）返回 `content: body,`（第 166 行）；`entrySimilarity` 两侧都先 normalize，再 `const a = String(left[field] ?? '').trim();` / `const b = String(right[field] ?? '').trim();`（`src/policy.js:238-239`），`field === 'body'` 时双方均为 `undefined`，`if (a === '' || b === '') continue;` 把 0.30 项对每一对都丢掉，得分退化为 `(0.45*name + 0.25*desc)/0.7`。实测 `entrySimilarity`：name+description 相同、正文完全不同 → `1`；近义 name 变体（`Deploy target` vs `Deploy target (staging)`）→ `0.871`，`evaluateWrite` 返回 `{action:'duplicate', advisory:false}`，`writeStopped`（`src/tools.js:311-325`）转成 `{ok:false, error:'DUPLICATE', message:'... already covers this memory'}`。同一文件顶部的 docstring（`src/policy.js:224-231`）声明的正是相反的权重语义；`loadPolicyEntries` 每次 save 花 12×4000 字符读正文（`src/tools.js:114-116, 252-266`）却喂给一个必然被丢弃的项。方向相反也失效：正文相同、name/description 无关时 S=0。

**Fix**：按 `normalizeCandidate` 真正写入的字段取值——`field === 'body'` 时回落到 `left.content`/`right.content`，或在 `normalizeCandidate` 的返回对象里保留 `body` 键——让 0.30 项参与计算。

---

## Rules 的 secret-scan 警告由 POST /rules 返回、CLI 会打印，但 web client 的 normalizer 丢弃它（静默保存）

**medium · bug · `client.js:1112`**

**触发**：Settings → Rules，粘贴含 warn 级 secret 匹配的文本（例如 `- token: myverysecretvalue`、`Bearer abcdefghij1234`、高熵 base64 块），在默认 `secretScan: 'warn'` 下保存（project 或 global）。注意：`sk-...`/`ghp_...`/`AKIA...` 是 deny 级，会被拒绝并给出 `SECRET_DETECTED`，不属于本条的触发条件。

**证据**：`function normalizeRules(raw)`（`client.js:1112-1121`）只返回 `{text, source, projectPath, globalPath, maxChars}`，没有 `warnings`；`saveRules`（`client.js:1746-1749`）是 SettingsTab 唯一的数据形状，`client.js:3814-3817` 随后无条件显示 `success: t('notice.rulesSaved')`（`run` 未传 `check`）。服务端把警告挂在同一对象上：`const warnings = scanRulesText(value); ... if (warnings.length > 0) normalized.warnings = warnings;`（`src/status.js:1076-1082`），`src/http.js:465-474` 原样返回。运行时复现：`POST /rules` 返回 `rules.warnings = ["secret-scan: rule secret-assignment near \"api_key = ab…\""]`，规则文件已写入（`test/status-v7.test.mjs:262-266` 断言 warn 模式仍写盘），随后 `src/inject.js:171-172` 把它注入每次 prompt。不可恢复：`GET /rules`→`service.rules`（`src/status.js:1063-1064`）不会重新扫描，刷新后警告消失。

**Fix**：在镜像里保留该字段（`warnings: Array.isArray(record.warnings) ? record.warnings.filter((item) => typeof item === 'string') : []`），并在 SettingsTab 的保存处理里渲染（`success: saved.warnings.length ? saved.warnings.join('; ') : t('notice.rulesSaved')`）。

---

## Memory 编辑器的 stale-write 冲突流程不可达（服务端发 `STALE_WRITE`，客户端匹配 `'stale-write'`），且重试永不成功

**medium · bug · `client.js:2830`**

**触发**：在 Memory 面板打开一条笔记，编辑期间 agent 或其他窗口写入同一笔记，然后点 Save。

**证据**：`if (error && error.code === 'stale-write') {`（`client.js:2830`）永不匹配：`error.code = data.error;`（`client.js:1702`）逐字复制 HTTP body，`sendCoded` 不做大小写归一（`src/http.js:189-195`），而并发写路径是 `assertExpectedHash` → `throw memoryError('STALE_WRITE', ...)`（`src/store.js:83-86`，`src/status.js:625-629`）。于是 `edit.conflict` 的本地化文案（`client.js:85`）与自动 reload 都不发生，zh UI 里出现英文 `STALE_WRITE: memory changed since this edit was proposed: <file>`。基线从不刷新：`expectedHash` 仅在 `startEdit`（`client.js:2805`）赋值、每次 save 原样重发（`client.js:2823`），`patchEditor` 只合并 `error`，所以之后每次 Save 都以同一 stale hash 失败，直到关闭编辑器丢弃草稿。caveat（refuter 修正）：该分支并非完全死——页面在编辑期间被删除/改名时 `src/status.js:599` 抛出的 `coded('stale-write', ...)` 确实到达这里；真正不可达的只是"内容被并发改动"这一种。测试用伪造的小写 payload 覆盖（`test/client.test.mjs:1085-1097`），而真实路径断言 `STALE_WRITE`（`test/edit-v10.test.mjs:114`）。

**Fix**：比较前归一化（`String(error.code || '').toLowerCase().replace(/_/g, '-') === 'stale-write'`），并在同一分支里采用重新载入页面的 hash 作为新基线（或禁用 Save 直到重开编辑器）。

---

## 未知的 /memory dream 子命令返回 undefined 而非 CommandResult，文档里的 `apply` 动词无人处理

**medium · bug · `src/commands.js:1149`**

**触发**：`/dream apply`（`CHANGELOG.md:254` 的历史条目）、`/memory dream apply`（`src/commands.js:1728` 仍在提示），或任何拼写错误如 `/dream swtich`。

**证据**：`memoryDream` 最后一个分支是 `if (sub === 'discard') { ... }`（`src/commands.js:1135-1147`），函数在 `src/commands.js:1149` 结束，没有 fallback return；`case 'dream': return await memoryDream(invocation, args);`（`src/commands.js:1635-1636`）与 `/dream` 别名都原样外传，因此未识别的子命令得到 `undefined`——无文本、无错误。其他每一级都有兜底 `default: return fail('unknown /memory subcommand ...')`（`src/commands.js:1637-1638`），只有 dream 这一级没有。`459da28` 删除了 `if (sub === 'apply')` 分支且未做别名映射。用 `test/v10-helpers.mjs` 的 `commandEnv` 实测：`dream swtich`、`dream apply`、`/dream` + `rawInput:'apply'` 均返回 `undefined`；`swtich`（顶层）返回 `{kind:'error'}`。caveat：`src/commands.js:1728` 的 `(apply with /memory dream apply)` 提示几乎死路（当前引擎从不写 `status:'review'`，`planPath` 默认 `''`），只能通过遗留 manifest 出现；`/memory dream apply` 的核心危害是请求的 switch 静默不执行。

**Fix**：在 `memoryDream` 末尾补 `return fail('unknown dream subcommand "<sub>".\nusage: /memory dream run|status|cancel|diff|switch|discard|history|undo|on|off|estimate');`，并实现或删除 `apply` 动词和 `src/commands.js:1728` 的提示。

---

## /memory export 打印 'exported undefined file(s)'

**medium · bug · `src/commands.js:1420`**

**触发**：在任意项目执行 `/memory export <target-dir>`。

**证据**：命令格式化 `exported ${result.exported.length} file(s) to ${result.targetDir}...`（`src/commands.js:1420`），但 service 刻意返回数量：`// The HTTP contract reports a count; the file list rides along for the UI.` 后接 `exported: exportedFiles.length,`（`src/status.js:895-896`），文件列表放在 `exportedFiles`。`(3).length` 为 `undefined`，用户看到字面 `exported undefined file(s) to C:\...`。同族命令 `importMemory` 返回数组，所以 `result.imported.length`（`src/commands.js:1394`）是对的，说明这是不一致而非契约。测试只断言 `/export/i`（`test/import-export-v10.test.mjs:167`），错误文本自然通过；导出本身成功，缺陷只在反馈。

**Fix**：用 `${result.exported} file(s)`（数量）或 `${result.exportedFiles.length} file(s)`，二者留一。

---

## 记忆引用只在 run 结束时对照 shadow 副本校验；review 期间编辑被引用的页面会让支撑失效，但改动仍以 kind:'citation' 生效

**medium · design · `src/dream-shadow.js:277`**

**触发**：Dream 提议 `removed a.md`，唯一来源是对 `b.md` 的记忆引用（evidence `{file:'a.md', revision:'removed', source:'memory', memoryFile:'b.md', verified:true}`）。reviewer 在 switch 前编辑 `b.md`（删掉被引用的句子）。`b.md` 既不在 `passed` 也不在 `dependencies` 里（`dependsOn` 只在 link 分支设置：`src/dream-evidence.js:145` `...(dependsOn && !hasQuote ? {dependsOn} : {})`），冲突过滤把它丢掉：无冲突、无 confirm，删除以 proof kind `citation` 应用。

**证据**：`const required = new Set([...passed, ...dependencies]); const conflicts = (await shadowConflicts({ store, base })).filter((item) => required.has(item.file));`（`src/dream-shadow.js:276-277`）；apply 时 `sourced()`（`src/dream.js:231-235`）只重读已存的 proof。唯一的实时引用校验是 `src/dream-evidence.js:103` `const page = await after(item.memoryFile);`——对 shadow 副本，只在 `reviewProofs` 内跑一次。实测：proofs 为 `[{action:'removed', revision:'removed', kind:'citation'}]`（无 dependsOn），`store.updateEntry(b.md, ...)` 删掉引用句后 `switchDream` 返回 `{ok:true, counts:{removed:1}}`，`a.md` 进回收站。对照实验证明该不变量本意存在：同样形状改用 link 移动（`moved_to b.md`）时，编辑 live `b.md` 后 switch 返回 `{ok:false, error:'conflict', conflicts:[{file:'b.md', reason:'edited while the dream ran'}]}`。同一行还有加重项：`!(dependsOn && !hasQuote ? ...)` 让同时带 quote 的 link 移动也丢掉了 `test/review-regressions.test.mjs:405-418` 所依赖的 live 冲突检查。

**Fix**：在 `switchShadow` 内对 live store 重跑引用校验（用 `store` 而非副本调用 `pageStillSays`），或把 passed 文件每个 `evidence[].memoryFile` 加入 `required`，让 live 编辑命中既有的 "edited while the dream ran" 冲突。

---

## 扫描节流门是死的：没有任何代码写 lastScanAt，超时的 auto-dream 下一轮就重启

**medium · design · `src/state.js:525`**

**触发**：`autoDreamEnabled` 且一次 Dream 以未调用 `markDreamDone`/`markDreamFailed` 的方式结束。具体是 `dreamTimeoutMs` 到期：`src/dream-agent.js:1006-1011` 走 abort 分支（`await clearShadow(paths); await save({ status: 'cancelled', ... }); await state.clearDreamError?.(); return finish({ ok: false, error: reason, runId });`），不记录 failure，`consecutiveFailures` 保持 0。下一个 `turn/end` 到 `src/scheduler.js:55-56` 时 readiness 再次判 eligible，又起一整轮模型循环，每个 assistant turn 一次。

**证据**：门所读字段唯一的写者从未被调用：`async noteScan() { await this._mutate((state) => { state.lastScanAt = Date.now(); }); }`（`src/state.js:525-529`），`grep -rn noteScan src/` 只有定义，因此 `lastScanAt` 永远是 `src/state.js:38` 的 0，`const throttleRemaining = lastScanAt > 0 ? Math.max(0, lastScanAt + throttleWindowMs - now) : 0;`（`src/readiness.js:157-159`）恒为 0，`src/readiness.js:202-207` 的 `throttle` 原因不可达。这不是设计取舍：`git show 459da28^:src/scheduler.js` 在调用引擎前有 `await projectContext.state.noteScan();`，`459da28` 连同旧内联门一起删掉且未补写；而文档与 CLI 仍在宣传该门（`docs/ARCHITECTURE.md:411`、`docs/INTERFACES.md:35`、`docs/manual.zh.md:302`、`src/commands.js:995` 的 `gates: ... scan throttle ${...}m`）。`markDreamStart()`（`src/dream-agent.js:830`）确实写 `lastDreamAttemptAt`，但它只在 `backoffMs` 内被读，而 `backoffMs` 以 `failures > 0` 为门（`src/readiness.js:160-162`），贡献为 0。测试只断言初值 0（`test/state.test.mjs:36`）。

**Fix**：在尝试路径补写——`maybeAutoDream`（`src/scheduler.js`）通过 eligibility 检查后立刻 `await projectContext.state.noteScan();`，或在 `DreamAgent.#run` 顶部与 `markDreamStart` 并列；若确实不想要该门，就同步删掉 `lastScanAt`/`throttleRemaining` 与文档、CLI 的宣称。

---

## reconcileIndex 会把刚剪掉的 stale/superseded 索引行重新追加，MEMORY.md 每次 refresh 都来回翻转

**medium · design · `src/store.js:1737`**

**触发**：某 topic 文件正文带 `STATUS: superseded`（或 stale/retired/review-needed）且仍有一条索引行。refresh #1 删掉该行；refresh #2（中间无写入、索引有余量）`audit.missing` 是剪枝前算出的，于是又补回一行规范索引行。两次 refresh 就足以让它无限翻转（dream switch 的 `src/dream-shadow.js:306`、merge 的 `src/status.js:715`、restore 的 `src/status.js:1265`、dream undo 的 `src/dream.js:433`，两次 merge 等效）。

**证据**：删除分支 `if (!isCurrentPage(body)) { removed.push(reference); pruned += 1; continue; }`（`src/store.js:1710-1714`，注释写明"A stale/superseded page has no business taking an index slot"）；追加循环 `for (const meta of missing) { if (entryLines >= maxLines) break; kept.push(indexLine(meta));`（`src/store.js:1734-1738`）没有 currentness 过滤，而 `missing` 来自剪枝前的 `const audit = await this.auditIndex(normalized)`（`src/store.js:1669`）。实测（默认 indexMaxLines=200）：save → refresh1 删 → refresh2 加 → refresh3 删 → refresh4 加，完美交替。`src/inject.js:113-116` 原样注入 index 文本且无逐行状态过滤，所以一半的 refresh 会把已退役笔记当现行笔记喂给模型。caveat（refuter 修正）：`/memory refresh` 并不到达这里（`src/commands.js:1234` 只调 `runtime.refreshSession`）；索引满时追加循环立刻 break，所以"抢走活跃笔记槽位"不成立，翻转只在有余量时发生。

**Fix**：对追加源施加同一道闸——剪枝后再构造 `missing`，或在循环内 `if (!isCurrentPage((await this.readEntry(meta.file, normalized)).body)) continue;`。

---

## read→update 往返会抹掉 memory_read 刻意隐藏的 `## History` 段

**medium · design · `src/tools.js:738`**

**触发**：页面带有 `- Superseded: <old value>`（由 `composeCorrection` 或 Dream correction 写入），被读取后以普通方式更新：`memory_read` 返回 `body: currentBody(entry.body)`，模型编辑该文本，`memory_update` 原样写回。

**证据**：`memory_read` 返回 `body: currentBody(entry.body)`，注释 `// A read answers "what holds now". Old values stay in the file, the changelog and /memory history rather than coming back as current.`（`src/tools.js:893-897`）；而它喂出的唯一写入路径整段替换正文：`content: writeContent`（`src/tools.js:738-744`），`const body = changes.content === undefined ? parsed.body : normalizeBody(changes.content);`（`src/store.js:1283`）。`correction` 只在 `basis === 'user-explicit'` 时构造（`src/tools.js:686-690`），所以普通编辑 `writeContent === input.content`。read-hash 台账还主动批准这次破坏：hash 记录的是模型从未见过的原始文件（`src/tools.js:868,880`），与 `memoryHash(existing.raw)`（`src/tools.js:644-652`）天然相等，永不判 STALE。实测：带 `## History` / `- Superseded:` 的页面，read→update 后文件中既无 `Superseded` 也无 `## History`。正文丢失无其他可见面：`.history/` 快照（`src/store.js:1123`）没有任何 reader，`fileHistory`（`src/status.js:756-785`）只返回 provenance + changelog + planRefs。而 merge 路径会显式保留历史（`src/status.js:687-699`，`test/review-regressions.test.mjs:298-315`），两条路径对"历史是否持久"给出相反答案。限定：省略 `content` 的更新与 `basis:'user-explicit'` 的修正不受影响。

**Fix**：`memory_update` 收到的新 `content` 若不含 `## History` 标题，写入前把 `existing.body` 的历史尾巴（`## History` 起，含 `Superseded:` 行）追加回去；或让 `memory_read` 用独立字段返回这些段落以便往返。同步修正 `src/tools.js:894` 的注释。

---

## 未验证的低严重度观察

以下 8 条经代码阅读确认机制成立，但未完成对抗复核与可达性闭环，仅作后续排查线索：

- （未验证）`src/dream-agent.js:1023` 冲突是唯一不清 `.dreams/shadow` 的终态路径，且没有任何 pending 状态能再触达该副本。
- （未验证）`src/dream-agent.js:1089` `verifiedFiles`/`verifiedClaims` 硬编码为 `[]`，`src/dream.js:248-279` 的已校验页面台账分支永不执行；若启用，`recordVerifiedEntry` 默认 `source:'user-explicit'` 会把 Dream 引用误标成人工确认。
- （未验证）`src/readiness.js:147` 只看 `shadowPending` 字段而不看目录是否存在，而修复分支（`src/dream-agent.js:806-807`）只能在被 readiness 拒绝启动的 run 内部执行，可能永久卡住 auto-dream。
- （未验证）`src/store.js:304` `indexLine` 在名字过长时把 `](file.md)` 链接一起截掉，页面从此无法被索引，且每次 save 追加一条新的孤立行。
- （未验证）`src/store.js:839` `_upsertIndexLine`/`_removeIndexLine` 用 `](file)` 子串匹配，而 audit 解析首个链接目标；描述里含指向另一页面的 markdown 链接时会删掉那一页的索引行。
- （未验证）`src/recall.js:214` 在预算极小时会挂上没有正文也没有 read-more 指针的 section，并把该页标记为本会话已展示。
- （未验证）`src/commands.js:1218` `/memory restore` 是全库唯一没有 `subagentGuard` 的写入命令，且直接 `copyFile` 覆盖 live 页面、不取 `.history` 快照。
- （未验证）`client.js:2378` 错误文案表仍以 `dream-locked`/`stale-plan` 为键，而 v2 只发 `LOCK_BUSY`/`stale-dream`，对应中英文案不可达。

---

## 建议的处理顺序

**进入设计文档中 phase-A 工作之前（数据完整性 + 主干入口，先修）**

1. `src/policy.js:238` 的 `body`/`content` 字段错配——它会让新的写入路径静默误判重复、错误拒绝合法写入，phase-A 任何新增写入口都会踩到。
2. `src/tools.js:738` 的 `## History` 丢失——属于静默数据丢失，越晚修，越多页面在 phase-A 的批量改动中被抹掉历史。
3. `src/store.js:1737` 的 reconcileIndex 翻转——影响注入 prompt 的内容与缓存，phase-A 会新增 refresh/switch 调用点，先让它收敛。

**phase-A 期间顺手修（影响面清晰、改动小）**

4. `src/commands.js:1300` `/memory edit` 全线失败与 `src/commands.js:1149` dream 子命令返回 `undefined`——命令层契约问题，一次补默认分支 + 基线即可。
5. `src/commands.js:1420` 的 `exported undefined`、`client.js:2830` 的 stale-write 大小写与基线不刷新、`client.js:1112` 的 rules 警告丢失——都是窄面 UI/CLI 修复。

**可延后（需要先决定语义，再做）**

6. `src/dream-shadow.js:277` 的 citation 应用期校验与 `src/state.js:525` 的死节流门——前者需要确定"引用必须以 live 页面复核"的归属（shadow 还是 apply 期），后者需要决定是恢复写点还是删除该门并同步文档。
7. 文末 8 条未验证观察，先各补一个最小复现再排期。
