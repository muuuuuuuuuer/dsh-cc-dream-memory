/**
 * dsh-cc-dream-memory — browser half (v5 UI).
 *
 * Two registrations:
 *  - `conversation.view` (id `cc-memory`, order 40): the Memory page. The header
 *    always says what a new conversation loads. Five tabs:
 *      Memories — search, type and trust filters, one list, and a reader that
 *                 shows how far each note can be trusted (loaded, verified,
 *                 edited since verified, outdated), its conditions, earlier
 *                 values and change history; plus the editor;
 *      Inbox    — every decision waiting for the user: queued agent writes with
 *                 their reasons and proposed text, and a Dream plan to review;
 *      Dream    — estimate → plan → review and apply, with Dream v2 coverage
 *                 and evidence per change, auto dream, recent dreams and undo;
 *      Settings — switches, what new conversations load, the memory rules,
 *                 trash/backup restore and storage.
 *  - `conversation.composer.dock` (id `cc-memory-status`, order 50): a small
 *    ambient chip (memory count and anything waiting), polled 60s.
 *
 * Data comes only from the silent HTTP API; the page gets its base and token
 * from `GET /api/cc-memory/bridge`. These requests never write session-log
 * command rows. Without the bridge the page says the service is unavailable.
 *
 * Styling uses the host design tokens only. `react` is the sole package that
 * may be required; the module must not import anything else.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cc-dream-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin (mirrored by locale/*.json). */
    const NS = 'dsh-cc-dream-memory';

    // -----------------------------------------------------------------------
    // Dictionaries (mirrored 1:1 by locale/en.json and locale/zh.json).
    // -----------------------------------------------------------------------
    const EN = {
  'about.dir': 'Memory folder',
  'about.title': 'Storage',
  'about.usage': 'Loaded {inject} times · read {reads} · saved {writes} · searched {searches}',
  'about.version': 'Plugin version {v}',
  'banner.autoMemoryOff': 'Auto memory is off: new conversations don\'t load memory and the agent can\'t save memories.',
  'banner.backendStale': 'The memory plugin is still running older code than this page, so newer parts (trust marks, write details) fail. Quit DeepSeek Harness completely and open it again.',
  'banner.noBackend': 'The memory service isn\'t available on this page. Reload the page; if it still fails, check that the plugin is installed.',
  'banner.pluginOff': 'Memory is turned off: nothing is loaded, saved or dreamed.',
  'banner.tokenExpired': 'The connection to the memory service expired. Reload the page to reconnect.',
  'btn.back': 'Back',
  'btn.cancel': 'Cancel',
  'btn.clear': 'Clear search',
  'btn.close': 'Close',
  'btn.confirm': 'Click again to confirm',
  'btn.confirmDelete': 'Delete for sure?',
  'btn.copy': 'Copy path',
  'btn.delete': 'Delete',
  'btn.edit': 'Edit',
  'btn.new': 'New',
  'btn.refresh': 'Refresh',
  'btn.reload': 'Reload page',
  'btn.retry': 'Retry',
  'btn.review': 'Review',
  'btn.save': 'Save',
  'btn.saving': 'Saving…',
  'btn.turnOn': 'Turn on',
  'chip.attention': '{n} to review',
  'chip.label': 'Memory',
  'chip.title': 'Memory for this project',
  'detail.changed': 'Edited after it was verified. It stays out of the loaded set until a Dream verifies it again.',
  'detail.conflict': 'Conflict',
  'detail.created': 'Created {time}',
  'detail.emptyBody': 'This memory has no details.',
  'detail.history': 'Change history',
  'detail.historyDream': 'Dream · {n} changes',
  'detail.historyEmpty': 'No recorded changes yet.',
  'detail.historyPending': 'Waiting in the inbox',
  'detail.loading': 'Loading…',
  'detail.missing': 'This memory no longer exists.',
  'detail.session': 'From conversation {id}',
  'detail.stale': 'Marked "{status}": left out of recall and of what new conversations load.',
  'detail.superseded': 'Earlier values',
  'detail.unverifiedIndex': 'Not verified by a Dream yet.',
  'detail.updated': 'Updated {time}',
  'detail.verified': 'Verified {date}: a Dream checked this exact text against the conversations it came from.',
  'edit.conflict': 'Another window saved this note first. Your draft is still here; reload to see the newer version.',
  'edit.content': 'Details',
  'edit.contentPlaceholder': 'Markdown is supported. Ctrl+Enter saves.',
  'edit.description': 'One-line summary',
  'edit.descriptionHint': 'Shown in the index and in search results.',
  'edit.editTitle': 'Edit memory',
  'edit.name': 'Name',
  'edit.namePlaceholder': 'e.g. Reply language',
  'edit.nameRequired': 'Give the memory a name.',
  'edit.newTitle': 'New memory',
  'edit.reverifyHint': 'This note is verified. Saving a change means it leaves the loaded set until a Dream verifies it again.',
  'edit.type': 'Type',
  'edit.typeHint.feedback': 'Corrections and approaches you confirmed.',
  'edit.typeHint.project': 'Decisions and ongoing work the code doesn\'t show.',
  'edit.typeHint.reference': 'Where to find outside information.',
  'edit.typeHint.user': 'Who you are and what you prefer.',
  'err.backendStale': 'The plugin backend is older than this page and does not know this request. Quit DeepSeek Harness completely and open it again.',
  'err.deleteDisabled': 'Deleting is turned off in the plugin config (dreamAllowDelete).',
  'err.evidenceRejected': 'Some changes lack a checkable source, so nothing was applied:',
  'err.locked': 'Another dream is running. Try again in a moment.',
  'err.more': '… and {n} more',
  'err.stale': 'Memory changed after this plan was made. Create a new plan.',
  'error.load': 'Couldn\'t load memory',
  'inbox.emptyBody': 'Nothing needs your decision right now.',
  'inbox.emptyTitle': 'All clear',
  'inbox.planBody': 'Memory stays exactly as it is until you switch to the new copy.',
  'inbox.planTitle': 'A Dream result is ready',
  'inbox.extractTitle': 'Auto-extracted notes are waiting',
  'inbox.extractBody': '{n} proposed note(s) from a recent conversation. Accept keeps them through the normal save checks.',
  'inbox.accept': 'Accept all',
  'inbox.discard': 'Discard',
  'inbox.acceptFailed': 'Only {applied} of {total} notes were saved; the rest failed their checks.',
  'inbox.offTitle': 'Auto-extract is off',
  'inbox.offBody': 'Turn it on in Settings to stage notes from recent conversations here for review.',
  'inbox.emptyOffBody': 'Turn on Auto-extract in Settings to see proposed notes here before they reach memory.',
  'inbox.lastExtract': 'Last attempt: {reason} · {time}',
  'inbox.commandHint': 'From the conversation: /memory inbox accept <id>',
  'notice.inboxAccepted': 'Accepted {n} note(s).',
  'notice.inboxDiscarded': 'Proposal discarded.',
  'list.emptyBody': 'Tell the agent "remember …" in a conversation, or add one yourself.',
  'list.emptyTitle': 'No memories yet',
  'list.filterEmpty': 'No memories match these filters.',
  'load.index': 'New conversations load the index: {lines} of {maxLines} lines.',
  'load.indexOver': 'New conversations load the index, but it is over budget and its end is cut off.',
  'load.off': 'New conversations load no memory: auto memory is off.',
  'load.recall': 'Matching notes are also attached to messages.',
  'notes.appliesWhen': 'Applies when',
  'notes.exception': 'Exception',
  'notes.observed': 'Observed',
  'notes.verify': 'How to check',
  'notice.copied': 'Path copied.',
  'notice.deleted': 'Moved to trash. You can restore it in Settings.',
  'notice.done': 'Done.',
  'notice.planDiscarded': 'Plan discarded.',
  'notice.restored': 'Restored.',
  'notice.rulesReset': 'Rules reset to the defaults.',
  'notice.rulesSaved': 'Rules saved. They apply from the next request.',
  'notice.saved': 'Saved.',
  'notice.toggled': 'Updated.',
  'readiness.backoff': 'The last attempt failed; it will retry later.',
  'readiness.lock': 'A dream is running.',
  'readiness.min-hours': 'Waiting for the {hours} h interval.',
  'readiness.min-sessions': '{current} of {required} conversations so far.',
  'readiness.pending-proposal': 'A plan is waiting for your review.',
  'readiness.throttle': 'Checked recently; it will check again soon.',
  'reason.mergeDependency': 'Its facts were meant to move into a change that cannot be applied, so deleting it would lose them.',
  'reason.noCitation': 'A new line has no source citation: “{line}”',
  'reason.noClaim': 'A citation does not match any quote the transcript verified.',
  'reason.unsupported': 'The line says something other than the quote it cites: “{line}”',
  'reason.userAttribution': 'It presents a requirement as the user’s without the user’s own words.',
  'reason.userClass': 'A user or feedback note needs a quote the user typed; forwarded material does not count.',
  'restore.all': 'Restore all',
  'restore.backups': 'Before dreams',
  'restore.empty': 'Nothing here.',
  'restore.files': '{n} files',
  'restore.hint': 'Deleted memories, and the copy taken before each dream.',
  'restore.one': 'Restore',
  'restore.title': 'Trash and backups',
  'restore.trash': 'Trash',
  'rules.count': '{n} / {max} characters',
  'rules.hint': 'Optional guidance added to every request, like a CLAUDE.md for memory. Leave it empty to send nothing extra.',
  'rules.placeholder': 'e.g.\n- Save deploy commands and who owns each service.\n- Skip one-off debugging steps.',
  'rules.reset': 'Remove custom rules',
  'rules.saveGlobal': 'Save for all projects',
  'rules.saveProject': 'Save for this project',
  'rules.source.default': 'Default',
  'rules.source.global': 'All projects',
  'rules.source.project': 'This project',
  'rules.title': 'What to remember',
  'search.empty': 'No memories match "{q}".',
  'search.placeholder': 'Search memories',
  'settings.autoDream': 'Auto dream',
  'settings.autoDreamHint': 'Dream memory in the background from time to time.',
  'settings.autoExtract': 'Auto-extract',
  'settings.autoExtractHint': 'Every {n} turns, ask the model for notes worth keeping and stage them in the Inbox.',
  'settings.extractDirect': 'Every few turns, save through the normal checks',
  'settings.perAgent': 'Per-agent memory',
  'settings.perAgentHint': 'Give delegated agents their own memory folder instead of the project memory.',
  'settings.perAgentOff': 'Off',
  'settings.perAgentOn': 'Every delegated agent with a preset name',
  'settings.perAgentShared': 'Shared project memory (read/write)',
  'settings.perAgentOnList': 'Only: {names}',
  'settings.autoMemory': 'Auto memory',
  'settings.autoMemoryHint': 'New conversations load memory, and the agent saves what is worth remembering.',
  'settings.enabled': 'Memory',
  'settings.enabledHint': 'Master switch for loading, saving and dreaming memory.',
  'settings.indexBudget': 'Index size',
  'settings.indexOver': 'The index is over budget, so its end isn\'t loaded. A dream shortens it.',
  'settings.loading': 'What new conversations load',
  'settings.loadingHint': 'Shown for reference. Change these in the plugin config.',
  'settings.mode': 'At the start',
  'settings.modeIndex': 'The whole index, MEMORY.md',
  'settings.recall': 'During the conversation',
  'settings.recallLexical': 'Word matching only; no model call',
  'settings.recallModel': 'Model selector picks up to five notes per message',
  'settings.recallNone': 'Off; the agent searches when it needs to',
  'settings.recallOff': 'Nothing more; the agent searches when it needs to',
  'settings.recallOn': 'Notes that match a message are attached to it (autoRecall)',
  'settings.switches': 'Switches',
  'settings.switchesHint': 'These apply to every project.',
  'status.disputed': 'Disputed',
  'status.retired': 'Retired',
  'status.review-needed': 'Needs review',
  'status.stale': 'Stale',
  'status.superseded': 'Superseded',
  'tab.inbox': 'Inbox',
  'tab.memories': 'Memories',
  'tab.settings': 'Settings',
  'tab.tidy': 'Dream',
  'tidy.discard': 'Discard',
  'tidy.discarded': 'dream result discarded; memory untouched',
  'tidy.estimateLine': 'Rough estimate: {tokens} of {limit} input tokens.',
  'tidy.estimateNoLimit': 'Rough estimate: {tokens} input tokens.',
  'tidy.estimateUnavailable': 'Could not estimate usage. Try again before starting Dream.',
  'tidy.focus': 'Focus (optional)',
  'tidy.focusPlaceholder': 'e.g. deployment notes, or the reply-language preference',
  'tidy.generate': 'Estimate the run',
  'tidy.historyTitle': 'Recent dreams',
  'tidy.indexMeta': '{lines} / {maxLines} lines · {bytes} / {maxBytes}',
  'tidy.intro': 'A dream reads your memories and recent conversations, then writes a cleaned-up copy of your memory. Nothing changes until you switch to it, and you can switch back under Recent dreams.',
  'tidy.op.create': 'new',
  'tidy.op.delete': 'removed',
  'tidy.op.index': 'index',
  'tidy.op.update': 'edited',
  'tidy.opsCount': 'Changes: {n}',
  'tidy.ready': 'Ready: the next dream runs after the next conversation turn.',
  'tidy.resultCounts': '{added} added, {changed} changed, {removed} removed',
  'tidy.resultTitle': 'A dream result is ready',
  'tidy.runAlready': 'A dream is already running for this project.',
  'tidy.runCancel': 'Stop',
  'tidy.runResume': 'Continue',
  'tidy.runStarted': 'Dream started. You can keep working; the new copy appears when the run finishes.',
  'tidy.runState.blocked': 'blocked',
  'tidy.runState.cancelled': 'cancelled',
  'tidy.runState.cancelling': 'cancelling',
  'tidy.runState.failed': 'failed',
  'tidy.runState.idle': 'idle',
  'tidy.runState.running': 'running',
  'tidy.runState.skipped': 'skipped',
  'tidy.runTitle': 'This run',
  'tidy.start': 'Start the dream run',
  'tidy.switch': 'Switch to it',
  'tidy.switchConflict': 'memory changed while the dream ran: {files}',
  'tidy.switched': 'memory replaced with the dream result',
  'tidy.title': 'Dream: memory consolidation',
  'tidy.undo': 'Undo',
  'tidy.undoConflict': 'These files changed after the dream, so it can\'t be undone safely: {files}',
  'tidy.undone': 'Undone. Memory is back to how it was before.',
  'tidy.undoneTag': 'Undone',
  'time.days': '{n} days ago',
  'time.hours': '{n} h ago',
  'time.justNow': 'just now',
  'time.minutes': '{n} min ago',
  'trust.all': 'Any status',
  'trust.changed': 'Edited since verified',
  'trust.stale': 'Outdated',
  'trust.unverified': 'Unverified',
  'trust.verified': 'Verified',
  'type.all': 'All',
  'type.feedback': 'Feedback',
  'type.project': 'Project',
  'type.reference': 'Reference',
  'type.user': 'User',
  'via.agent': 'Saved by the agent',
  'via.command': 'Saved with /remember',
  'via.import': 'Imported',
  'via.tidy': 'Written by a dream',
  'via.you': 'Edited by you',
  'view.title': 'Memory',
  'tidy.started': 'Dream started. You can keep working; the new copy appears when the run finishes.',
};

const ZH = {
  'about.dir': '记忆目录',
  'about.title': '存储',
  'about.usage': '载入 {inject} 次 · 读取 {reads} · 写入 {writes} · 搜索 {searches}',
  'about.version': '插件版本 {v}',
  'banner.autoMemoryOff': '自动记忆已关闭：新会话不会载入记忆，智能体也不能保存记忆。',
  'banner.backendStale': '记忆插件的后台还在运行旧代码，和这个页面对不上：可信度标记、待处理详情等新功能会出错。请完全退出 DeepSeek Harness 再重新打开。',
  'banner.noBackend': '此页面连不上记忆服务。请刷新页面；如仍失败，检查插件是否已安装。',
  'banner.pluginOff': '记忆功能已关闭：不会载入、保存或 Dream 记忆。',
  'banner.tokenExpired': '与记忆服务的连接已失效，刷新页面即可重新连接。',
  'btn.back': '返回',
  'btn.cancel': '取消',
  'btn.clear': '清除搜索',
  'btn.close': '关闭',
  'btn.confirm': '再点一次确认',
  'btn.confirmDelete': '确认删除？',
  'btn.copy': '复制路径',
  'btn.delete': '删除',
  'btn.edit': '编辑',
  'btn.new': '新建',
  'btn.refresh': '刷新',
  'btn.reload': '刷新页面',
  'btn.retry': '重试',
  'btn.review': '去审阅',
  'btn.save': '保存',
  'btn.saving': '保存中…',
  'btn.turnOn': '开启',
  'chip.attention': '{n} 项待处理',
  'chip.label': '记忆',
  'chip.title': '本项目的记忆',
  'detail.changed': '核实之后又被改过。在 Dream 重新核实之前，它不会被新会话载入。',
  'detail.conflict': '冲突',
  'detail.created': '创建于 {time}',
  'detail.emptyBody': '这条记忆没有正文。',
  'detail.history': '修改记录',
  'detail.historyDream': 'Dream · {n} 项改动',
  'detail.historyEmpty': '还没有修改记录。',
  'detail.historyPending': '在待处理里等你确认',
  'detail.loading': '加载中…',
  'detail.missing': '这条记忆已不存在。',
  'detail.session': '来自会话 {id}',
  'detail.stale': '已标记为「{status}」：不参与召回，新会话也不会载入。',
  'detail.superseded': '旧值',
  'detail.unverifiedIndex': '还没有经过 Dream 核实。',
  'detail.updated': '更新于 {time}',
  'detail.verified': '{date} 已核实：Dream 用来源对话逐字核对过这段内容。',
  'edit.conflict': '另一个窗口先保存了这条笔记。你的草稿还在；刷新后可以看到较新的版本。',
  'edit.content': '详细内容',
  'edit.contentPlaceholder': '支持 Markdown。Ctrl+Enter 保存。',
  'edit.description': '一句话摘要',
  'edit.descriptionHint': '会出现在索引和搜索结果里。',
  'edit.editTitle': '编辑记忆',
  'edit.name': '名称',
  'edit.namePlaceholder': '例如：回复语言',
  'edit.nameRequired': '请填写名称。',
  'edit.newTitle': '新建记忆',
  'edit.reverifyHint': '这条笔记已核实。保存修改后，它会退出常驻，直到 Dream 重新核实。',
  'edit.type': '类型',
  'edit.typeHint.feedback': '你纠正过的地方、确认过的做法。',
  'edit.typeHint.project': '代码里看不出来的决定和进行中的工作。',
  'edit.typeHint.reference': '外部信息在哪里找。',
  'edit.typeHint.user': '你是谁、你的偏好。',
  'err.backendStale': '插件后台比页面旧，不认识这个请求。请完全退出 DeepSeek Harness 再重新打开。',
  'err.deleteDisabled': '插件配置关闭了删除（dreamAllowDelete）。',
  'err.evidenceRejected': '有改动缺少可核对的来源，整批都没有应用：',
  'err.locked': '另一次 Dream 正在进行，请稍后再试。',
  'err.more': '……还有 {n} 条',
  'err.stale': '方案生成后记忆又有改动，请重新生成方案。',
  'error.load': '无法加载记忆',
  'inbox.emptyBody': '现在没有需要你决定的事。',
  'inbox.emptyTitle': '都处理完了',
  'inbox.planBody': '在你切换过去之前，记忆不会有任何变化。',
  'inbox.planTitle': 'Dream 结果已就绪',
  'inbox.extractTitle': '有自动抽取的笔记待确认',
  'inbox.extractBody': '来自最近对话的 {n} 条建议笔记。接受后会走正常保存检查。',
  'inbox.accept': '全部接受',
  'inbox.discard': '放弃',
  'inbox.acceptFailed': '只保存了 {applied}/{total} 条，其余未通过检查。',
  'inbox.offTitle': '自动抽取未开启',
  'inbox.offBody': '在设置里开启后，最近对话里抽出的笔记会先出现在这里供你确认。',
  'inbox.emptyOffBody': '在设置里开启「自动抽取」，新笔记会先出现在这里，确认后才进入记忆。',
  'inbox.lastExtract': '上次尝试：{reason} · {time}',
  'inbox.commandHint': '也可以在对话里：/memory inbox accept <id>',
  'notice.inboxAccepted': '已接受 {n} 条笔记。',
  'notice.inboxDiscarded': '已放弃这条建议。',
  'list.emptyBody': '在对话里说「记住……」，或者自己新建一条。',
  'list.emptyTitle': '还没有记忆',
  'list.filterEmpty': '没有符合筛选条件的记忆。',
  'load.index': '新会话载入索引：{lines}/{maxLines} 行。',
  'load.indexOver': '新会话载入索引，但索引超出预算，末尾会被截掉。',
  'load.off': '新会话不载入记忆：自动记忆已关闭。',
  'load.recall': '相关笔记也会附在消息上。',
  'notes.appliesWhen': '适用条件',
  'notes.exception': '例外',
  'notes.observed': '观察记录',
  'notes.verify': '核对方法',
  'notice.copied': '路径已复制。',
  'notice.deleted': '已移到回收站，可在「设置」里恢复。',
  'notice.done': '已完成。',
  'notice.planDiscarded': '已放弃这个方案。',
  'notice.restored': '已恢复。',
  'notice.rulesReset': '已恢复默认规则。',
  'notice.rulesSaved': '规则已保存，下一次请求起生效。',
  'notice.saved': '已保存。',
  'notice.toggled': '已更新。',
  'readiness.backoff': '上次失败了，稍后会重试。',
  'readiness.lock': '正在 Dream 中。',
  'readiness.min-hours': '还没到 {hours} 小时的间隔。',
  'readiness.min-sessions': '已有 {current}/{required} 次对话。',
  'readiness.pending-proposal': '有一个方案在等你确认。',
  'readiness.throttle': '刚检查过，稍后会再检查。',
  'reason.mergeDependency': '它的内容本该并入一项不能应用的改动，删掉它会丢失这些内容。',
  'reason.noCitation': '新增的一行没有来源引用：「{line}」',
  'reason.noClaim': '引用对不上对话里任何已核实的原话。',
  'reason.unsupported': '这一行和它引用的原话说的不是一回事：「{line}」',
  'reason.userAttribution': '把要求说成是用户提的，但没有用户的原话。',
  'reason.userClass': '用户/反馈类笔记必须有用户亲手打的原话，转发的材料不算。',
  'restore.all': '全部恢复',
  'restore.backups': 'Dream 前备份',
  'restore.empty': '这里是空的。',
  'restore.files': '{n} 个文件',
  'restore.hint': '删除的记忆，以及每次 Dream 前留下的备份。',
  'restore.one': '恢复',
  'restore.title': '回收站与备份',
  'restore.trash': '回收站',
  'rules.count': '{n} / {max} 字符',
  'rules.hint': '可选：附加到每次请求的记忆指引，相当于记忆版的 CLAUDE.md。留空则不额外发送任何内容。',
  'rules.placeholder': '例如：\n- 记下部署命令和各服务的负责人。\n- 不要记一次性的调试步骤。',
  'rules.reset': '删除自定义规则',
  'rules.saveGlobal': '保存为全局',
  'rules.saveProject': '保存到本项目',
  'rules.source.default': '默认',
  'rules.source.global': '全局',
  'rules.source.project': '本项目',
  'rules.title': '记忆规则',
  'search.empty': '没有匹配「{q}」的记忆。',
  'search.placeholder': '搜索记忆',
  'settings.autoDream': '自动 Dream',
  'settings.autoDreamHint': '定期在后台 Dream 记忆。',
  'settings.autoExtract': '自动抽取',
  'settings.autoExtractHint': '每隔 {n} 轮让模型找值得记住的笔记，先放进「待确认」。',
  'settings.extractDirect': '每隔几轮，走正常检查后直接保存',
  'settings.perAgent': '子代理独立记忆',
  'settings.perAgentHint': '让子代理使用自己的记忆目录，而不是共享项目记忆。',
  'settings.perAgentOff': '关闭',
  'settings.perAgentOn': '所有带预设名的子代理',
  'settings.perAgentShared': '共享项目记忆（可读可写）',
  'settings.perAgentOnList': '仅：{names}',
  'settings.autoMemory': '自动记忆',
  'settings.autoMemoryHint': '新会话会载入记忆，智能体会自动保存值得记住的内容。',
  'settings.enabled': '记忆功能',
  'settings.enabledHint': '总开关：载入、保存和 Dream 记忆。',
  'settings.indexBudget': '索引大小',
  'settings.indexOver': '索引超出预算，末尾部分不会载入。Dream 可以压缩它。',
  'settings.loading': '新会话载入什么',
  'settings.loadingHint': '这里只做展示，要修改请改插件配置。',
  'settings.mode': '会话开始时',
  'settings.modeIndex': '完整索引 MEMORY.md',
  'settings.recall': '会话进行中',
  'settings.recallLexical': '只做词面匹配，不调用模型',
  'settings.recallModel': '模型选择器按每条消息挑最多五条',
  'settings.recallNone': '关闭，需要时由智能体自己搜索',
  'settings.recallOff': '不额外附加，智能体需要时自己搜索',
  'settings.recallOn': '和消息相关的笔记会附在消息上（autoRecall）',
  'settings.switches': '开关',
  'settings.switchesHint': '对所有项目生效。',
  'status.disputed': '有争议',
  'status.retired': '已停用',
  'status.review-needed': '待复核',
  'status.stale': '已过时',
  'status.superseded': '已被取代',
  'tab.inbox': '待处理',
  'tab.memories': '记忆',
  'tab.settings': '设置',
  'tab.tidy': 'Dream',
  'tidy.discard': '丢弃',
  'tidy.discarded': '已丢弃 Dream 的版本，记忆未改动',
  'tidy.estimateLine': '粗略估计：{tokens} / {limit} 输入 token。',
  'tidy.estimateNoLimit': '粗略估计：{tokens} 输入 token。',
  'tidy.estimateUnavailable': '暂时无法估算消耗，请重试后再开始 Dream。',
  'tidy.focus': '关注点（可选）',
  'tidy.focusPlaceholder': '例如：部署相关的笔记，或回复语言偏好',
  'tidy.generate': '估算这次运行',
  'tidy.historyTitle': '最近 Dream',
  'tidy.indexMeta': '{lines} / {maxLines} 行 · {bytes} / {maxBytes}',
  'tidy.intro': 'Dream 会读你的记忆和最近的对话，然后写出一份整理好的记忆副本。你不切换过去就不会有任何变化，切换后也能在「最近的 Dream」里切回。',
  'tidy.op.create': '新建',
  'tidy.op.delete': '删除',
  'tidy.op.index': '索引',
  'tidy.op.update': '修改',
  'tidy.opsCount': '{n} 项改动',
  'tidy.ready': '条件已满足，下一轮对话结束后会自动 Dream。',
  'tidy.resultCounts': '新增 {added}，修改 {changed}，删除 {removed}',
  'tidy.resultTitle': 'Dream 整理好了，等你决定',
  'tidy.runAlready': '这个项目已经有一次 Dream 在运行。',
  'tidy.runCancel': '停止',
  'tidy.runResume': '继续',
  'tidy.runStarted': 'Dream 已开始。你可以继续工作，运行结束后会出现新的副本。',
  'tidy.runState.blocked': '被阻断',
  'tidy.runState.cancelled': '已取消',
  'tidy.runState.cancelling': '正在取消',
  'tidy.runState.failed': '失败',
  'tidy.runState.idle': '空闲',
  'tidy.runState.running': '运行中',
  'tidy.runState.skipped': '已跳过',
  'tidy.runTitle': '本次运行',
  'tidy.start': '开始整理',
  'tidy.switch': '切换到这个版本',
  'tidy.switchConflict': 'Dream 运行期间记忆被改动：{files}',
  'tidy.switched': '记忆已切换为 Dream 的版本',
  'tidy.title': 'Dream：记忆整合',
  'tidy.undo': '撤销',
  'tidy.undoConflict': '这些文件在 Dream 后又被修改过，无法安全撤销：{files}',
  'tidy.undone': '已撤销，记忆恢复到 Dream 前。',
  'tidy.undoneTag': '已撤销',
  'time.days': '{n} 天前',
  'time.hours': '{n} 小时前',
  'time.justNow': '刚刚',
  'time.minutes': '{n} 分钟前',
  'trust.all': '全部状态',
  'trust.changed': '核实后改过',
  'trust.stale': '已过时',
  'trust.unverified': '未核实',
  'trust.verified': '已核实',
  'type.all': '全部',
  'type.feedback': '反馈',
  'type.project': '项目',
  'type.reference': '参考',
  'type.user': '用户',
  'via.agent': '由智能体保存',
  'via.command': '通过 /remember 保存',
  'via.import': '导入',
  'via.tidy': '由 Dream 写入',
  'via.you': '由你编辑',
  'view.title': '记忆',
  'tidy.started': 'Dream 已开始。你可以继续工作，运行结束后会出现新的副本。',
};

const DICTIONARIES = { en: EN, zh: ZH };
    /** Data contract this page expects from the backend (`/status.uiApi`). */
    const UI_API = 4;
    const MONO =
      'var(--ds-font-family-code,ui-monospace,"Cascadia Code",SFMono-Regular,Menlo,Consolas,monospace)';

    // -----------------------------------------------------------------------
    // Page CSS: host tokens (with literal fallbacks) mapped to a few local
    // variables, so light/dark follow the host theme automatically.
    // -----------------------------------------------------------------------
    const CSS = `
.ccm-root{
  --ccm-fg:var(--dsw-alias-label-primary,#0f1115);
  --ccm-fg2:var(--dsw-alias-label-secondary,#575c63);
  --ccm-fg3:var(--dsw-alias-label-tertiary,#8a8f96);
  --ccm-surface:var(--dsw-alias-bg-layer-1,#fff);
  --ccm-input:var(--dsw-alias-bg-base,#fff);
  --ccm-line:var(--dsw-alias-border-l1,rgba(0,0,0,.07));
  --ccm-line2:var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  --ccm-hover:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  --ccm-active:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1));
  --ccm-accent:var(--dsw-static-blue-500,#3b82f6);
  --ccm-ok:var(--dsw-static-green-500,#22c55e);
  --ccm-ok-fg:var(--dsw-static-green-600,#16a34a);
  --ccm-warn:var(--dsw-static-amber-500,#f59e0b);
  --ccm-warn-fg:var(--dsw-static-amber-600,#b45309);
  --ccm-danger:var(--dsw-alias-state-error-primary,#dc2626);
  --ccm-strong:var(--dsw-alias-button-primary-fill,#0f1115);
  --ccm-on-strong:var(--dsw-alias-label-primary-inverted,#fff);
  --ccm-link:var(--dsw-alias-text-link,var(--ccm-accent));
  position:relative;flex:1;min-height:0;height:100%;display:flex;flex-direction:column;overflow:hidden;
  font-family:inherit;font-size:13px;line-height:1.55;color:var(--ccm-fg);
  background:var(--dsw-alias-bg-module-platform,#f5f6f7);-webkit-font-smoothing:antialiased}
body[data-ds-dark-theme] .ccm-root{background:var(--dsw-alias-bg-base,#151517)}
.ccm-root *,.ccm-root *::before,.ccm-root *::after{box-sizing:border-box}
.ccm-root button,.ccm-root input,.ccm-root textarea{font:inherit;color:inherit}
.ccm-root :focus-visible{outline:2px solid var(--ccm-accent);outline-offset:2px}
.ccm-mono{font-family:${MONO}}
.ccm-spacer{flex:1}
.ccm-muted{color:var(--ccm-fg3)}

.ccm-headbar{flex:none;container-type:inline-size;border-bottom:1px solid var(--ccm-line)}
.ccm-scroll{flex:1;min-height:0;overflow:auto;container-type:inline-size}
.ccm-shell{max-width:1080px;margin:0 auto;padding:0 24px}
.ccm-scroll>.ccm-shell{padding:18px 24px 88px;display:flex;flex-direction:column;gap:16px}
.ccm-head{display:flex;align-items:flex-start;gap:12px;padding:18px 0 4px}
.ccm-head-main{flex:1;min-width:0}
.ccm-title{display:flex;align-items:baseline;gap:10px;margin:0;font-size:19px;font-weight:650;letter-spacing:-.015em;line-height:1.3}
.ccm-title-sub{font-size:12.5px;font-weight:500;color:var(--ccm-fg3);letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-load{display:flex;align-items:center;gap:7px;margin-top:5px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-load>svg{flex:none;color:var(--ccm-fg3)}
.ccm-load[data-tone=warn]>svg{color:var(--ccm-warn)}
.ccm-load-extra{color:var(--ccm-fg3)}
.ccm-tabs{display:flex;gap:2px;margin:8px -4px 0;overflow-x:auto;scrollbar-width:none}
.ccm-tabs::-webkit-scrollbar{display:none}
.ccm-tab{position:relative;flex:none;display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 12px;border:0;background:transparent;
  color:var(--ccm-fg2);font-size:13px;font-weight:550;cursor:pointer;border-radius:8px 8px 0 0;transition:color .15s,background .15s}
.ccm-tab:hover{color:var(--ccm-fg);background:var(--ccm-hover)}
.ccm-tab[aria-selected=true]{color:var(--ccm-fg)}
.ccm-tab[aria-selected=true]::after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--ccm-accent)}
.ccm-tab-n{font-size:11.5px;font-weight:500;color:var(--ccm-fg3);font-variant-numeric:tabular-nums}
.ccm-badge{min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--ccm-warn);color:#1b1206;
  font-size:10.5px;font-weight:700;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
.ccm-badge-dot{width:7px;height:7px;border-radius:99px;background:var(--ccm-warn)}

.ccm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 13px;border-radius:8px;
  border:1px solid var(--ccm-line2);background:var(--ccm-surface);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,opacity .15s,color .15s}
.ccm-btn:hover:not(:disabled){background:var(--ccm-hover)}
.ccm-btn:disabled{opacity:.45;cursor:not-allowed}
.ccm-btn svg{flex:none}
.ccm-btn-primary{background:var(--ccm-strong);border-color:transparent;color:var(--ccm-on-strong)!important}
.ccm-btn-primary:hover:not(:disabled){background:var(--ccm-strong);opacity:.86}
.ccm-btn-ghost{border-color:transparent;background:transparent;color:var(--ccm-fg2)!important}
.ccm-btn-danger{color:var(--ccm-danger)!important}
.ccm-btn-sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:7px}
.ccm-icon-btn{width:32px;padding:0}
.ccm-btn-sm.ccm-icon-btn{width:28px}
.ccm-armed{background:var(--ccm-warn)!important;border-color:transparent!important;color:#1b1206!important;opacity:1!important}
.ccm-armed-danger{background:var(--ccm-danger)!important;border-color:transparent!important;color:#fff!important;opacity:1!important}
.ccm-spinning svg{animation:ccm-spin .8s linear infinite}
.ccm-link{display:inline;padding:0;border:0;background:transparent;color:var(--ccm-link);cursor:pointer;text-decoration:underline;
  text-decoration-color:color-mix(in srgb,var(--ccm-link) 40%,transparent);text-underline-offset:2px}
.ccm-link:hover{text-decoration-color:currentColor}

.ccm-banner{display:flex;align-items:center;gap:10px;padding:10px 12px 10px 14px;border-radius:10px;font-size:12.5px;color:var(--ccm-fg2);
  background:color-mix(in srgb,var(--ccm-warn) 10%,var(--ccm-surface));border:1px solid color-mix(in srgb,var(--ccm-warn) 28%,transparent)}
.ccm-banner-error{background:color-mix(in srgb,var(--ccm-danger) 8%,var(--ccm-surface));border-color:color-mix(in srgb,var(--ccm-danger) 25%,transparent)}
.ccm-banner>svg{flex:none;color:var(--ccm-warn)}
.ccm-banner-error>svg{color:var(--ccm-danger)}
.ccm-banner-text{flex:1;min-width:0}

.ccm-card{background:var(--ccm-surface);border:1px solid var(--ccm-line);border-radius:12px;min-width:0}
.ccm-card-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;flex-wrap:wrap}
.ccm-card-title{font-size:14px;font-weight:620}
.ccm-card-sub{font-size:12px;color:var(--ccm-fg3)}
.ccm-card-text{margin:-4px 16px 12px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-card-body{padding:0 16px 16px}
.ccm-section{display:flex;align-items:baseline;gap:8px;margin:4px 2px -6px}
.ccm-section-title{font-size:12px;font-weight:650;color:var(--ccm-fg2);text-transform:none}
.ccm-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:99px;font-size:11px;font-weight:600;
  background:var(--ccm-hover);color:var(--ccm-fg2);white-space:nowrap}
.ccm-pill-warn{background:color-mix(in srgb,var(--ccm-warn) 18%,transparent);color:var(--ccm-warn-fg)}
.ccm-pill-ok{background:color-mix(in srgb,var(--ccm-ok) 15%,transparent);color:var(--ccm-ok-fg)}
.ccm-pill-accent{background:color-mix(in srgb,var(--ccm-accent) 13%,transparent);color:var(--ccm-accent)}
.ccm-pill-danger{background:color-mix(in srgb,var(--ccm-danger) 12%,transparent);color:var(--ccm-danger)}
.ccm-dot{width:8px;height:8px;border-radius:99px;flex:none;background:var(--ccm-type,var(--ccm-fg3))}
.ccm-tag{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:600;
  color:var(--ccm-type);background:color-mix(in srgb,var(--ccm-type) 12%,transparent)}
.ccm-tag .ccm-dot{width:6px;height:6px}
.ccm-trust{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap;
  color:var(--ccm-fg2);background:var(--ccm-hover)}
.ccm-trust svg{flex:none}
.ccm-trust[data-trust=verified]{color:var(--ccm-ok-fg);background:color-mix(in srgb,var(--ccm-ok) 14%,transparent)}
.ccm-trust[data-trust=changed]{color:var(--ccm-warn-fg);background:color-mix(in srgb,var(--ccm-warn) 16%,transparent)}
.ccm-trust[data-trust=stale]{color:var(--ccm-fg3);background:var(--ccm-hover);text-decoration:line-through;text-decoration-color:transparent}

.ccm-toolbar{display:flex;align-items:center;gap:8px}
.ccm-search{position:relative;flex:1;min-width:0;display:block}
.ccm-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);display:flex;color:var(--ccm-fg3);pointer-events:none}
.ccm-search .ccm-input{height:36px;padding-left:36px;padding-right:34px;border-radius:10px}
.ccm-search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;
  width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--ccm-fg3);cursor:pointer}
.ccm-search-clear:hover{background:var(--ccm-hover);color:var(--ccm-fg)}
.ccm-input,.ccm-textarea{width:100%;border:1px solid var(--ccm-line2);border-radius:8px;background:var(--ccm-input);outline:none;
  transition:border-color .15s,box-shadow .15s}
.ccm-input{height:34px;padding:0 11px;font-size:13px}
.ccm-textarea{display:block;min-height:150px;padding:10px 12px;resize:vertical;font-family:${MONO};font-size:12.5px;line-height:1.65}
.ccm-input:focus,.ccm-textarea:focus{border-color:var(--ccm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ccm-accent) 18%,transparent)}
.ccm-input::placeholder,.ccm-textarea::placeholder{color:var(--ccm-fg3)}
.ccm-input:disabled,.ccm-textarea:disabled{opacity:.6}
.ccm-checkline{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ccm-fg2);cursor:pointer}
.ccm-checkline input{width:15px;height:15px;margin:0;accent-color:var(--ccm-accent)}

.ccm-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ccm-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:99px;border:1px solid var(--ccm-line2);
  background:transparent;color:var(--ccm-fg2);font-size:12.5px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.ccm-chip:hover{background:var(--ccm-hover);color:var(--ccm-fg)}
.ccm-chip[aria-pressed=true]{background:var(--ccm-strong);border-color:transparent;color:var(--ccm-on-strong)}
.ccm-chip-n{font-variant-numeric:tabular-nums;opacity:.55}
.ccm-seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--ccm-hover);flex-wrap:wrap}
.ccm-seg button{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:0;border-radius:6px;background:transparent;
  color:var(--ccm-fg2);font-size:12px;cursor:pointer;white-space:nowrap}
.ccm-seg button[aria-pressed=true]{background:var(--ccm-surface);color:var(--ccm-fg);box-shadow:0 0 0 1px var(--ccm-line)}
.ccm-seg-n{font-variant-numeric:tabular-nums;color:var(--ccm-fg3)}

.ccm-split{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
.ccm-split.has-detail{grid-template-columns:minmax(260px,.85fr) minmax(0,1.35fr)}
.ccm-listpane{display:flex;flex-direction:column;gap:12px;min-width:0}
.ccm-rows{overflow:hidden}
.ccm-row{position:relative;display:flex;align-items:flex-start;gap:11px;width:100%;padding:12px 14px 12px 16px;border:0;border-top:1px solid var(--ccm-line);
  background:transparent;text-align:left;cursor:pointer;transition:background .12s}
.ccm-row:first-child{border-top:0}
.ccm-row:hover{background:var(--ccm-hover)}
.ccm-row[aria-current=true]{background:color-mix(in srgb,var(--ccm-accent) 8%,transparent);box-shadow:inset 3px 0 0 var(--ccm-accent)}
.ccm-row.is-stale .ccm-row-name{color:var(--ccm-fg2)}
.ccm-row>.ccm-dot{margin-top:6px}
.ccm-row-main{flex:1;min-width:0;display:block}
.ccm-row-name{display:block;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-row-desc{display:-webkit-box;margin-top:2px;font-size:12.5px;color:var(--ccm-fg2);-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ccm-row-snippet{display:block;margin-top:5px;padding:4px 8px;border-radius:6px;font-size:12px;color:var(--ccm-fg2);background:var(--ccm-hover);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-row-side{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:5px;margin-top:1px}
.ccm-row-time{font-size:11.5px;color:var(--ccm-fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.ccm-none{padding:28px 16px;text-align:center;font-size:12.5px;color:var(--ccm-fg3)}

.ccm-detail{position:sticky;top:0;display:flex;flex-direction:column;max-height:calc(var(--ccm-vh,100vh) - 36px);overflow:hidden}
.ccm-detail-bar{flex:none;display:flex;align-items:center;gap:6px;min-height:48px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--ccm-line)}
.ccm-detail-body{min-height:0;overflow:auto;padding:18px 20px 20px}
.ccm-detail .ccm-form{min-height:0;overflow:auto}
.ccm-detail-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ccm-detail-name{margin:10px 0 4px;font-size:18px;font-weight:650;letter-spacing:-.01em;line-height:1.35;overflow-wrap:anywhere}
.ccm-detail-desc{margin:0;font-size:13px;color:var(--ccm-fg2)}
.ccm-trustline{display:flex;align-items:flex-start;gap:9px;margin-top:14px;padding:10px 12px;border-radius:9px;font-size:12.5px;line-height:1.55;
  color:var(--ccm-fg2);background:var(--ccm-hover)}
.ccm-trustline>svg{flex:none;margin-top:2px}
.ccm-trustline[data-trust=verified]{background:color-mix(in srgb,var(--ccm-ok) 9%,transparent)}
.ccm-trustline[data-trust=verified]>svg{color:var(--ccm-ok-fg)}
.ccm-trustline[data-trust=changed]{background:color-mix(in srgb,var(--ccm-warn) 10%,transparent)}
.ccm-trustline[data-trust=changed]>svg{color:var(--ccm-warn-fg)}
.ccm-trustline-text{display:flex;flex-direction:column;gap:2px}
.ccm-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin-top:14px;padding:12px 14px;border-radius:9px;
  border:1px solid var(--ccm-line);font-size:12.5px}
.ccm-facts dt{font-weight:600;color:var(--ccm-fg3);white-space:nowrap}
.ccm-facts dd{margin:0;color:var(--ccm-fg);overflow-wrap:anywhere}
.ccm-callout{margin-top:12px;padding:10px 12px;border-radius:9px;font-size:12.5px;
  background:color-mix(in srgb,var(--ccm-danger) 7%,transparent);border:1px solid color-mix(in srgb,var(--ccm-danger) 20%,transparent)}
.ccm-callout-title{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-weight:650;color:var(--ccm-danger)}
.ccm-sub{margin-top:18px}
.ccm-sub-title{margin:0 0 6px;font-size:12px;font-weight:650;color:var(--ccm-fg3)}
.ccm-old{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.ccm-old li{padding:6px 10px;border-radius:7px;font-size:12.5px;color:var(--ccm-fg2);background:var(--ccm-hover)}
.ccm-old li s{text-decoration-color:color-mix(in srgb,var(--ccm-fg3) 70%,transparent)}
.ccm-meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:20px;padding-top:12px;border-top:1px solid var(--ccm-line);font-size:11.5px;color:var(--ccm-fg3)}
.ccm-inline-error{margin-top:14px;padding:9px 12px;border-radius:8px;font-size:12.5px;color:var(--ccm-danger);
  background:color-mix(in srgb,var(--ccm-danger) 8%,transparent)}
.ccm-only-narrow{display:none}

.ccm-md{margin-top:16px;font-size:13.5px;line-height:1.7;overflow-wrap:anywhere}
.ccm-md>:first-child{margin-top:0}
.ccm-md p{margin:0 0 10px}
.ccm-md ul,.ccm-md ol{margin:0 0 10px;padding-left:20px}
.ccm-md li{margin:2px 0}
.ccm-md .ccm-md-h{margin:16px 0 8px;font-size:14px;font-weight:650}
.ccm-md blockquote{margin:0 0 10px;padding:2px 12px;border-left:3px solid var(--ccm-line2);color:var(--ccm-fg2)}
.ccm-md code{font-family:${MONO};font-size:12px;padding:1px 5px;border-radius:5px;background:var(--ccm-hover)}
.ccm-md pre.ccm-code{margin:0 0 10px;padding:10px 12px;border-radius:8px;background:var(--ccm-hover);overflow:auto}
.ccm-md pre.ccm-code code{padding:0;background:transparent}
.ccm-md a{color:var(--ccm-link)}
.ccm-md hr{border:0;border-top:1px solid var(--ccm-line);margin:14px 0}
.ccm-cite{display:inline-flex;align-items:center;height:17px;margin:0 1px 0 3px;padding:0 5px;border-radius:5px;vertical-align:2px;
  font-family:${MONO};font-size:10.5px;line-height:17px;color:var(--ccm-fg3);background:var(--ccm-hover);cursor:help;white-space:nowrap;
  max-width:220px;overflow:hidden;text-overflow:ellipsis}
.ccm-wlink{display:inline;padding:0 2px;border:0;border-radius:4px;background:color-mix(in srgb,var(--ccm-accent) 9%,transparent);
  color:var(--ccm-link);font:inherit;cursor:pointer}
.ccm-wlink:hover{background:color-mix(in srgb,var(--ccm-accent) 16%,transparent)}
.ccm-wlink.is-dead{color:var(--ccm-danger);background:color-mix(in srgb,var(--ccm-danger) 8%,transparent);cursor:not-allowed}

.ccm-form{display:flex;flex-direction:column;gap:16px;padding:18px 20px 20px}
.ccm-field{display:flex;flex-direction:column;gap:6px}
.ccm-label{font-size:12px;font-weight:600;color:var(--ccm-fg2)}
.ccm-help{font-size:11.5px;color:var(--ccm-fg3)}
.ccm-form-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.ccm-hint-box{padding:9px 12px;border-radius:8px;font-size:12px;color:var(--ccm-warn-fg);
  background:color-mix(in srgb,var(--ccm-warn) 10%,transparent)}

.ccm-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:44px 24px}
.ccm-empty-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;margin-bottom:4px;border-radius:14px;
  background:color-mix(in srgb,var(--ccm-accent) 10%,transparent);color:var(--ccm-accent)}
.ccm-empty-icon.is-ok{background:color-mix(in srgb,var(--ccm-ok) 12%,transparent);color:var(--ccm-ok-fg)}
.ccm-empty-title{font-size:15px;font-weight:650}
.ccm-empty-text{max-width:440px;font-size:12.5px;line-height:1.65;color:var(--ccm-fg2)}
.ccm-empty .ccm-btn{margin-top:8px}

.ccm-inbox-item{border-top:1px solid var(--ccm-line);padding:14px 16px}
.ccm-inbox-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ccm-inbox-name{font-size:13.5px;font-weight:620;min-width:0;overflow-wrap:anywhere}
.ccm-inbox-desc{margin-top:4px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-reasons{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.ccm-reasons li{display:flex;gap:8px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-reasons li>svg{flex:none;margin-top:3px;color:var(--ccm-warn)}
.ccm-inbox-foot{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap}
.ccm-plan-cta{display:flex;align-items:center;gap:14px;padding:16px;
  background:color-mix(in srgb,var(--ccm-accent) 5%,var(--ccm-surface));border-color:color-mix(in srgb,var(--ccm-accent) 22%,transparent)}
.ccm-plan-cta .ccm-empty-icon{margin:0;flex:none;width:40px;height:40px;border-radius:12px}

.ccm-steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 2px}
.ccm-step{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:550;color:var(--ccm-fg3)}
.ccm-step-n{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:99px;font-size:11px;font-weight:700;
  border:1.5px solid var(--ccm-line2);color:var(--ccm-fg3);font-variant-numeric:tabular-nums}
.ccm-step[data-state=current]{color:var(--ccm-fg)}
.ccm-step[data-state=current] .ccm-step-n{border-color:var(--ccm-accent);background:var(--ccm-accent);color:#fff}
.ccm-step[data-state=done] .ccm-step-n{border-color:var(--ccm-ok);color:var(--ccm-ok-fg)}
.ccm-step-line{width:22px;height:1.5px;border-radius:2px;background:var(--ccm-line2)}

.ccm-hero{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:22px}
.ccm-hero .ccm-empty-icon{margin-bottom:6px}
.ccm-hero-title{font-size:16px;font-weight:650}
.ccm-hero-text{margin:0 0 6px;max-width:640px;font-size:13px;line-height:1.65;color:var(--ccm-fg2)}
.ccm-hero .ccm-field{width:100%;max-width:520px}
.ccm-progress{position:relative;width:100%;height:3px;border-radius:99px;background:var(--ccm-hover);overflow:hidden}
.ccm-progress::after{content:'';position:absolute;top:0;bottom:0;left:0;width:35%;border-radius:inherit;background:var(--ccm-accent);
  animation:ccm-slide 1.3s ease-in-out infinite}
.ccm-big{font-size:26px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.ccm-plan-summary{margin:-2px 16px 12px;font-size:13px;line-height:1.6;color:var(--ccm-fg2)}
.ccm-coverage{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 16px 12px}
.ccm-op{border-top:1px solid var(--ccm-line)}
.ccm-op-row{display:flex;align-items:center;gap:10px;padding:9px 12px 9px 16px}
.ccm-op.is-muted .ccm-op-row{opacity:.55}
.ccm-op.is-refused .ccm-op-file{color:var(--ccm-fg3)}
.ccm-check{display:flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;padding:0;border-radius:5px;
  border:1.5px solid var(--ccm-line2);background:var(--ccm-input);color:#fff;cursor:pointer;transition:background .12s,border-color .12s}
.ccm-check[aria-checked=true]{background:var(--ccm-accent);border-color:var(--ccm-accent)}
.ccm-check:disabled{cursor:not-allowed;opacity:.5}
.ccm-opkind{flex:none;min-width:40px;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:650;line-height:20px;text-align:center;
  color:var(--ccm-k);background:color-mix(in srgb,var(--ccm-k) 13%,transparent)}
.ccm-opkind[data-kind=create]{--ccm-k:var(--ccm-ok-fg)}
.ccm-opkind[data-kind=update]{--ccm-k:var(--ccm-accent)}
.ccm-opkind[data-kind=delete]{--ccm-k:var(--ccm-danger)}
.ccm-opkind[data-kind=index]{--ccm-k:var(--ccm-fg3)}
.ccm-op-toggle{display:flex;align-items:center;gap:10px;flex:1;min-width:0;height:28px;padding:0 6px;border:0;border-radius:6px;
  background:transparent;text-align:left;cursor:pointer}
.ccm-op-toggle:hover{background:var(--ccm-hover)}
.ccm-op-file{flex:1;min-width:0;font-family:${MONO};font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-op-delta{flex:none;font-size:11.5px;color:var(--ccm-fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.ccm-chev{display:flex;flex:none;color:var(--ccm-fg3);transition:transform .15s}
.ccm-chev.is-open{transform:rotate(90deg)}
.ccm-diff{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:2px 16px 14px 44px}
.ccm-diff-wide{grid-column:1 / -1}
.ccm-diff-label{margin-bottom:4px;font-size:11px;font-weight:650;color:var(--ccm-fg3)}
.ccm-pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--ccm-hover);font-family:${MONO};font-size:12px;line-height:1.6;
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;color:var(--ccm-fg2)}
.ccm-pre-after{background:color-mix(in srgb,var(--ccm-ok) 9%,transparent);color:var(--ccm-fg)}
.ccm-pre-removed{background:color-mix(in srgb,var(--ccm-danger) 7%,transparent)}
.ccm-quotes{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.ccm-quotes li{padding:6px 10px;border-left:3px solid color-mix(in srgb,var(--ccm-accent) 45%,transparent);border-radius:0 7px 7px 0;
  background:var(--ccm-hover);font-size:12px;color:var(--ccm-fg2)}
.ccm-quotes q{display:block;color:var(--ccm-fg);quotes:none}
.ccm-notes{display:flex;flex-direction:column;gap:4px;padding:10px 16px 0;border-top:1px solid var(--ccm-line)}
.ccm-note{font-size:12px;color:var(--ccm-fg3)}
.ccm-note-error{color:var(--ccm-danger)}
.ccm-note-warn{color:var(--ccm-warn-fg)}
.ccm-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--ccm-line)}

.ccm-setting{display:flex;align-items:center;gap:16px;padding:14px 16px;border-top:1px solid var(--ccm-line)}
.ccm-setting:first-child{border-top:0}
.ccm-setting-text{flex:1;min-width:0}
.ccm-setting-name{font-size:13.5px;font-weight:550}
.ccm-setting-hint{margin-top:2px;font-size:12px;color:var(--ccm-fg3)}
.ccm-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0;border-radius:99px;background:var(--ccm-line2);cursor:pointer;
  transition:background .18s}
.ccm-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:99px;background:#fff;
  box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .18s}
.ccm-switch[aria-checked=true]{background:var(--ccm-ok)}
.ccm-switch[aria-checked=true]::after{transform:translateX(16px)}
.ccm-switch:disabled{opacity:.45;cursor:not-allowed}
.ccm-kv{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:10px 18px;padding:2px 16px 16px;font-size:12.5px}
.ccm-kv dt{color:var(--ccm-fg3);font-weight:600}
.ccm-kv dd{margin:0;color:var(--ccm-fg);min-width:0}
.ccm-meter{height:6px;margin-top:6px;border-radius:99px;background:var(--ccm-hover);overflow:hidden}
.ccm-meter>span{display:block;height:100%;border-radius:inherit;background:var(--ccm-accent);transition:width .3s}
.ccm-meter.is-warn>span{background:var(--ccm-warn)}
.ccm-meter.is-over>span{background:var(--ccm-danger)}
.ccm-hist{display:flex;align-items:center;gap:12px;padding:11px 16px;border-top:1px solid var(--ccm-line)}
.ccm-fold{display:flex;align-items:center;gap:10px;width:100%;padding:12px 16px;border:0;border-top:1px solid var(--ccm-line);
  background:transparent;text-align:left;cursor:pointer;font-size:13px;font-weight:550}
.ccm-fold:hover{background:var(--ccm-hover)}
.ccm-fold-inline{padding:6px 0;border-top:0;font-size:12px;font-weight:650;color:var(--ccm-fg3);background:transparent!important}
.ccm-fold-inline:hover{color:var(--ccm-fg)}
.ccm-batch{padding:0 16px 4px 40px}
.ccm-batch-head{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--ccm-line)}
.ccm-batch-file{display:flex;align-items:center;gap:8px;padding:4px 0 4px 18px;font-size:12px}
.ccm-batch-file .ccm-mono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ccm-fg2)}
.ccm-timeline{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.ccm-timeline li{display:flex;gap:10px;padding:5px 0;font-size:12px;color:var(--ccm-fg2)}
.ccm-timeline time{flex:none;min-width:112px;color:var(--ccm-fg3);font-variant-numeric:tabular-nums}
.ccm-path{display:flex;align-items:center;gap:6px;margin-top:6px}
.ccm-path code{flex:1;min-width:0;padding:7px 10px;border-radius:8px;background:var(--ccm-hover);font-family:${MONO};font-size:12px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.ccm-domain{padding:10px 16px 4px;font-size:11px;font-weight:700;color:var(--ccm-fg3);letter-spacing:.02em;text-transform:uppercase;
  border-top:1px solid var(--ccm-line)}
.ccm-domain:first-child{border-top:0}
.ccm-domain+.ccm-row{border-top:0}

.ccm-skel-row{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-top:1px solid var(--ccm-line)}
.ccm-skel-row:first-child{border-top:0}
.ccm-skel-lines{flex:1;display:flex;flex-direction:column;gap:8px}
.ccm-skel{display:block;height:10px;border-radius:6px;background:var(--ccm-hover);animation:ccm-pulse 1.4s ease-in-out infinite}
.ccm-skel-dot{width:8px;height:8px;border-radius:99px;margin-top:2px}

.ccm-toast-dock{position:absolute;left:0;right:0;bottom:20px;display:flex;justify-content:center;padding:0 16px;pointer-events:none;z-index:5}
.ccm-toast{display:flex;align-items:flex-start;gap:8px;max-width:620px;padding:9px 8px 9px 14px;border-radius:10px;pointer-events:auto;
  background:var(--ccm-strong);color:var(--ccm-on-strong);font-size:12.5px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.2);
  animation:ccm-pop .18s ease-out}
.ccm-toast>svg{flex:none;margin-top:2px}
.ccm-toast-error{background:var(--ccm-danger);color:#fff}
.ccm-toast-body{flex:1;min-width:0;max-height:40vh;overflow:auto;overflow-wrap:anywhere}
.ccm-toast.has-items .ccm-toast-title{font-weight:650}
.ccm-toast-items{margin:6px 0 2px;padding-left:16px;display:flex;flex-direction:column;gap:4px}
.ccm-toast-close{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;
  background:transparent;color:inherit;opacity:.75;cursor:pointer}
.ccm-toast-close:hover{opacity:1;background:rgba(255,255,255,.16)}

@keyframes ccm-spin{to{transform:rotate(360deg)}}
@keyframes ccm-slide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
@keyframes ccm-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes ccm-pop{from{transform:translateY(8px)}to{transform:none}}
@media (prefers-reduced-motion:reduce){.ccm-root *{animation:none!important;transition:none!important}}

@container (max-width:760px){
  .ccm-shell{padding:0 16px}
  .ccm-scroll>.ccm-shell{padding:14px 16px 80px}
  .ccm-head{padding-top:14px}
  .ccm-split.has-detail{grid-template-columns:minmax(0,1fr)}
  .ccm-split.has-detail .ccm-listpane{display:none}
  .ccm-detail{position:static;max-height:none}
  .ccm-detail-body,.ccm-detail .ccm-form{overflow:visible}
  .ccm-only-narrow{display:inline-flex}
  .ccm-only-wide{display:none}
  .ccm-diff{padding-left:16px;grid-template-columns:minmax(0,1fr)}
  .ccm-kv{grid-template-columns:minmax(0,1fr);gap:2px 0}
  .ccm-kv dd{margin-bottom:8px}
}
`;

    /** The composer chip renders outside the page, so it carries its own CSS. */
    const CHIP_CSS = `
.ccm-chip-dock{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:99px;font-size:12px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#575c63);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ccm-chip-dot{width:6px;height:6px;border-radius:99px;background:var(--dsw-alias-label-tertiary,#9aa0a6)}
.ccm-chip-dot[data-on=true]{background:var(--dsw-static-green-500,#22c55e)}
.ccm-chip-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8a8f96)}
.ccm-chip-alert{font-weight:600;color:var(--dsw-static-amber-600,#b45309)}
`;

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------
    function formatBytes(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      if (bytes < 1024) return Math.round(bytes) + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    /** Short local timestamp: `2026-11-07 01:20`. */
    function formatTime(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const date = new Date(ms);
      return (
        date.getFullYear() +
        '-' +
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        ' ' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      );
    }

    function formatError(error) {
      if (error === null || error === undefined) return 'unknown error';
      if (typeof error === 'string') return error;
      if (typeof error === 'object') {
        if (typeof error.message === 'string' && error.message !== '') return error.message;
        try {
          return JSON.stringify(error);
        } catch {
          return 'unprintable error';
        }
      }
      try {
        return String(error);
      } catch {
        return 'unprintable error';
      }
    }

    function asNumber(value, fallback = 0) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function isEntryLike(entry) {
      return Boolean(entry && typeof entry === 'object' && typeof entry.file === 'string');
    }

    /**
     * Normalize one memory entry, preserving the v7 provenance fields
     * (`via`, `sourceSession`, `created`) and the v21 trust facts
     * (`status`, `current`, `verified`, `verifiedOutdated`, `hot`).
     */
    function normalizeEntry(entry) {
      const meta = entry && typeof entry === 'object' ? entry : {};
      const verified =
        meta.verified && typeof meta.verified === 'object'
          ? {
              date: typeof meta.verified.date === 'string' ? meta.verified.date : '',
              source: typeof meta.verified.source === 'string' ? meta.verified.source : '',
            }
          : null;
      return {
        ...meta,
        file: typeof meta.file === 'string' ? meta.file : '',
        name: typeof meta.name === 'string' ? meta.name : '',
        description: typeof meta.description === 'string' ? meta.description : '',
        type: typeof meta.type === 'string' ? meta.type : 'user',
        modified: typeof meta.modified === 'string' ? meta.modified : '',
        bytes: asNumber(meta.bytes, 0),
        lines: asNumber(meta.lines, 0),
        via: typeof meta.via === 'string' ? meta.via : '',
        sourceSession: typeof meta.sourceSession === 'string' ? meta.sourceSession : '',
        created: typeof meta.created === 'string' ? meta.created : '',
        status: typeof meta.status === 'string' ? meta.status.toLowerCase() : '',
        current: meta.current !== false,
        verified,
        verifiedOutdated: meta.verifiedOutdated === true,
      };
    }

    /** Normalize one model usage object; only totalTokens is surfaced. */
    function normalizeUsage(value) {
      if (!value || typeof value !== 'object') return null;
      const totalTokens = asNumber(value.totalTokens ?? value.total_tokens, 0);
      if (totalTokens <= 0) return null;
      return { totalTokens };
    }

    /**
     * Normalize the v8 metrics summary from `/status.metrics`.
     * Shape: `{since, updatedAt, injections:{count,lastAt},
     * reads:{total,top:[{file,reads}],neverRead:[]}, writes:{total},
     * searches:{count,hits}, dreams:{proposed,applied,rejected,failed,
     * acceptanceRate,appliedOps}, costs:{lastDurationMs,lastInputChars,
     * lastOutputChars,lastUsage:{totalTokens}|null}}`.
     */
    function normalizeMetrics(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      // `/status` pins `inject`; the raw `.metrics.json` summary uses
      // `injections` — accept either and expose both names downstream.
      const inject =
        record.injections && typeof record.injections === 'object'
          ? record.injections
          : record.inject && typeof record.inject === 'object'
            ? record.inject
            : {};
      const reads = record.reads && typeof record.reads === 'object' ? record.reads : {};
      const writes = record.writes && typeof record.writes === 'object' ? record.writes : {};
      const searches = record.searches && typeof record.searches === 'object' ? record.searches : {};
      const dreams = record.dreams && typeof record.dreams === 'object' ? record.dreams : {};
      const costs = record.costs && typeof record.costs === 'object' ? record.costs : {};
      const top = Array.isArray(reads.top)
        ? reads.top
            .filter((entry) => entry && typeof entry === 'object' && typeof entry.file === 'string')
            .map((entry) => ({ file: entry.file, reads: asNumber(entry.reads, 0) }))
            .slice(0, 20)
        : [];
      const neverRead = Array.isArray(reads.neverRead)
        ? reads.neverRead.filter((file) => typeof file === 'string').slice(0, 20)
        : [];
      const applied = asNumber(dreams.applied, 0);
      const rejected = asNumber(dreams.rejected, 0);
      const considered = applied + rejected;
      // The host summary reports 0 for "no decisions yet"; display treats that
      // as "no rate" so the card can show a dash instead of a misleading 0%.
      let acceptanceRate = null;
      if (considered > 0) {
        acceptanceRate = Number.isFinite(Number(dreams.acceptanceRate))
          ? Math.max(0, Math.min(1, Number(dreams.acceptanceRate)))
          : applied / considered;
      }
      const injectBlock = { count: asNumber(inject.count, 0), lastAt: asNumber(inject.lastAt, 0) };
      const metrics = {
        since: asNumber(record.since, 0),
        updatedAt: asNumber(record.updatedAt, 0),
        inject: injectBlock,
        injections: injectBlock,
        reads: { total: asNumber(reads.total, 0), top, neverRead },
        writes: { total: asNumber(writes.total, 0) },
        searches: { count: asNumber(searches.count, 0), hits: asNumber(searches.hits, 0) },
        dreams: {
          proposed: asNumber(dreams.proposed, 0),
          applied,
          rejected,
          failed: asNumber(dreams.failed, 0),
          acceptanceRate,
          appliedOps: asNumber(dreams.appliedOps, 0),
        },
        costs: {
          lastDurationMs: asNumber(costs.lastDurationMs, 0),
          lastInputChars: asNumber(costs.lastInputChars, 0),
          lastOutputChars: asNumber(costs.lastOutputChars, 0),
          lastUsage: normalizeUsage(costs.lastUsage),
        },
      };
      metrics.hasData =
        metrics.injections.count > 0 ||
        metrics.reads.total > 0 ||
        metrics.writes.total > 0 ||
        metrics.searches.count > 0 ||
        metrics.dreams.proposed > 0 ||
        metrics.dreams.applied > 0 ||
        metrics.costs.lastDurationMs > 0 ||
        metrics.updatedAt > 0;
      metrics.trend = normalizeTrend(record.trend ?? record.daily ?? null);
      metrics.quality = normalizeQuality(record.quality ?? null);
      return metrics;
    }

    /** Normalize the `rules` fragment shared by /status, /rules and /memory json. */
    function normalizeRules(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      return {
        text: typeof record.text === 'string' ? record.text : '',
        source: typeof record.source === 'string' && record.source !== '' ? record.source : 'default',
        projectPath: typeof record.projectPath === 'string' ? record.projectPath : '',
        globalPath: typeof record.globalPath === 'string' ? record.globalPath : '',
        maxChars: asNumber(record.maxChars, 0),
      };
    }


    /** v9: dream readiness `{eligible,nextEligibleAt,reasons,gates}`. */
    function normalizeReadiness(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const gates = record.gates && typeof record.gates === 'object' ? record.gates : {};
      const reasons = Array.isArray(record.reasons)
        ? record.reasons
            .filter((reason) => reason && typeof reason === 'object')
            .map((reason) => ({
              code: typeof reason.code === 'string' ? reason.code : 'unknown',
              message: typeof reason.message === 'string' ? reason.message : '',
            }))
        : [];
      const minHours =
        gates.minHours && typeof gates.minHours === 'object'
          ? { ok: Boolean(gates.minHours.ok), remainingMs: asNumber(gates.minHours.remainingMs, 0) }
          : null;
      const minSessions =
        gates.minSessions && typeof gates.minSessions === 'object'
          ? {
              ok: Boolean(gates.minSessions.ok),
              current: asNumber(gates.minSessions.current, 0),
              required: asNumber(gates.minSessions.required, 0),
            }
          : null;
      return {
        eligible: record.eligible === true,
        nextEligibleAt: asNumber(record.nextEligibleAt, 0),
        reasons,
        gates: {
          auto: Boolean(gates.auto),
          minHours,
          minSessions,
          throttleMs: asNumber(gates.throttleMs, 0),
          pendingSwitch: Boolean(gates.pendingSwitch),
          lock: Boolean(gates.lock),
        },
      };
    }

    /** v9: memory health `{score,dimensions,suggestions}` (score null = unknown). */
    function normalizeHealth(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const dimensionsRaw = record.dimensions && typeof record.dimensions === 'object' ? record.dimensions : {};
      const dimensions = {};
      for (const [key, value] of Object.entries(dimensionsRaw)) {
        if (typeof key === 'string') dimensions[key] = asNumber(value, 0);
      }
      const suggestions = Array.isArray(record.suggestions)
        ? record.suggestions
            .filter((suggestion) => suggestion && typeof suggestion === 'object')
            .map((suggestion) => ({
              code: typeof suggestion.code === 'string' ? suggestion.code : '',
              message: typeof suggestion.message === 'string' ? suggestion.message : '',
            }))
        : [];
      const rawScore = record.score;
      const score =
        rawScore === undefined || rawScore === null || !Number.isFinite(Number(rawScore))
          ? null
          : Math.max(0, Math.min(100, Math.round(Number(rawScore))));
      return { score, dimensions, suggestions };
    }

    /** v10: per-day metrics trend (`[{date,injections,reads,writes,searches,dreams,adopted}]`). */
    function normalizeTrend(raw) {
      const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? raw.trend ?? raw.days : null;
      const list = Array.isArray(source) ? source : [];
      const days = list
        .filter((day) => day && typeof day === 'object')
        .map((day) => {
          const dreams = day.dreams && typeof day.dreams === 'object' ? day.dreams : {};
          return {
            date: typeof day.date === 'string' ? day.date : typeof day.day === 'string' ? day.day : '',
            injections: asNumber(day.injections, 0),
            reads: asNumber(day.reads, 0),
            writes: asNumber(day.writes, 0),
            searches: asNumber(day.searches, 0),
            adopted: asNumber(day.adopted, 0),
            dreams: {
              proposed: asNumber(dreams.proposed, 0),
              applied: asNumber(dreams.applied, 0),
              rejected: asNumber(dreams.rejected, 0),
              failed: asNumber(dreams.failed, 0),
            },
          };
        })
        .filter((day) => day.date !== '')
        .slice(-31);
      return { days };
    }

    /** v10: dream quality `{appliedOps,planOps,dropped,rollbacks}` + derived rates. */
    function normalizeQuality(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const appliedOps = asNumber(record.appliedOps, 0);
      const planOps = asNumber(record.planOps, 0);
      const dropped = asNumber(record.dropped, 0);
      const rollbacks = asNumber(record.rollbacks, 0);
      return {
        appliedOps,
        planOps,
        dropped,
        rollbacks,
        applyRate: planOps > 0 ? Math.max(0, Math.min(1, (planOps - dropped) / planOps)) : null,
        droppedRate: planOps > 0 ? Math.max(0, Math.min(1, dropped / planOps)) : null,
      };
    }

    /** GET /dream-history: `{items:[{ts,appliedAt,ops,summary,files,undoable,undone}]}`, newest first. */
    function normalizeDreamHistory(raw) {
      const list = raw && Array.isArray(raw.items) ? raw.items : [];
      const items = list
        .filter((item) => item && typeof item === 'object' && typeof item.ts === 'string' && item.ts !== '')
        .map((item) => ({
          ts: item.ts,
          appliedAt: asNumber(item.appliedAt, 0),
          ops: asNumber(item.ops, 0),
          summary: typeof item.summary === 'string' ? item.summary : '',
          files: Array.isArray(item.files) ? item.files.filter((name) => typeof name === 'string') : [],
          undoable: item.undoable === true,
          undone: item.undone === true,
        }));
      return { items };
    }

    /** v10: ranked search `{query,total,items:[{file,name,description,type,score,snippets}]}`. */
    function normalizeSearch(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const source = record.result && typeof record.result === 'object' ? record.result : record;
      const list = Array.isArray(source.items) ? source.items : Array.isArray(source.results) ? source.results : [];
      const items = list
        .filter((item) => item && typeof item === 'object' && typeof item.file === 'string')
        .map((item) => ({
          file: item.file,
          name: typeof item.name === 'string' ? item.name : '',
          description: typeof item.description === 'string' ? item.description : '',
          type: typeof item.type === 'string' ? item.type : 'user',
          score: asNumber(item.score, 0),
          snippets: Array.isArray(item.snippets)
            ? item.snippets
                .map((snippet) => (typeof snippet === 'string' ? snippet : snippet && typeof snippet.text === 'string' ? snippet.text : ''))
                .filter((snippet) => snippet !== '')
            : [],
          via: typeof item.via === 'string' ? item.via : '',
          sourceSession: typeof item.sourceSession === 'string' ? item.sourceSession : '',
        }));
      return { query: typeof source.query === 'string' ? source.query : '', total: asNumber(source.total, items.length), items };
    }

    /** Normalize a /status payload (HTTP API and the command fallback share it). */
    /** A dream result waiting for the human to switch to it or discard it. */
function normalizePendingSwitch(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.dir !== 'string' || raw.dir === '') return null;
  const files = Array.isArray(raw.files)
    ? raw.files
        .filter((item) => item && typeof item.file === 'string' && item.file !== '')
        .map((item) => ({
          file: item.file,
          action: item.action === 'added' || item.action === 'removed' ? item.action : 'changed',
        }))
    : [];
  const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
  const counted = (name, action) => {
    const value = Number(counts[name]);
    if (Number.isFinite(value) && value >= 0) return value;
    return files.filter((item) => item.action === action).length;
  };
  return {
    dir: raw.dir,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    runId: typeof raw.runId === 'string' ? raw.runId : '',
    added: counted('added', 'added'),
    changed: counted('changed', 'changed'),
    removed: counted('removed', 'removed'),
    files,
  };
}

function normalizeStatus(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const config = record.config && typeof record.config === 'object' ? record.config : {};
      const stateRecord = record.state && typeof record.state === 'object' ? record.state : {};
      return {
        project: record.project && typeof record.project === 'object' ? record.project : {},
        config: {
          enabled: config.enabled !== false,
          autoMemoryEnabled: config.autoMemoryEnabled !== false,
          autoDreamEnabled: Boolean(config.autoDreamEnabled),
          dreamMode: config.dreamMode === 'review' ? 'review' : 'apply',
          indexMaxLines: asNumber(config.indexMaxLines, 0),
          indexMaxBytes: asNumber(config.indexMaxBytes, 0),
          dreamAllowDelete: Boolean(config.dreamAllowDelete),
          minHours: asNumber(config.minHours, 0),
          minSessions: asNumber(config.minSessions, 0),
          dreamMaxTotalTokens: asNumber(config.dreamMaxTotalTokens, 0),
          dreamCostMode:
            config.dreamCostMode === 'review' || config.dreamCostMode === 'block'
              ? config.dreamCostMode
              : 'warn',
            dreamPipeline: 'v2',
          injectHotOnly: config.injectHotOnly === true,
          injectHotEntries: asNumber(config.injectHotEntries, 3),
          recallMode: config.recallMode === 'off' || config.recallMode === 'model' ? config.recallMode : 'model',
          autoExtract: config.autoExtract === true,
          autoExtractEveryTurns: asNumber(config.autoExtractEveryTurns, 3),
          autoExtractMaxItems: asNumber(config.autoExtractMaxItems, 3),
          subagentMemory:
            config.subagentMemory === 'shared' || config.subagentMemory === 'own' ? config.subagentMemory : 'off',
          agentMemoryPresets: Array.isArray(config.agentMemoryPresets)
            ? config.agentMemoryPresets.filter((name) => typeof name === 'string')
            : [],
        },
        version: typeof record.version === 'string' ? record.version : '',
        uiApi: asNumber(record.uiApi, 0),
        build:
          record.build && typeof record.build === 'object'
            ? {
                id: typeof record.build.id === 'string' ? record.build.id : '',
                packageVersion:
                  typeof record.build.packageVersion === 'string' ? record.build.packageVersion : '',
              }
            : null,
        capabilities:
          record.capabilities && typeof record.capabilities === 'object'
            ? {
                dreamPipeline:
                  record.capabilities.dreamPipeline === 'v2' ? 'v2' : 'classic',
                dreamRuns: record.capabilities.dreamRuns === true,
                claimMerge: record.capabilities.claimMerge === true,
                explicitSaveLedger: record.capabilities.explicitSaveLedger === true,
              }
            : null,
        // Resumable Dream runs (newest first). The panel needs the run id, the
        // part counts and the failure text to offer stop/continue.
        dreamRuns: Array.isArray(record.dreamRuns)
          ? record.dreamRuns
              .filter((run) => run && typeof run === 'object')
              .map((run) => ({
                runId: typeof run.runId === 'string' ? run.runId : '',
                status: typeof run.status === 'string' ? run.status : '',
                stage: typeof run.stage === 'string' ? run.stage : '',
                error: typeof run.error === 'string' ? run.error : '',
                blockedReason: typeof run.blockedReason === 'string' ? run.blockedReason : '',
                planPath: typeof run.planPath === 'string' ? run.planPath : '',
                counts: {
                  done: asNumber(run.counts?.done, 0),
                  failed: asNumber(run.counts?.failed, 0),
                  pending: asNumber(run.counts?.pending, 0),
                },
                input: { expectedUnits: asNumber(run.input?.expectedUnits, 0) },
              }))
          : [],
        injection: (() => {
          const injection = record.injection && typeof record.injection === 'object' ? record.injection : {};
          return {
            recallMode: injection.recallMode === 'off' || injection.recallMode === 'model' ? injection.recallMode : 'model',
            autoExtract: injection.autoExtract === undefined ? config.autoExtract === true : injection.autoExtract === true,
            subagentMemory:
              injection.subagentMemory === 'shared' || injection.subagentMemory === 'own'
                ? injection.subagentMemory
                : config.subagentMemory,
          };
        })(),
        overrides: record.overrides && typeof record.overrides === 'object' ? record.overrides : {},
        index:
          record.index && typeof record.index === 'object'
            ? {
                text: typeof record.index.text === 'string' ? record.index.text : '',
                lines: asNumber(record.index.lines, 0),
                bytes: asNumber(record.index.bytes, 0),
                truncated: Boolean(record.index.truncated),
                overflow: Boolean(record.index.overflow),
              }
            : { text: '', lines: 0, bytes: 0, truncated: false, overflow: false },
        entries: Array.isArray(record.entries) ? record.entries.filter(isEntryLike).map(normalizeEntry) : [],
        inbox: (() => {
          const value = record.inbox && typeof record.inbox === 'object' ? record.inbox : {};
          const items = Array.isArray(value.items)
            ? value.items
                .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
                .map((item) => ({
                  id: item.id,
                  createdAt: asNumber(item.createdAt, 0),
                  sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
                  cwd: typeof item.cwd === 'string' ? item.cwd : '',
                  trigger: typeof item.trigger === 'string' ? item.trigger : '',
                  model: typeof item.model === 'string' ? item.model : '',
                  status: typeof item.status === 'string' ? item.status : 'pending',
                  count: asNumber(item.count, Array.isArray(item.items) ? item.items.length : 0),
                  items: Array.isArray(item.items)
                    ? item.items
                        .filter((note) => note && typeof note === 'object')
                        .map((note) => ({
                          name: typeof note.name === 'string' ? note.name : '',
                          type: typeof note.type === 'string' ? note.type : 'project',
                          description: typeof note.description === 'string' ? note.description : '',
                          content: typeof note.content === 'string' ? note.content : '',
                        }))
                    : [],
                }))
            : [];
          return { count: asNumber(value.count, items.length), items };
        })(),
        state: {
          lastDreamAt: asNumber(stateRecord.lastDreamAt, 0),
          lastDreamAttemptAt: asNumber(stateRecord.lastDreamAttemptAt, 0),
          lastDreamSummary:
            typeof stateRecord.lastDreamSummary === 'string' ? stateRecord.lastDreamSummary : '',
          lastDreamSessions: asNumber(stateRecord.lastDreamSessions, 0),
          lastDreamOps: asNumber(stateRecord.lastDreamOps, 0),
          lastDreamMode: typeof stateRecord.lastDreamMode === 'string' ? stateRecord.lastDreamMode : '',
          pendingSwitch: normalizePendingSwitch(stateRecord.shadowPending),
          lastError: typeof stateRecord.lastError === 'string' ? stateRecord.lastError : '',
          consecutiveFailures: asNumber(stateRecord.consecutiveFailures, 0),
          sessionsSince: Array.isArray(stateRecord.sessionsSince)
            ? stateRecord.sessionsSince.length
            : asNumber(stateRecord.sessionsSince, 0),
          counters: stateRecord.counters && typeof stateRecord.counters === 'object' ? stateRecord.counters : {},
          lastDreamDurationMs: asNumber(stateRecord.lastDreamDurationMs, 0),
          lastDreamUsage: normalizeUsage(stateRecord.lastDreamUsage ?? stateRecord.lastUsage),
          lastDreamCostExceeded: Boolean(
            stateRecord.lastDreamCostExceeded ?? stateRecord.costExceeded ?? false,
          ),
          lastExtractAt: asNumber(stateRecord.lastExtractAt, 0),
          lastExtractAttemptAt: asNumber(stateRecord.lastExtractAttemptAt, 0),
          lastExtractCount: asNumber(stateRecord.lastExtractCount, 0),
          lastExtractReason:
            typeof stateRecord.lastExtractReason === 'string' ? stateRecord.lastExtractReason : '',
          lastExtractError:
            typeof stateRecord.lastExtractError === 'string' ? stateRecord.lastExtractError : '',
          lastExtractTrigger:
            typeof stateRecord.lastExtractTrigger === 'string' ? stateRecord.lastExtractTrigger : '',
        },
        changelogTail: typeof record.changelogTail === 'string' ? record.changelogTail : '',
        trashCount: asNumber(record.trashCount, 0),
        rules: normalizeRules(record.rules),
        metrics: normalizeMetrics(record.metrics),
        readiness: normalizeReadiness(record.readiness),
        health: (() => {
          const candidate =
            record.health && typeof record.health === 'object'
              ? record.health.memoryHealth && typeof record.health.memoryHealth === 'object'
                ? record.health.memoryHealth
                : record.health
              : null;
          let normalized;
          if (
            candidate !== null &&
            (candidate.score !== undefined ||
              Array.isArray(candidate.suggestions) ||
              (candidate.dimensions && typeof candidate.dimensions === 'object'))
          ) {
            normalized = normalizeHealth(candidate);
          } else {
            normalized = normalizeHealth(
              record.healthScore === undefined || record.healthScore === null
                ? candidate
                : { score: record.healthScore },
            );
          }
          // Keep the nested `memoryHealth` block for consumers (verifier/API
          // parity) while the card reads the flattened fields above.
          const nested = {
            score: normalized.score,
            dimensions: normalized.dimensions,
            suggestions: normalized.suggestions,
          };
          const outer = record.health && typeof record.health === 'object' ? record.health : {};
          return {
            ...normalized,
            ok: outer.ok === true,
            warnings: Array.isArray(outer.warnings) ? outer.warnings : [],
            memoryHealth: nested,
          };
        })(),
        session: {
          live:
            record.session && typeof record.session === 'object' && typeof record.session.live === 'boolean'
              ? record.session.live
              : null,
        },
        dreamHistory: normalizeDreamHistory(record.dreamHistory),
        subagentPolicy: {
          mode:
            record.subagentPolicy && (record.subagentPolicy.mode === 'shared' || record.subagentPolicy.mode === 'own')
              ? record.subagentPolicy.mode
              : 'off',
          agentMemoryPresets:
            record.subagentPolicy && Array.isArray(record.subagentPolicy.agentMemoryPresets)
              ? record.subagentPolicy.agentMemoryPresets.filter((name) => typeof name === 'string')
              : [],
        },
      };
    }

    /** Normalize a /file payload (with v7 provenance read from either level). */
    function normalizeFile(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const rawText = typeof record.raw === 'string' ? record.raw : '';
      const frontmatter =
        record.frontmatter && typeof record.frontmatter === 'object' ? record.frontmatter : null;
      const via =
        typeof record.via === 'string'
          ? record.via
          : frontmatter && typeof frontmatter.via === 'string'
            ? frontmatter.via
            : '';
      const sourceSession =
        typeof record.sourceSession === 'string'
          ? record.sourceSession
          : frontmatter && typeof frontmatter.source_session === 'string'
            ? frontmatter.source_session
            : '';
      return {
        file: typeof record.file === 'string' ? record.file : '',
        version: typeof record.version === 'string' ? record.version : '',
        expectedHash: typeof record.expectedHash === 'string' ? record.expectedHash : '',
        frontmatter,
        body: typeof record.body === 'string' ? record.body : rawText,
        raw: rawText,
        // The edit baseline: `expectedHash` goes back on save so the store can
        // refuse an overwrite of a page another window changed meanwhile.
        version: typeof record.version === 'string' ? record.version : '',
        expectedHash: typeof record.expectedHash === 'string' ? record.expectedHash : '',
        via,
        sourceSession,
        created:
          typeof record.created === 'string'
            ? record.created
            : frontmatter && typeof frontmatter.created === 'string'
              ? frontmatter.created
              : '',
      };
    }

    function normalizePreviewLines(value) {
      return Array.isArray(value) ? value
        .filter((item) => item && Number.isInteger(item.line) && item.line > 0 && typeof item.text === 'string')
        .map((item) => ({ line: item.line, text: item.text })) : [];
    }

    /** One `/file-history` response → `{changes:[...], refs:[...]}`. */
    function normalizeFileHistory(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const source = record.result && typeof record.result === 'object' ? record.result : record;
      const refs = Array.isArray(source.planRefs) ? source.planRefs : Array.isArray(source.refs) ? source.refs : [];
      return {
        changelog: Array.isArray(source.changelog) ? source.changelog.filter((line) => typeof line === 'string').slice(-20) : [],
        refs: refs
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            type: 'dream',
            id: typeof item.id === 'string' ? item.id : '',
            at: asNumber(item.appliedAt ?? item.createdAt, 0),
            ops: asNumber(item.ops, 0),
          }))
          .slice(0, 20),
      };
    }

    /** Normalize a `/backups` or `/trash` response into `[{id,at,files[]}]`. */
    function normalizeBackupList(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const source = record.result && typeof record.result === 'object' ? record.result : record;
      const items = Array.isArray(source.items) ? source.items : [];
      return items
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: typeof item.id === 'string' && item.id !== '' ? item.id : String(item.name ?? ''),
          at: asNumber(item.at, 0),
          files: Array.isArray(item.files) ? item.files.filter((file) => typeof file === 'string') : [],
        }));
    }

    /** Cap one diff pane for display; the dialog itself never loads giant text. */
    function truncatePreview(text) {
      const value = String(text === undefined || text === null ? '' : text);
      return value.length > 2000 ? value.slice(0, 2000) : value;
    }

    // -----------------------------------------------------------------------
    // Silent HTTP API client
    // -----------------------------------------------------------------------

    /**
     * The one way the page learns the API base and token: a same-origin
     * credentialed GET of `/api/cc-memory/bridge` (loopback only on the Host).
     * `null` means the memory service is not reachable from this page.
     */
    async function discoverBridge() {
      try {
        if (typeof window === 'undefined' || typeof fetch !== 'function') return null;
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        const timer = controller ? setTimeout(() => controller.abort(), 1500) : undefined;
        try {
          const response = await fetch('/api/cc-memory/bridge', {
            credentials: 'include',
            headers: { accept: 'application/json' },
            signal: controller ? controller.signal : undefined,
          });
          if (!response.ok) return null;
          const data = await response.json();
          if (!data || data.ok !== true || typeof data.base !== 'string' || data.base === '') return null;
          return { base: data.base.replace(/\/+$/, ''), token: typeof data.token === 'string' ? data.token : '' };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch {
        return null;
      }
    }

    function queryString(query) {
      if (!query || typeof query !== 'object') return '';
      const parts = [];
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      }
      return parts.length > 0 ? '?' + parts.join('&') : '';
    }

    /** One token-authenticated JSON request against the silent memory API. */
    async function apiRequest(api, method, endpoint, options = {}) {
      const url = api.base + endpoint + queryString(options.query);
      const headers = { accept: 'application/json' };
      if (api.token !== '') headers['x-cc-memory-token'] = api.token;
      let body;
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(options.body === undefined ? {} : options.body);
      }
      let response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch (error) {
        throw new Error('memory API request failed: ' + formatError(error));
      }
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!data || typeof data !== 'object') throw new Error('memory API returned HTTP ' + response.status);
      if (data.ok === false) {
        const code = typeof data.error === 'string' && data.error !== '' ? data.error : 'request failed';
        const detail = typeof data.message === 'string' && data.message !== '' ? data.message : '';
        const error = new Error(detail !== '' ? code + ': ' + detail : code);
        error.code = data.error;
        error.status = response.status;
        throw error;
      }
      if (!response.ok) {
        const error = new Error('memory API returned HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return data;
    }

    // -----------------------------------------------------------------------
    // Backend: the silent HTTP API is the only data path.
    // -----------------------------------------------------------------------

    function sessionIdOf(owner) {
      if (typeof owner === 'string' && owner !== '') return owner;
      if (owner && typeof owner === 'object' && typeof owner.sessionId === 'string' && owner.sessionId !== '') {
        return owner.sessionId;
      }
      return undefined;
    }

    function createBackend({ api, sessionId }) {
      const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
      const mode = api !== null ? 'api' : 'none';
      const get = (endpoint, query = {}) => {
        if (api === null) throw new Error('the memory service is unavailable');
        return apiRequest(api, 'GET', endpoint, { query: { sessionId: sid, ...query } });
      };
      const post = (endpoint, body = {}) => {
        if (api === null) throw new Error('the memory service is unavailable');
        return apiRequest(api, 'POST', endpoint, { body: { sessionId: sid, ...body } });
      };

      async function status() {
        return normalizeStatus(await get('/status'));
      }

      async function file(name) {
        return normalizeFile(await get('/file', { file: name }));
      }

      async function saveRules(scope, text) {
        const data = await post('/rules', { scope: scope === 'global' ? 'global' : 'project', text });
        return normalizeRules(data.rules);
      }

      /** Saving empty text removes a layer; clear both so nothing extra is injected. */
      async function resetRules() {
        await post('/rules', { scope: 'project', text: '' });
        const data = await post('/rules', { scope: 'global', text: '' });
        return normalizeRules(data.rules);
      }

      async function toggle(patch) {
        const data = await post('/toggle', patch);
        return {
          overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : {},
          config: data.config && typeof data.config === 'object' ? data.config : {},
        };
      }

      /** POST /dream: estimate, start, status, cancel, resume, switch, discard, undo. */
      async function dream(action, options = {}) {
        const body = { action };
        const focus = typeof options.focus === 'string' ? options.focus.trim() : '';
        if (focus !== '') body.focus = focus;
        if (typeof options.runId === 'string' && options.runId !== '') body.runId = options.runId;
        // v23: a confirmed run is pinned to the range it was priced for.
        if (typeof options.inputId === 'string' && options.inputId !== '') body.inputId = options.inputId;
        if (Array.isArray(options.inputRanges) && options.inputRanges.length > 0) body.inputRanges = options.inputRanges;
        return (await post('/dream', body)).result;
      }

      async function deleteFile(name) {
        return post('/delete', { file: name });
      }

      /** GET /backups → `{items:[{id,at,files[]}]}`. */
      async function backups() {
        return { items: normalizeBackupList(await get('/backups')) };
      }

      /** GET /trash → `{items:[{id,at,files[]}]}`. */
      async function trash() {
        return { items: normalizeBackupList(await get('/trash')) };
      }

      /** POST /restore `{kind:'backup'|'trash',id,file?}` → `{restored,reconciled}`. */
      async function restore(kind, id, name) {
        const body = { kind: kind === 'backup' ? 'backup' : 'trash', id };
        if (typeof name === 'string' && name !== '') body.file = name;
        return post('/restore', body);
      }

      async function dreamHistory() {
        return normalizeDreamHistory(await get('/dream-history'));
      }

      /** v21: staged auto-extract proposals (`list|accept|discard`). */
      async function inbox(action = 'list', id = '') {
        const act = String(action || 'list').toLowerCase();
        if (act === 'list') return get('/inbox');
        return post('/inbox', { action: act, id: String(id || '') });
      }

      /** POST /file — create or update one memory file (frontmatter + body). */
      async function saveFile(payload) {
        const body = {
          name: String(payload && payload.name !== undefined ? payload.name : ''),
          type: String(payload && payload.type !== undefined ? payload.type : 'user'),
          description: String(payload && payload.description !== undefined ? payload.description : ''),
          content: String(payload && payload.content !== undefined ? payload.content : ''),
        };
        if (payload && typeof payload.file === 'string' && payload.file !== '') body.file = payload.file;
        // v23: the server refuses the write when the file moved since this baseline.
        if (payload && typeof payload.expectedHash === 'string' && payload.expectedHash !== '') {
          body.expectedHash = payload.expectedHash;
        }
        return post('/file', body);
      }

      /** GET /search → ranked `{query,total,items:[{file,name,type,score,snippets}]}`. */
      async function search(query, options = {}) {
        const data = await get('/search', {
          q: String(query === undefined || query === null ? '' : query),
          limit: String(asNumber(options.limit, 20)),
          offset: String(asNumber(options.offset, 0)),
          type: options.type === undefined || options.type === null ? '' : String(options.type),
          history: options.history === true ? '1' : '',
        });
        return normalizeSearch(data);
      }

      /** GET /file-history → dream batches and changelog lines that touched one file. */
      async function fileHistory(target) {
        return normalizeFileHistory(await get('/file-history', { file: target }));
      }

      return {
        mode,
        sessionId: sid,
        status,
        fileHistory,
        file,
        saveRules,
        resetRules,
        toggle,
        dream,
        deleteFile,
        backups,
        trash,
        restore,
        dreamHistory,
        inbox,
        saveFile,
        search,
      };
    }

    // -----------------------------------------------------------------------
    // Error boundary: a slot crash renders a diagnostic, never a blank area.
    // -----------------------------------------------------------------------
    class ViewBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        // eslint-disable-next-line no-console
        console.error('[cc-memory] memory view crashed:', error);
      }

      render() {
        if (this.state.error !== null) {
          const error = this.state.error;
          const message = error && error.message ? error.message : String(error);
          return h(
            'div',
            { style: { padding: '18px 22px', font: 'inherit' }, 'data-cc-memory-error': '1' },
            h('div', { style: { fontWeight: 600, marginBottom: 8, fontSize: 14 } }, 'Memory 视图渲染失败 / Memory view failed to render'),
            h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.85, margin: 0 } }, message),
            h(
              'button',
              {
                type: 'button',
                style: { marginTop: 12, padding: '4px 12px', cursor: 'pointer' },
                onClick: () => this.setState({ error: null }),
              },
              'Retry / 重试',
            ),
          );
        }
        return this.props.children;
      }
    }

    // Module-level backend factory: the slot injection normally supplies one,
    // but a composition that drops the custom `inject` props still renders.
    let backendFactory = null;

    function resolveBackend(props) {
      if (props && props.memBackend && typeof props.memBackend === 'object') return props.memBackend;
      if (typeof backendFactory === 'function') {
        const sessionId = sessionIdOf(props && props.memSessionId) || sessionIdOf(props && props.sessionId);
        return backendFactory(sessionId);
      }
      return null;
    }

    function resolveT(props) {
      if (props && typeof props.t === 'function') return props.t;
      if (props && typeof props.memT === 'function') return props.memT;
      return (key) => key;
    }

    /** `spec.md#p2, 2026-11-10` → `spec.md#p2` for the chip; the title keeps it all. */
    function shortCite(inner) {
      const value = String(inner === undefined || inner === null ? '' : inner).trim();
      const head = value.split(',')[0].trim();
      const parts = head.split('/');
      return parts[parts.length - 1] || value;
    }

    /**
     * Very small safe Markdown renderer (no HTML injection). Besides bold, em,
     * code and links it renders `^[source#locator, date]` citations as chips and
     * `[[slug]]` / `[[slug|label]]` wiki links (clickable when `onWikiLink` is
     * given; `hasPage(slug)` marks broken links).
     */
    function renderInline(text, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const source = String(text === undefined || text === null ? '' : text);
      const parts = [];
      // `[*]` instead of `\*`: the Host's client snapshot drops the backslash in
      // `\*\*`, which turns this literal into a boot-time SyntaxError.
      const pattern = /(\^\[[^\]\n]+\]|\[\[[^\]\n]+\]\]|[*][*][^*]+[*][*]|[*][^*]+[*]|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      let match;
      let key = 0;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) parts.push(source.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('^[')) {
          const inner = token.slice(2, -1);
          parts.push(h('span', { key: 's' + key++, className: 'ccm-cite', title: inner }, shortCite(inner)));
        } else if (token.startsWith('[[')) {
          const inner = token.slice(2, -2);
          const bar = inner.indexOf('|');
          const slug = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
          const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || slug;
          if (typeof opts.onWikiLink === 'function') {
            const dead = typeof opts.hasPage === 'function' && !opts.hasPage(slug);
            parts.push(
              h(
                'button',
                {
                  key: 'w' + key++,
                  type: 'button',
                  className: 'ccm-wlink' + (dead ? ' is-dead' : ''),
                  disabled: dead,
                  title: slug,
                  onClick: () => opts.onWikiLink(slug),
                },
                label,
              ),
            );
          } else {
            parts.push(h('span', { key: 'w' + key++, className: 'ccm-wlink' }, label));
          }
        } else if (token.startsWith('**')) parts.push(h('strong', { key: 'b' + key++ }, token.slice(2, -2)));
        else if (token.startsWith('`')) parts.push(h('code', { key: 'c' + key++ }, token.slice(1, -1)));
        else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          if (link) parts.push(h('a', { key: 'l' + key++, href: link[2], target: '_blank', rel: 'noreferrer noopener' }, link[1]));
          else parts.push(token);
        } else parts.push(h('em', { key: 'e' + key++ }, token.slice(1, -1)));
        last = match.index + token.length;
      }
      if (last < source.length) parts.push(source.slice(last));
      return parts;
    }

    /** Render memory body markdown as React nodes; fenced code, headings, lists, quotes. */
    function renderMarkdown(text, options) {
      const inline = (value) => renderInline(value, options);
      const source = String(text === undefined || text === null ? '' : text).replace(/\r\n/g, '\n');
      const lines = source.split('\n');
      const nodes = [];
      let index = 0;
      let key = 0;
      const blockStart = /^(#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+[.)]\s+|---+$)/;
      while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === '') { index += 1; continue; }
        if (line.startsWith('```')) {
          const buffer = [];
          index += 1;
          while (index < lines.length && !lines[index].startsWith('```')) buffer.push(lines[index++]);
          index += 1;
          nodes.push(h('pre', { key: 'code' + key++, className: 'ccm-code' }, h('code', null, buffer.join('\n'))));
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = Math.min(6, heading[1].length + 2);
          nodes.push(h('h' + level, { key: 'h' + key++, className: 'ccm-md-h' }, inline(heading[2])));
          index += 1;
          continue;
        }
        if (/^---+$/.test(line.trim())) { nodes.push(h('hr', { key: 'hr' + key++ })); index += 1; continue; }
        if (/^>\s?/.test(line)) {
          const buffer = [];
          while (index < lines.length && /^>\s?/.test(lines[index])) buffer.push(lines[index++].replace(/^>\s?/, ''));
          nodes.push(h('blockquote', { key: 'q' + key++ }, inline(buffer.join(' '))));
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
            items.push(h('li', { key: 'li' + key++ }, inline(lines[index++].replace(/^\s*[-*]\s+/, ''))));
          }
          nodes.push(h('ul', { key: 'ul' + key++ }, items));
          continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
            items.push(h('li', { key: 'ol' + key++ }, inline(lines[index++].replace(/^\s*\d+[.)]\s+/, ''))));
          }
          nodes.push(h('ol', { key: 'oll' + key++ }, items));
          continue;
        }
        const paragraph = [];
        while (index < lines.length && lines[index].trim() !== '' && !blockStart.test(lines[index])) paragraph.push(lines[index++]);
        if (paragraph.length === 0) { index += 1; continue; }
        nodes.push(h('p', { key: 'p' + key++ }, inline(paragraph.join(' '))));
      }
      return nodes.length > 0 ? nodes : h('div', { className: 'ccm-hint' }, '');
    }

    // -----------------------------------------------------------------------
    // Icons: stroke paths on a 24px grid, no external assets.
    // -----------------------------------------------------------------------
    const ICONS = {
      search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
      plus: 'M12 5v14 M5 12h14',
      close: 'M18 6L6 18 M6 6l12 12',
      back: 'M15 18l-6-6 6-6',
      chevron: 'M9 6l6 6-6 6',
      refresh: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v5h-5',
      check: 'M20 6L9 17l-5-5',
      edit: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
      trash: 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6',
      undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
      sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z',
      copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
      alert: 'M12 9v4 M12 17h.01 M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
      book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
      pin: 'M12 17v5 M8 3h8 M9 3v6l-3 4v2h12v-2l-3-4V3',
      shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4',
      clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
      inbox:
        'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
      layers: 'M12 2l10 5-10 5L2 7z M2 17l10 5 10-5 M2 12l10 5 10-5',
      archive: 'M21 8v13H3V8 M1 3h22v5H1z M10 12h4',
      history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 3',
      info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01',
      eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      dot: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    };

    function icon(name, size) {
      const px = size || 16;
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: ICONS[name] || '' }),
      );
    }

    // -----------------------------------------------------------------------
    // Pure UI helpers (exposed on the internals hook for tests).
    // -----------------------------------------------------------------------
    const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
    const TRUST_FILTERS = ['verified', 'unverified', 'stale'];
    const STATUS_NAMES = ['stale', 'superseded', 'disputed', 'review-needed', 'retired'];
    const TABS = ['memories', 'inbox', 'tidy', 'settings'];
    const TYPE_COLORS = {
      user: 'var(--dsw-static-blue-500,#3b82f6)',
      feedback: 'var(--dsw-static-amber-500,#f59e0b)',
      project: 'var(--dsw-static-green-500,#22c55e)',
      reference: 'var(--dsw-static-violet-500,#8b5cf6)',
    };
    const BACKSLASH = String.fromCharCode(92);

    function knownType(type) {
      return MEMORY_TYPES.includes(type) ? type : 'user';
    }

    function typeStyle(type) {
      return { '--ccm-type': TYPE_COLORS[knownType(type)] };
    }

    /** Milliseconds from a number or an ISO string (0 when unknown). */
    function timeOf(value) {
      if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
      const parsed = Date.parse(String(value === undefined || value === null ? '' : value));
      return Number.isFinite(parsed) ? parsed : 0;
    }

    /** `3 min ago` / `2 天前`; '' when the time is unknown. */
    function ago(value, t) {
      const ms = timeOf(value);
      if (ms === 0) return '';
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (seconds < 90) return t('time.justNow');
      const minutes = Math.round(seconds / 60);
      if (minutes < 90) return t('time.minutes', { n: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 48) return t('time.hours', { n: hours });
      return t('time.days', { n: Math.round(hours / 24) });
    }

    /** `12345` → `12,345` (locale grouping when available). */
    function formatNumber(value) {
      const number = asNumber(value, 0);
      try {
        return number.toLocaleString('en-US');
      } catch {
        return String(number);
      }
    }

    function sortEntries(list) {
      return [...list].sort(
        (left, right) => timeOf(right.modified) - timeOf(left.modified) || left.name.localeCompare(right.name),
      );
    }

    /** `{all, user, feedback, project, reference}` counts for the filter chips. */
    function countByType(entries) {
      const counts = { all: 0, user: 0, feedback: 0, project: 0, reference: 0 };
      for (const entry of Array.isArray(entries) ? entries : []) {
        counts.all += 1;
        if (MEMORY_TYPES.includes(entry && entry.type)) counts[entry.type] += 1;
      }
      return counts;
    }

    /**
     * How far one note can be trusted, most specific first:
     * `stale` (marked not current) → `hot` (loaded into new conversations) →
     * `verified` (the host ledger matches this exact text) → `changed` (edited
     * after it was verified) → `unverified`.
     */
    function trustOf(entry) {
      const record = entry && typeof entry === 'object' ? entry : {};
      if (record.current === false) return 'stale';
      if (record.verified && typeof record.verified === 'object') return 'verified';
      if (record.verifiedOutdated === true) return 'changed';
      return 'unverified';
    }

    /** Trust filter: `verified` includes loaded notes, `unverified` includes edited ones. */
    function matchesTrust(entry, filter) {
      if (!TRUST_FILTERS.includes(filter)) return true;
      const trust = trustOf(entry);
      if (filter === 'unverified') return trust === 'unverified' || trust === 'changed';
      return trust === filter;
    }

    /** `{all, hot, verified, unverified, stale}` counts for the trust filter. */
    function countByTrust(entries) {
      const counts = { all: 0, hot: 0, verified: 0, unverified: 0, stale: 0 };
      for (const entry of Array.isArray(entries) ? entries : []) {
        counts.all += 1;
        for (const filter of TRUST_FILTERS) if (matchesTrust(entry, filter)) counts[filter] += 1;
      }
      return counts;
    }

    /**
     * Filter and rank the memory list. Local name/description matches always
     * count; `hits` (file -> {score}) adds the server's body matches.
     */
    function filterEntries(entries, options = {}) {
      const type = MEMORY_TYPES.includes(options.type) ? options.type : '';
      const trust = TRUST_FILTERS.includes(options.trust) ? options.trust : '';
      const needle = String(options.query === undefined || options.query === null ? '' : options.query)
        .trim()
        .toLowerCase();
      const hits = options.hits && typeof options.hits.get === 'function' ? options.hits : new Map();
      const pool = (Array.isArray(entries) ? entries : []).filter(
        (entry) => (type === '' || entry.type === type) && (trust === '' || matchesTrust(entry, trust)),
      );
      if (needle === '') return sortEntries(pool);
      const terms = needle.split(/\s+/).filter(Boolean);
      const ranked = [];
      for (const entry of pool) {
        const haystack = (entry.name + '\n' + entry.description + '\n' + entry.file).toLowerCase();
        const local = terms.every((term) => haystack.includes(term));
        const hit = hits.get(entry.file);
        if (!local && !hit) continue;
        const score =
          (entry.name.toLowerCase().includes(needle) ? 10 : 0) + (local ? 5 : 0) + (hit ? asNumber(hit.score, 0) : 0);
        ranked.push({ entry, score });
      }
      ranked.sort(
        (left, right) => right.score - left.score || timeOf(right.entry.modified) - timeOf(left.entry.modified),
      );
      return ranked.map((item) => item.entry);
    }

    const NOTE_KEYS = {
      'APPLIES WHEN': 'appliesWhen',
      'HOW TO VERIFY': 'verify',
      VERIFY: 'verify',
      OBSERVED: 'observed',
      EXCEPTION: 'exception',
    };

    /**
     * Split a memory body into what the reader shows separately: the `STATUS:`
     * marker, condition notes (APPLIES WHEN / VERIFY / OBSERVED / EXCEPTION),
     * `CONFLICT:` lines, earlier values (`- Superseded:` lines and a
     * `## History` section) and the remaining Markdown. Stamp lines
     * (VERIFIED, VERIFIED AGAINST, USER CONFIRMED, CONFIRMED) are dropped: the
     * host ledger, not a typed line, decides what is verified.
     */
    function splitBody(body) {
      const lines = String(body === undefined || body === null ? '' : body).replace(/\r\n/g, '\n').split('\n');
      const out = { status: '', notes: [], conflicts: [], superseded: [], rest: '' };
      const rest = [];
      let fence = false;
      let inHistory = false;
      for (const line of lines) {
        if (line.startsWith('```')) {
          fence = !fence;
          if (!inHistory) rest.push(line);
          continue;
        }
        if (fence) {
          if (!inHistory) rest.push(line);
          continue;
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
          inHistory = /^history\s*$/i.test(heading[1].trim());
          if (!inHistory) rest.push(line);
          continue;
        }
        if (inHistory) {
          const value = line.replace(/^\s*[-*]\s+/, '').replace(/^Superseded:\s*/i, '').trim();
          if (value !== '') out.superseded.push(value);
          continue;
        }
        const status = /^\s*STATUS:\s*([A-Za-z-]+)/.exec(line);
        if (status) {
          out.status = status[1].toLowerCase();
          continue;
        }
        if (/^\s*(VERIFIED AGAINST|VERIFIED|USER CONFIRMED|CONFIRMED)\s*:/i.test(line)) continue;
        const note = /^\s*(APPLIES WHEN|HOW TO VERIFY|VERIFY|OBSERVED|EXCEPTION):\s*(.+)$/i.exec(line);
        if (note) {
          out.notes.push({ key: NOTE_KEYS[note[1].toUpperCase()] || 'verify', value: note[2].trim() });
          continue;
        }
        const superseded = /^\s*[-*]\s+Superseded:\s*(.+)$/i.exec(line);
        if (superseded) {
          out.superseded.push(superseded[1].trim());
          continue;
        }
        const conflict = /^\s*(?:[-*]\s+)?CONFLICT:\s*(.+)$/.exec(line);
        if (conflict) {
          out.conflicts.push(conflict[1].trim());
          continue;
        }
        rest.push(line);
      }
      out.rest = rest.join('\n').trim();
      return out;
    }

    /** create / update / delete / index for one previewed plan operation. */
    function opKind(op) {
      if (!op || typeof op !== 'object') return 'update';
      if (op.op === 'delete') return 'delete';
      if (op.op === 'index') return 'index';
      return op.before === '' ? 'create' : 'update';
    }

    /** Last path segment of a Windows or POSIX path. */
    function baseName(value) {
      const parts = String(value === undefined || value === null ? '' : value)
        .split(BACKSLASH)
        .join('/')
        .split('/')
        .filter((part) => part !== '');
      return parts.length > 0 ? parts[parts.length - 1] : '';
    }

    function projectLabel(project) {
      const record = project && typeof project === 'object' ? project : {};
      return baseName(record.projectRoot) || String(record.projectId || '') || baseName(record.memoryDir);
    }

    function planWaiting(status) {
      const state = status && status.state ? status.state : {};
      return Boolean(state.pendingSwitch && state.pendingSwitch.dir);
    }

    /** Items waiting for the user: an unreviewed dream shadow + staged notes. */
    function attentionCount(status) {
      if (!status) return 0;
      const staged = status.inbox && Number.isFinite(status.inbox.count) ? status.inbox.count : 0;
      return (planWaiting(status) ? 1 : 0) + Math.max(0, staged);
    }

    /**
     * One sentence for the header: what a new conversation loads right now.
     * `{tone, icon, text}` where tone is `off`, `warn`, `hot` or `index`.
     */
    function loadSummary(status, t) {
      if (!status) return null;
      const config = status.config;
      if (!config.enabled || !config.autoMemoryEnabled) return { tone: 'warn', icon: 'alert', text: t('load.off') };
      const maxLines = config.indexMaxLines || 200;
      if (status.index.overflow || status.index.lines > maxLines) {
        return { tone: 'warn', icon: 'alert', text: t('load.indexOver') };
      }
      return { tone: 'index', icon: 'book', text: t('load.index', { lines: status.index.lines, maxLines }) };
    }

    /** Friendly provenance: who wrote this memory. */
    function viaLabel(via, t) {
      const value = String(via || '');
      if (value === '') return '';
      if (value.startsWith('tool:')) return t('via.agent');
      if (value.startsWith('command:')) return t('via.command');
      if (value.startsWith('dream')) return t('via.tidy');
      if (value.startsWith('api:')) return t('via.you');
      if (value.startsWith('import')) return t('via.import');
      return value;
    }

    /** Map a thrown error (or a failure string) to a sentence for the toast. */
    function errorText(error, t) {
      const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
      const message = formatError(error);
      const probe = (code + ' ' + message).toLowerCase();
      if (probe.includes('dream-locked')) return t('err.locked');
      if (probe.includes('stale-plan')) return t('err.stale');
      if (probe.includes('delete-disabled')) return t('err.deleteDisabled');
      if (probe.includes('plugin-disabled')) return t('banner.pluginOff');
      if (probe.includes('auto-memory-disabled')) return t('banner.autoMemoryOff');
      // A backend loaded before this page was updated: unknown routes/actions,
      // or a module graph mixing old and new files.
      if (probe.includes('unknown-action') || probe.includes('does not provide an export named')) {
        return t('err.backendStale');
      }
      return message;
    }

    /**
     * An error as `{text, items}` for display: `code: a; b; c` host errors
     * become a headline plus one item per part, so a long refusal is a list
     * instead of a wall of text.
     */
    function errorInfo(error, t) {
      const text = errorText(error, t);
      const raw = formatError(error);
      const evidence = /evidence[-_]rejected:\s*([\s\S]+)$/i.exec(raw);
      if (evidence) {
        const items = evidence[1]
          .split(/;\s+(?=[^\s:;]+[.]md: |index: |merge dependency)/)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => {
            const file = /^([^\s:;]+[.]md): /.exec(item);
            return file ? file[1] + ' — ' + reasonText(item, file[1], t) : reasonText(item, '', t);
          });
        return { text: t('err.evidenceRejected'), items };
      }
      if (text.length > 140 && text.includes('; ')) {
        const colon = text.indexOf(': ');
        const head = colon > 0 && colon < 48 ? text.slice(0, colon) : '';
        const rest = head ? text.slice(colon + 2) : text;
        return { text: head, items: rest.split(/;\s+/).map((item) => item.trim()).filter(Boolean) };
      }
      return { text, items: [] };
    }

    /** A host refusal reason for one plan operation, in the user's language. */
    function reasonText(reason, file, t) {
      let value = String(reason || '');
      if (file && value.startsWith(file + ': ')) value = value.slice(file.length + 2);
      const quoted = (pattern) => {
        const match = pattern.exec(value);
        return match ? match[1] : '';
      };
      if (/^new line has no source citation/.test(value)) {
        return t('reason.noCitation', { line: quoted(/source citation: "([\s\S]*)"$/) });
      }
      if (/does not match any verified claim/.test(value)) return t('reason.noClaim');
      if (/^line is not supported by a verified claim/.test(value)) {
        return t('reason.unsupported', { line: quoted(/: "([\s\S]*)"$/) });
      }
      if (/attributes a requirement to the user/.test(value)) return t('reason.userAttribution');
      if (/user\/feedback line has no \[user\] claim/.test(value)) return t('reason.userClass');
      if (/^merge dependency/.test(value)) return t('reason.mergeDependency');
      return value;
    }

    /** One sentence for the auto-dream row, from the readiness gates. */
    function readinessText(readiness, config, t) {
      if (!readiness) return '';
      if (readiness.eligible) return t('tidy.ready');
      const reason = readiness.reasons.find((item) => item.code !== 'auto-dream-off' && item.code !== 'disabled');
      if (!reason) return '';
      if (reason.code === 'min-hours') return t('readiness.min-hours', { hours: config.minHours || 24 });
      if (reason.code === 'min-sessions') {
        const gate = readiness.gates.minSessions;
        return t('readiness.min-sessions', {
          current: gate ? gate.current : 0,
          required: gate ? gate.required : config.minSessions || 5,
        });
      }
      const key = 'readiness.' + reason.code;
      const text = t(key);
      return text !== key ? text : reason.message;
    }

    function readStoredTab() {
      try {
        const value = window.localStorage.getItem('cc-memory.tab');
        return TABS.includes(value) ? value : 'memories';
      } catch {
        return 'memories';
      }
    }

    function storeTab(value) {
      try {
        window.localStorage.setItem('cc-memory.tab', value);
      } catch {
        /* storage is a convenience only */
      }
    }

    /** Index usage ratio and meter class for a budget. */
    function budgetMeter(lines, bytes, maxLines, maxBytes, overflow) {
      const ratio = Math.max(maxLines > 0 ? lines / maxLines : 0, maxBytes > 0 ? bytes / maxBytes : 0);
      const over = overflow === true || ratio > 1;
      return {
        ratio,
        over,
        className: 'ccm-meter' + (over ? ' is-over' : ratio > 0.8 ? ' is-warn' : ''),
        width: Math.min(100, Math.round(ratio * 100)) + '%',
      };
    }

    // -----------------------------------------------------------------------
    // Small components
    // -----------------------------------------------------------------------

    /** Two-step button: the first click arms it, the second confirms. */
    function ConfirmButton(props) {
      const [armed, setArmed] = React.useState(false);
      React.useEffect(() => {
        if (!armed) return undefined;
        const timer = setTimeout(() => setArmed(false), 3500);
        return () => clearTimeout(timer);
      }, [armed]);
      const armedClass = props.tone === 'danger' ? ' ccm-armed-danger' : ' ccm-armed';
      const className =
        'ccm-btn' + (props.small ? ' ccm-btn-sm' : '') + (props.className ? ' ' + props.className : '') + (armed ? armedClass : '');
      return h(
        'button',
        {
          type: 'button',
          className,
          disabled: props.disabled,
          onClick: () => {
            if (armed) {
              setArmed(false);
              props.onConfirm();
            } else {
              setArmed(true);
            }
          },
          onBlur: () => setArmed(false),
        },
        props.icon && !armed ? icon(props.icon, 14) : null,
        armed ? props.confirmLabel || props.t('btn.confirm') : props.label,
      );
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'ccm-switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: () => props.onChange(!props.checked),
      });
    }

    function TypeTag(props) {
      const type = knownType(props.type);
      return h('span', { className: 'ccm-tag', style: typeStyle(type) }, h('span', { className: 'ccm-dot' }), props.t('type.' + type));
    }

    const TRUST_ICONS = { verified: 'shield', changed: 'edit', stale: 'archive', unverified: 'dot' };

    /** Trust pill; quiet (nothing) for unverified notes. */
    function TrustBadge(props) {
      const trust = trustOf(props.entry);
      if (trust === 'unverified') return null;
      const label =
        trust === 'stale'
          ? props.t(STATUS_NAMES.includes(props.entry.status) ? 'status.' + props.entry.status : 'trust.stale')
          : props.t('trust.' + trust);
      return h('span', { className: 'ccm-trust', 'data-trust': trust }, icon(TRUST_ICONS[trust], 11), label);
    }

    function Field(props) {
      return h(
        'label',
        { className: 'ccm-field' },
        h('span', { className: 'ccm-label' }, props.label),
        props.children,
        props.help ? h('span', { className: 'ccm-help' }, props.help) : null,
      );
    }

    function Banner(props) {
      return h(
        'div',
        { className: 'ccm-banner' + (props.tone === 'error' ? ' ccm-banner-error' : ''), role: 'status' },
        icon('alert', 16),
        h('span', { className: 'ccm-banner-text' }, props.text),
        props.action || null,
      );
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'ccm-card ccm-empty' },
        h('div', { className: 'ccm-empty-icon' + (props.tone === 'ok' ? ' is-ok' : '') }, icon(props.icon, 22)),
        h('div', { className: 'ccm-empty-title' }, props.title),
        props.text ? h('div', { className: 'ccm-empty-text' }, props.text) : null,
        props.action || null,
      );
    }

    function reloadButton(t) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ccm-btn ccm-btn-sm',
          onClick: () => {
            try {
              window.location.reload();
            } catch {
              /* nothing else to do */
            }
          },
        },
        t('btn.reload'),
      );
    }

    // -----------------------------------------------------------------------
    // Memories tab: filters, one list, and a reader that shows trust.
    // -----------------------------------------------------------------------

    /** Arrow keys move between list rows (the list is a column of buttons). */
    function rowKeyDown(event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const next = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
      if (next && typeof next.focus === 'function' && next.tagName === 'BUTTON') {
        event.preventDefault();
        next.focus();
      }
    }

    /** The trust sentence under a note's title. */
    function TrustLine(props) {
      const { entry, t } = props;
      const trust = trustOf(entry);
      let text;
      let iconName = TRUST_ICONS[trust];
      const lines = [];
      if (trust === 'stale') {
        const name = STATUS_NAMES.includes(entry.status) ? t('status.' + entry.status) : t('trust.stale');
        text = t('detail.stale', { status: name });
      } else if (trust === 'verified') {
        text = t('detail.verified', { date: entry.verified.date || '—' });
      } else if (trust === 'changed') {
        text = t('detail.changed');
      } else {
        iconName = 'info';
        text = t('detail.unverifiedIndex');
      }
      return h(
        'div',
        { className: 'ccm-trustline', 'data-trust': trust },
        icon(iconName, 14),
        h(
          'div',
          { className: 'ccm-trustline-text' },
          h('span', null, text),
          lines.map((line) => h('span', { key: line, className: 'ccm-muted' }, line)),
        ),
      );
    }

    /**
     * A note body split into conditions, conflicts, Markdown and
     * earlier values. `options` carries the wiki link handlers.
     */
    function NoteBody(props) {
      const { body, t, options } = props;
      const parts = splitBody(body);
      const hasAny = parts.rest !== '' || parts.notes.length > 0 || parts.conflicts.length > 0 || parts.superseded.length > 0;
      if (!hasAny) return h('div', { className: 'ccm-md ccm-muted' }, t('detail.emptyBody'));
      return h(
        React.Fragment,
        null,
        parts.notes.length > 0
          ? h(
              'dl',
              { className: 'ccm-facts' },
              parts.notes.map((note, index) =>
                h(
                  React.Fragment,
                  { key: note.key + index },
                  h('dt', null, t('notes.' + note.key)),
                  h('dd', null, renderInline(note.value, options)),
                ),
              ),
            )
          : null,
        parts.conflicts.map((line, index) =>
          h(
            'div',
            { key: 'conflict' + index, className: 'ccm-callout' },
            h('div', { className: 'ccm-callout-title' }, icon('alert', 13), t('detail.conflict')),
            h('div', null, renderInline(line, options)),
          ),
        ),
        parts.rest !== '' ? h('div', { className: 'ccm-md' }, renderMarkdown(parts.rest, options)) : null,
        parts.superseded.length > 0
          ? h(
              'div',
              { className: 'ccm-sub' },
              h('h3', { className: 'ccm-sub-title' }, t('detail.superseded')),
              h(
                'ul',
                { className: 'ccm-old' },
                parts.superseded.map((line, index) => h('li', { key: index }, renderInline(line, options))),
              ),
            )
          : null,
      );
    }

    function MemoriesTab(props) {
      const { status, backend, t, busy, run, readOnly } = props;
      const [query, setQuery] = React.useState('');
      const [type, setType] = React.useState('');
      const [trust, setTrust] = React.useState('');
      const [hits, setHits] = React.useState(() => new Map());
      const [selected, setSelected] = React.useState('');
      const [editor, setEditor] = React.useState(null);
      const [doc, setDoc] = React.useState({ phase: 'idle', file: null, error: '' });
      const [reloadKey, setReloadKey] = React.useState(0);
      const [history, setHistory] = React.useState({ open: false, phase: 'idle', data: null, error: '' });

      const entries = status.entries;
      const typeCounts = countByType(entries);
      const trustCounts = countByTrust(entries);
      const visible = filterEntries(entries, { query, type, trust, hits });
      const selectedEntry = entries.find((entry) => entry.file === selected) || null;
      const idle = busy === '';
      const canHistory = !readOnly && typeof backend.fileHistory === 'function';

      // Another tab asked to open a note (e.g. the inbox's "Changes <file>").
      React.useEffect(() => {
        if (typeof props.focusFile !== 'string' || props.focusFile === '') return;
        setEditor(null);
        setSelected(props.focusFile);
        if (typeof props.onFocused === 'function') props.onFocused();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [props.focusFile]);

      // Body matches come from the server; names/descriptions filter locally.
      React.useEffect(() => {
        const text = query.trim();
        if (text.length < 2 || readOnly || typeof backend.search !== 'function') {
          setHits((current) => (current.size === 0 ? current : new Map()));
          return undefined;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
          backend.search(text, { limit: 50, type }).then(
            (result) => {
              if (cancelled) return;
              const map = new Map();
              for (const item of result.items) map.set(item.file, { score: item.score, snippet: item.snippets[0] || '' });
              setHits(map);
            },
            () => {
              if (!cancelled) setHits(new Map());
            },
          );
        }, 220);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [query, type, backend, readOnly]);

      React.useEffect(() => {
        setHistory({ open: false, phase: 'idle', data: null, error: '' });
        if (selected === '') {
          setDoc({ phase: 'idle', file: null, error: '' });
          return undefined;
        }
        let cancelled = false;
        setDoc((current) => ({
          phase: 'loading',
          file: current.file && current.file.file === selected ? current.file : null,
          error: '',
        }));
        backend.file(selected).then(
          (file) => {
            if (!cancelled) setDoc({ phase: 'ready', file, error: '' });
          },
          (error) => {
            if (!cancelled) setDoc({ phase: 'error', file: null, error: errorText(error, t) });
          },
        );
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selected, backend, reloadKey]);

      const open = (file) => {
        setEditor(null);
        setSelected((current) => (current === file ? '' : file));
      };
      const startNew = () => {
        setSelected('');
        setEditor({ mode: 'new', file: '', name: '', type: type || 'user', description: '', content: '', error: '', trusted: false });
      };
      const startEdit = () => {
        if (!doc.file) return;
        const front = doc.file.frontmatter || {};
        const trusted = selectedEntry ? trustOf(selectedEntry) === 'verified' : false;
        setEditor({
          mode: 'edit',
          file: selected,
          name: typeof front.name === 'string' && front.name !== '' ? front.name : selectedEntry ? selectedEntry.name : '',
          type: knownType(typeof front.type === 'string' ? front.type : selectedEntry ? selectedEntry.type : 'user'),
          description:
            typeof front.description === 'string' ? front.description : selectedEntry ? selectedEntry.description : '',
          content: doc.file.body,
          error: '',
          trusted,
          // The version this draft started from; saving it back lets the store
          // refuse to overwrite a page another window changed meanwhile.
          expectedHash: typeof doc.file.expectedHash === 'string' ? doc.file.expectedHash : '',
        });
      };
      const patchEditor = (patch) => setEditor((current) => (current ? { ...current, ...patch } : current));
      const saveEditor = async () => {
        if (!editor || !idle) return;
        if (editor.name.trim() === '') {
          patchEditor({ error: t('edit.nameRequired') });
          return;
        }
        const payload = {
          name: editor.name.trim(),
          type: editor.type,
          description: editor.description.trim(),
          content: editor.content,
        };
        if (editor.mode === 'edit') {
          payload.file = editor.file;
          payload.expectedHash = editor.expectedHash;
        }
        let conflict = '';
        const done = await run('save', async () => {
          try {
            return await backend.saveFile(payload);
          } catch (error) {
            if (error && error.code === 'stale-write') {
              // Keep the draft on screen and show the page as it is now.
              conflict = t('edit.conflict');
              setReloadKey((key) => key + 1);
              return null;
            }
            throw error;
          }
        }, { success: t('notice.saved'), check: (value) => (value === null ? conflict : '') });
        if (!done) {
          if (conflict !== '') patchEditor({ error: conflict });
          return;
        }
        const file = done.value && typeof done.value.file === 'string' ? done.value.file : editor.file;
        setEditor(null);
        if (file) {
          setSelected(file);
          setReloadKey((key) => key + 1);
        }
      };
      const removeSelected = async () => {
        const done = await run('delete', () => backend.deleteFile(selected), { success: t('notice.deleted') });
        if (done) setSelected('');
      };
      const toggleHistory = () => {
        if (history.open) {
          setHistory((current) => ({ ...current, open: false }));
          return;
        }
        if (history.data) {
          setHistory((current) => ({ ...current, open: true }));
          return;
        }
        const target = selected;
        setHistory({ open: true, phase: 'loading', data: null, error: '' });
        backend.fileHistory(target).then(
          (data) => setHistory((current) => (current.open ? { open: true, phase: 'ready', data, error: '' } : current)),
          (error) => setHistory((current) => (current.open ? { open: true, phase: 'error', data: null, error: errorText(error, t) } : current)),
        );
      };
      const onKeyDown = (event) => {
        if (event.key !== 'Escape') return;
        if (editor) setEditor(null);
        else if (selected !== '') setSelected('');
      };

      // ---- list pane ------------------------------------------------------
      const toolbar = h(
        'div',
        { className: 'ccm-toolbar' },
        h(
          'label',
          { className: 'ccm-search' },
          h('span', { className: 'ccm-search-icon' }, icon('search', 15)),
          h('input', {
            className: 'ccm-input',
            type: 'text',
            value: query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.placeholder'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape' && query !== '') {
                event.stopPropagation();
                setQuery('');
              }
            },
          }),
          query !== ''
            ? h(
                'button',
                { type: 'button', className: 'ccm-search-clear', 'aria-label': t('btn.clear'), onClick: () => setQuery('') },
                icon('close', 13),
              )
            : null,
        ),
        readOnly
          ? null
          : h(
              'button',
              { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle, onClick: startNew },
              icon('plus', 15),
              t('btn.new'),
            ),
      );

      const typeFilters = h(
        'div',
        { className: 'ccm-filters' },
        ['', ...MEMORY_TYPES].map((value) => {
          const n = value === '' ? typeCounts.all : typeCounts[value];
          if (value !== '' && n === 0 && type !== value) return null;
          return h(
            'button',
            {
              key: value || 'all',
              type: 'button',
              className: 'ccm-chip',
              'aria-pressed': type === value ? 'true' : 'false',
              style: value ? typeStyle(value) : undefined,
              onClick: () => setType(value),
            },
            value ? h('span', { className: 'ccm-dot' }) : null,
            t(value ? 'type.' + value : 'type.all'),
            h('span', { className: 'ccm-chip-n' }, String(n)),
          );
        }),
        h('span', { className: 'ccm-spacer' }),
      );

      // Trust filter: only the states that actually occur, plus "any".
      const trustOptions = TRUST_FILTERS.filter((value) => trustCounts[value] > 0 || trust === value);
      // One state that covers every note cannot narrow the list; skip the control.
      const trustUseless = trust === '' && trustOptions.length === 1 && trustCounts[trustOptions[0]] === entries.length;
      const trustFilter =
        trustOptions.length === 0 || trustUseless
          ? null
          : h(
              'div',
              { className: 'ccm-seg', role: 'group', 'aria-label': t('trust.all') },
              ['', ...trustOptions].map((value) =>
                h(
                  'button',
                  {
                    key: value || 'any',
                    type: 'button',
                    'aria-pressed': trust === value ? 'true' : 'false',
                    onClick: () => setTrust(value),
                  },
                  value ? icon(TRUST_ICONS[value === 'unverified' ? 'unverified' : value], 11) : null,
                  t(value ? 'trust.' + value : 'trust.all'),
                  value ? h('span', { className: 'ccm-seg-n' }, String(trustCounts[value])) : null,
                ),
              ),
            );

      let list;
      if (entries.length === 0) {
        list = h(EmptyState, {
          icon: 'book',
          title: t('list.emptyTitle'),
          text: t('list.emptyBody'),
          action:
            readOnly || editor
              ? null
              : h(
                  'button',
                  { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle, onClick: startNew },
                  icon('plus', 15),
                  t('btn.new'),
                ),
        });
      } else if (visible.length === 0) {
        list = h(
          'div',
          { className: 'ccm-card ccm-none' },
          query.trim() !== '' ? t('search.empty', { q: query.trim() }) : t('list.filterEmpty'),
        );
      } else {
        list = h(
          'div',
          { className: 'ccm-card ccm-rows' },
          visible.map((entry) => {
            const hit = hits.get(entry.file);
            return h(
              'button',
              {
                key: entry.file,
                type: 'button',
                className: 'ccm-row' + (trustOf(entry) === 'stale' ? ' is-stale' : ''),
                'aria-current': entry.file === selected ? 'true' : undefined,
                onClick: () => open(entry.file),
                onKeyDown: rowKeyDown,
              },
              h('span', { className: 'ccm-dot', style: typeStyle(entry.type) }),
              h(
                'span',
                { className: 'ccm-row-main' },
                h('span', { className: 'ccm-row-name' }, entry.name || entry.file),
                entry.description ? h('span', { className: 'ccm-row-desc' }, entry.description) : null,
                hit && hit.snippet && query.trim() !== '' ? h('span', { className: 'ccm-row-snippet' }, hit.snippet) : null,
              ),
              h(
                'span',
                { className: 'ccm-row-side' },
                h('span', { className: 'ccm-row-time', title: entry.modified }, ago(entry.modified, t)),
                h(TrustBadge, { entry, t }),
              ),
            );
          }),
        );
      }

      // ---- detail / editor pane --------------------------------------------
      let detail = null;
      if (editor) {
        detail = h(
          'section',
          { className: 'ccm-card ccm-detail' },
          h(
            'div',
            { className: 'ccm-detail-bar' },
            h('span', { className: 'ccm-card-title' }, editor.mode === 'new' ? t('edit.newTitle') : t('edit.editTitle')),
            h('span', { className: 'ccm-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'ccm-btn ccm-btn-ghost ccm-btn-sm ccm-icon-btn',
                'aria-label': t('btn.cancel'),
                onClick: () => setEditor(null),
              },
              icon('close', 15),
            ),
          ),
          h(
            'form',
            {
              className: 'ccm-form',
              onSubmit: (event) => {
                event.preventDefault();
                saveEditor();
              },
            },
            editor.trusted ? h('div', { className: 'ccm-hint-box' }, t('edit.reverifyHint')) : null,
            h(
              Field,
              { label: t('edit.name') },
              h('input', {
                className: 'ccm-input',
                value: editor.name,
                autoFocus: editor.mode === 'new',
                placeholder: t('edit.namePlaceholder'),
                onChange: (event) => patchEditor({ name: event.target.value, error: '' }),
              }),
            ),
            h(
              'div',
              { className: 'ccm-field' },
              h('span', { className: 'ccm-label' }, t('edit.type')),
              h(
                'div',
                { className: 'ccm-filters', role: 'radiogroup', 'aria-label': t('edit.type') },
                MEMORY_TYPES.map((value) =>
                  h(
                    'button',
                    {
                      key: value,
                      type: 'button',
                      role: 'radio',
                      className: 'ccm-chip',
                      'aria-checked': editor.type === value ? 'true' : 'false',
                      'aria-pressed': editor.type === value ? 'true' : 'false',
                      style: typeStyle(value),
                      onClick: () => patchEditor({ type: value }),
                    },
                    h('span', { className: 'ccm-dot' }),
                    t('type.' + value),
                  ),
                ),
              ),
              h('span', { className: 'ccm-help' }, t('edit.typeHint.' + editor.type)),
            ),
            h(
              Field,
              { label: t('edit.description'), help: t('edit.descriptionHint') },
              h('input', {
                className: 'ccm-input',
                value: editor.description,
                onChange: (event) => patchEditor({ description: event.target.value }),
              }),
            ),
            h(
              Field,
              { label: t('edit.content') },
              h('textarea', {
                className: 'ccm-textarea',
                rows: 12,
                value: editor.content,
                placeholder: t('edit.contentPlaceholder'),
                onChange: (event) => patchEditor({ content: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    saveEditor();
                  }
                },
              }),
            ),
            editor.error ? h('div', { className: 'ccm-inline-error' }, editor.error) : null,
            h(
              'div',
              { className: 'ccm-form-actions' },
              h('button', { type: 'button', className: 'ccm-btn', onClick: () => setEditor(null) }, t('btn.cancel')),
              h(
                'button',
                { type: 'submit', className: 'ccm-btn ccm-btn-primary', disabled: !idle },
                busy === 'save' ? t('btn.saving') : t('btn.save'),
              ),
            ),
          ),
        );
      } else if (selected !== '') {
        const file = doc.file;
        const via = viaLabel((file && file.via) || (selectedEntry && selectedEntry.via), t);
        const updated = selectedEntry ? formatTime(timeOf(selectedEntry.modified)) : '';
        const created = formatTime(timeOf((file && file.created) || (selectedEntry && selectedEntry.created)));
        const session = (file && file.sourceSession) || (selectedEntry && selectedEntry.sourceSession) || '';
        let body;
        if (doc.phase === 'error') body = h('div', { className: 'ccm-inline-error' }, doc.error || t('detail.missing'));
        else if (!file) body = h('div', { className: 'ccm-md ccm-muted' }, t('detail.loading'));
        else {
          // `[[slug]]` between notes (e.g. Dream's `Related:` line) opens that note.
          const linked = (slug) => entries.find((entry) => entry.file === String(slug || '') + '.md') || null;
          body = h(NoteBody, {
            body: file.body,
            t,
            options: { onWikiLink: (slug) => linked(slug) && open(linked(slug).file), hasPage: (slug) => linked(slug) !== null },
          });
        }

        let historyBlock = null;
        if (canHistory && doc.phase === 'ready') {
          let content = null;
          if (history.open) {
            if (history.phase === 'loading') content = h('div', { className: 'ccm-note' }, t('detail.loading'));
            else if (history.phase === 'error') content = h('div', { className: 'ccm-note ccm-note-error' }, history.error);
            else if (history.data) {
              const rows = history.data.refs.map((ref) =>
                h(
                  'li',
                  { key: ref.type + ref.id },
                  h('time', null, formatTime(ref.at) || ref.id),
                  h('span', null, t('detail.historyDream', { n: ref.ops })),
                ),
              );
              if (rows.length === 0 && history.data.changelog.length === 0) {
                content = h('div', { className: 'ccm-note' }, t('detail.historyEmpty'));
              } else {
                content = h(
                  React.Fragment,
                  null,
                  rows.length > 0 ? h('ul', { className: 'ccm-timeline' }, rows) : null,
                  history.data.changelog.length > 0
                    ? h('pre', { className: 'ccm-pre', style: { marginTop: 8 } }, history.data.changelog.join('\n'))
                    : null,
                );
              }
            }
          }
          historyBlock = h(
            'div',
            { className: 'ccm-sub' },
            h(
              'button',
              {
                type: 'button',
                className: 'ccm-fold ccm-fold-inline',
                'aria-expanded': history.open ? 'true' : 'false',
                onClick: toggleHistory,
              },
              h('span', { className: 'ccm-chev' + (history.open ? ' is-open' : '') }, icon('chevron', 12)),
              icon('history', 13),
              t('detail.history'),
            ),
            content,
          );
        }

        detail = h(
          'section',
          { className: 'ccm-card ccm-detail' },
          h(
            'div',
            { className: 'ccm-detail-bar' },
            h(
              'button',
              { type: 'button', className: 'ccm-btn ccm-btn-ghost ccm-btn-sm ccm-only-narrow', onClick: () => setSelected('') },
              icon('back', 14),
              t('btn.back'),
            ),
            h('span', { className: 'ccm-spacer' }),
            readOnly
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'ccm-btn ccm-btn-sm',
                    disabled: doc.phase !== 'ready' || !idle,
                    onClick: startEdit,
                  },
                  icon('edit', 14),
                  t('btn.edit'),
                ),
            readOnly || !status.config.dreamAllowDelete
              ? null
              : h(ConfirmButton, {
                  small: true,
                  tone: 'danger',
                  className: 'ccm-btn-danger',
                  icon: 'trash',
                  label: t('btn.delete'),
                  confirmLabel: t('btn.confirmDelete'),
                  disabled: !idle || doc.phase === 'error',
                  onConfirm: removeSelected,
                  t,
                }),
            h(
              'button',
              {
                type: 'button',
                className: 'ccm-btn ccm-btn-ghost ccm-btn-sm ccm-icon-btn ccm-only-wide',
                'aria-label': t('btn.close'),
                title: t('btn.close'),
                onClick: () => setSelected(''),
              },
              icon('close', 15),
            ),
          ),
          h(
            'div',
            { className: 'ccm-detail-body' },
            selectedEntry
              ? h(
                  'div',
                  { className: 'ccm-detail-tags' },
                  h(TypeTag, { type: selectedEntry.type, t }),
                  h(TrustBadge, { entry: selectedEntry, t }),
                )
              : null,
            h('h2', { className: 'ccm-detail-name' }, selectedEntry ? selectedEntry.name : selected),
            selectedEntry && selectedEntry.description
              ? h('p', { className: 'ccm-detail-desc' }, selectedEntry.description)
              : null,
            selectedEntry ? h(TrustLine, { entry: selectedEntry, t }) : null,
            body,
            historyBlock,
            h(
              'div',
              { className: 'ccm-meta' },
              updated ? h('span', null, t('detail.updated', { time: updated })) : null,
              created && created !== updated ? h('span', null, t('detail.created', { time: created })) : null,
              via ? h('span', null, via) : null,
              session ? h('span', { title: session }, t('detail.session', { id: session.slice(0, 8) })) : null,
              h('span', { className: 'ccm-mono' }, selected),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'ccm-split' + (detail ? ' has-detail' : ''), onKeyDown },
        h(
          'div',
          { className: 'ccm-listpane' },
          toolbar,
          typeFilters,
          trustFilter ? h('div', { className: 'ccm-filters' }, trustFilter) : null,
          list,
        ),
        detail,
      );
    }

    // -----------------------------------------------------------------------
    // Inbox tab: every decision waiting for the user in one place.
    // -----------------------------------------------------------------------
    function InboxTab(props) {
      const { status, backend, t, goTo, readOnly, busy, run } = props;
      const [open, setOpen] = React.useState('');
      const waiting = planWaiting(status);
      const proposals = Array.isArray(status.inbox?.items) ? status.inbox.items : [];
      const enableExtract = status.config?.autoExtract === true;
      const idle = busy === '';

      const accept = (id) =>
        run('inbox', () => backend.inbox('accept', id), {
          success: (value) => t('notice.inboxAccepted', { n: value?.applied ?? 0 }),
          check: (value) =>
            value && value.ok === false
              ? new Error(t('inbox.acceptFailed', {
                  applied: value.applied ?? 0,
                  total: (value.applied ?? 0) + (value.failed ?? 0),
                }))
              : '',
        });
      const discard = (id) =>
        run('inbox', () => backend.inbox('discard', id), { success: t('notice.inboxDiscarded') });

      if (!waiting && proposals.length === 0) {
        const reason = status.state.lastExtractReason;
        const time = formatTime(status.state.lastExtractAt || status.state.lastExtractAttemptAt);
        return h(EmptyState, {
          icon: enableExtract ? 'check' : 'inbox',
          tone: enableExtract ? 'ok' : undefined,
          title: enableExtract ? t('inbox.emptyTitle') : t('inbox.offTitle'),
          text: enableExtract
            ? reason && reason !== 'inbox'
              ? t('inbox.lastExtract', { reason, time: time || '—' })
              : t('inbox.emptyBody')
            : t('inbox.emptyOffBody'),
          action: enableExtract
            ? null
            : h(
                'button',
                { type: 'button', className: 'ccm-btn', onClick: () => goTo('settings') },
                t('tab.settings'),
                icon('chevron', 14),
              ),
        });
      }

      const planCard = waiting
        ? h(
            'section',
            { className: 'ccm-card ccm-plan-cta' },
            h('div', { className: 'ccm-empty-icon' }, icon('sparkle', 20)),
            h(
              'div',
              { className: 'ccm-setting-text' },
              h('div', { className: 'ccm-setting-name' }, t('inbox.planTitle')),
              h('div', { className: 'ccm-setting-hint' }, t('inbox.planBody')),
            ),
            h(
              'button',
              { type: 'button', className: 'ccm-btn ccm-btn-primary', onClick: () => goTo('tidy') },
              t('btn.review'),
              icon('chevron', 14),
            ),
          )
        : null;

      const proposalCards = proposals.map((proposal) => {
        const expanded = open === proposal.id;
        const names = proposal.items.map((note) => note.name).filter(Boolean);
        return h(
          'section',
          { className: 'ccm-card', key: proposal.id },
          h(
            'div',
            { className: 'ccm-card-head' },
            h('span', { className: 'ccm-card-title' }, t('inbox.extractTitle')),
            h('span', { className: 'ccm-card-sub' }, formatTime(proposal.createdAt) || proposal.id),
          ),
          h(
            'p',
            { className: 'ccm-card-text' },
            t('inbox.extractBody', { n: proposal.count }),
            names.length > 0 ? ' ' + names.slice(0, 4).join('、') : '',
          ),
          h(
            'div',
            { className: 'ccm-card-body' },
            !expanded
              ? null
              : proposal.items.map((note, index) =>
                  h(
                    'div',
                    { key: index, style: { padding: '12px 0', borderTop: index > 0 ? '1px solid var(--ccm-line)' : 0 } },
                    h(
                      'div',
                      { className: 'ccm-inbox-head' },
                      h(TypeTag, { type: note.type, t }),
                      h('span', { className: 'ccm-inbox-name' }, note.name),
                    ),
                    note.description ? h('div', { className: 'ccm-inbox-desc' }, note.description) : null,
                    note.content ? h('pre', { className: 'ccm-pre', style: { marginTop: 8 } }, note.content) : null,
                  ),
                ),
            h(
              'button',
              {
                type: 'button',
                className: 'ccm-btn ccm-btn-sm ccm-btn-ghost',
                'aria-expanded': expanded ? 'true' : 'false',
                onClick: () => setOpen(expanded ? '' : proposal.id),
              },
              h('span', { className: 'ccm-chev' + (expanded ? ' is-open' : '') }, icon('chevron', 13)),
              expanded ? t('btn.close') : t('btn.review'),
            ),
          ),
          h(
            'div',
            { className: 'ccm-foot' },
            h('span', { className: 'ccm-spacer' }),
            readOnly ? h('span', { className: 'ccm-card-sub' }, t('inbox.commandHint')) : null,
            h(ConfirmButton, {
              tone: 'danger',
              className: 'ccm-btn-ghost',
              label: t('inbox.discard'),
              disabled: !idle || readOnly,
              onConfirm: () => discard(proposal.id),
              t,
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'ccm-btn ccm-btn-primary',
                disabled: !idle || readOnly,
                onClick: () => accept(proposal.id),
              },
              t('inbox.accept'),
            ),
          ),
        );
      });

      return h(React.Fragment, null, planCard, ...proposalCards);
    }


    // -----------------------------------------------------------------------
    // Dream tab: estimate -> plan -> review and apply selected -> undo.
    // -----------------------------------------------------------------------
    function DreamTab(props) {
      const { status, backend, t, busy, run, notify, readOnly, refresh } = props;
      const [history, setHistory] = React.useState(status.dreamHistory.items);
      const [estimate, setEstimate] = React.useState(null);
      const [live, setLive] = React.useState(null);
      const [focus, setFocus] = React.useState('');
      const state = status.state;
      const config = status.config;
      const pending = state.pendingSwitch;
      const idle = busy === '';
      const canRun = !readOnly && config.enabled && config.autoMemoryEnabled;
      // A background run reports its own progress; /status only carries a log.
      const runs = Array.isArray(status.dreamRuns) ? status.dreamRuns : [];
      const shownRun = live || runs[0] || null;
      const running = Boolean(shownRun && (shownRun.status === 'running' || shownRun.status === 'cancelling'));
      const showRun = backend.mode === 'api' && shownRun !== null &&
        (shownRun.status === 'running' || shownRun.status === 'cancelling' || shownRun.status === 'failed' ||
          shownRun.status === 'cancelled' || shownRun.status === 'blocked' || shownRun.status === 'skipped');

      React.useEffect(() => {
        if (!showRun || !running || readOnly) return undefined;
        let cancelled = false;
        let polling = false;
        const timer = setInterval(() => {
          if (polling) return;
          polling = true;
          backend.dream('status', { runId: shownRun.runId }).then(
            (value) => {
              if (cancelled || !value) return;
              setLive(value);
              // A finished run leaves a result to switch to; reload the page data.
              if (value.status !== 'running' && value.status !== 'cancelling') refresh();
            },
            () => {
              /* polling is best effort: the next tick retries */
            },
          ).finally(() => {
            polling = false;
          });
        }, 2500);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [showRun, running, shownRun && shownRun.runId, shownRun && shownRun.status, readOnly, backend]);

      // History is not part of /status; reload it whenever the status reloads.
      React.useEffect(() => {
        if (readOnly || typeof backend.dreamHistory !== 'function') return undefined;
        let cancelled = false;
        backend.dreamHistory().then(
          (result) => {
            if (!cancelled) setHistory(result.items);
          },
          () => {
            /* history is optional: keep what we have */
          },
        );
        return () => {
          cancelled = true;
        };
      }, [status, readOnly, backend]);

      const generate = async () => {
        setEstimate(null);
        const done = await run('estimate', async () => {
          const result = await backend.dream('estimate', { focus });
          if (!result || result.rough !== true || !Number.isFinite(result.estimatedTokens) ||
              result.estimatedTokens < 0 || !Number.isFinite(result.limit) || result.limit < 0) {
            throw new Error(t('tidy.estimateUnavailable'));
          }
          return result;
        }, { refresh: false });
        if (done) setEstimate(done.value);
      };

      const startDream = async () => {
        // v23: the confirmation covered a priced range; send it so a session
        // that grew in between cannot add work the user did not approve.
        const pinned = estimate && typeof estimate === 'object'
          ? { inputId: typeof estimate.inputId === 'string' ? estimate.inputId : '', inputRanges: Array.isArray(estimate.ranges) ? estimate.ranges : null }
          : {};
        setEstimate(null);
        const started = await run('start', () => backend.dream('start', { focus, ...pinned }), {
          check: (result) => (result && result.ok === false ? result.error || 'failed' : ''),
          refresh: false,
        });
        if (!started) return;
        const value = started.value || {};
        if (value.started === false) {
          notify('ok', t('tidy.runAlready'));
          return;
        }
        notify('ok', t('tidy.runStarted'));
        setLive({ ...value, status: value.status || 'running' });
      };

      const runAction = async (action, key) => {
        if (!shownRun) return;
        const done = await run(key, () => backend.dream(action, { runId: shownRun.runId }), {
          check: (result) => (result && result.ok === false ? result.error || 'failed' : ''),
          refresh: false,
        });
        if (!done) return;
        const value = done.value || {};
        if (action === 'resume') {
          setLive({ ...(shownRun || {}), ...value, status: value.status || 'running' });
          return;
        }
        setLive({ ...(shownRun || {}), ...value, status: action === 'cancel' ? 'cancelling' : 'cancelled' });
      };

      const switchTo = () =>
        run('switch', () => backend.dream('switch'), {
          check: (result) => {
            if (!result || result.switched === true) return '';
            if (result.error === 'conflict' && Array.isArray(result.conflicts)) {
              return t('tidy.switchConflict', { files: result.conflicts.map((item) => item.file).join(', ') });
            }
            return result.message || result.error || 'failed';
          },
          success: t('tidy.switched'),
        });

      const discard = () =>
        run('discard', () => backend.dream('discard'), { success: t('tidy.discarded') });

      const undo = () =>
        run('undo', () => backend.dream('undo'), {
          check: (result) => {
            if (!result || result.ok !== false) return '';
            if (result.error === 'conflict' && Array.isArray(result.conflicts)) {
              return t('tidy.undoConflict', { files: result.conflicts.map((item) => item.file).join(', ') });
            }
            return result.message || result.error || 'failed';
          },
          success: t('tidy.undone'),
        });

      const runStatus = shownRun ? shownRun.status || 'idle' : 'idle';
      const runTone = runStatus === 'running' || runStatus === 'cancelling' ? ' ccm-pill-accent' : runStatus === 'failed' ? ' ccm-pill-danger' : '';
      const runCard = showRun
        ? h(
            'section',
            { className: 'ccm-card' },
            h(
              'div',
              { className: 'ccm-card-head' },
              h('span', { className: 'ccm-card-title' }, t('tidy.runTitle')),
              h('span', { className: 'ccm-pill' + runTone }, t('tidy.runState.' + runStatus)),
            ),
            shownRun.stage ? h('p', { className: 'ccm-card-text' }, shownRun.stage) : null,
            shownRun.error ? h('p', { className: 'ccm-card-text ccm-note-error' }, String(shownRun.error)) : null,
            running ? h('div', { className: 'ccm-card-body' }, h('div', { className: 'ccm-progress' })) : null,
            running || runStatus === 'cancelled' || runStatus === 'failed'
              ? h(
                  'div',
                  { className: 'ccm-foot' },
                  running
                    ? h('button', { type: 'button', className: 'ccm-btn', disabled: !idle || readOnly || runStatus === 'cancelling', onClick: () => runAction('cancel', 'cancel') }, t('tidy.runCancel'))
                    : h('button', { type: 'button', className: 'ccm-btn', disabled: !idle || readOnly, onClick: () => runAction('resume', 'resume') }, icon('refresh', 14), t('tidy.runResume')),
                )
              : null,
          )
        : null;

      const pendingFiles = pending && Array.isArray(pending.files) ? pending.files : [];
      const resultCard = pending
        ? h(
            'section',
            { className: 'ccm-card' },
            h(
              'div',
              { className: 'ccm-card-head' },
              h('span', { className: 'ccm-card-title' }, t('tidy.resultTitle')),
              h('span', { className: 'ccm-spacer' }),
              h(
                'span',
                { className: 'ccm-card-sub' },
                t('tidy.resultCounts', {
                  added: asNumber(pending.added, 0),
                  changed: asNumber(pending.changed, 0),
                  removed: asNumber(pending.removed, 0),
                }),
              ),
            ),
            pending.summary ? h('p', { className: 'ccm-plan-summary' }, String(pending.summary).slice(0, 400)) : null,
            pendingFiles.slice(0, 20).map((item, index) => {
              const kind = item.action === 'added' ? 'create' : item.action === 'removed' ? 'delete' : item.file === 'MEMORY.md' ? 'index' : 'update';
              return h(
                'div',
                { key: index, className: 'ccm-op' },
                h(
                  'div',
                  { className: 'ccm-op-row' },
                  h('span', { className: 'ccm-opkind', 'data-kind': kind }, t('tidy.op.' + kind)),
                  h('span', { className: 'ccm-op-file' }, String(item.file || 'MEMORY.md')),
                ),
              );
            }),
            pendingFiles.length > 20 ? h('div', { className: 'ccm-notes' }, h('div', { className: 'ccm-note' }, t('err.more', { n: pendingFiles.length - 20 }))) : null,
            h(
              'div',
              { className: 'ccm-foot' },
              h('button', { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle || readOnly, onClick: switchTo }, icon('check', 14), t('tidy.switch')),
              h('span', { className: 'ccm-spacer' }),
              h(ConfirmButton, { tone: 'danger', className: 'ccm-btn-ghost ccm-btn-danger', label: t('tidy.discard'), disabled: !idle || readOnly, onConfirm: discard, t }),
            ),
          )
        : null;

      const estimating = busy === 'estimate' || busy === 'start';
      const hero = h(
        'section',
        { className: 'ccm-card ccm-hero' },
        h('div', { className: 'ccm-empty-icon' }, icon('sparkle', 22)),
        h('div', { className: 'ccm-hero-title' }, t('tidy.title')),
        h('p', { className: 'ccm-hero-text' }, t('tidy.intro')),
        canRun
          ? h(
              Field,
              { label: t('tidy.focus') },
              h('input', {
                className: 'ccm-input',
                value: focus,
                disabled: !idle || running,
                placeholder: t('tidy.focusPlaceholder'),
                onChange: (event) => {
                  setFocus(event.target.value);
                  // The estimate priced the old focus; ask again for the new one.
                  setEstimate(null);
                },
              }),
            )
          : null,
        estimating ? h('div', { className: 'ccm-progress', style: { maxWidth: 520 } }) : null,
        estimate
          ? h(
              React.Fragment,
              null,
              h(
                'p',
                { className: 'ccm-hero-text', style: { margin: 0 } },
                estimate.limit > 0
                  ? t('tidy.estimateLine', { tokens: formatNumber(estimate.estimatedTokens), limit: formatNumber(estimate.limit) })
                  : t('tidy.estimateNoLimit', { tokens: formatNumber(estimate.estimatedTokens) }),
              ),
              h(
                'div',
                { className: 'ccm-toolbar' },
                h(
                  'button',
                  { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle || !canRun || running, onClick: startDream },
                  icon('sparkle', 15),
                  t('tidy.start'),
                ),
                h('button', { type: 'button', className: 'ccm-btn ccm-btn-ghost', disabled: !idle, onClick: () => setEstimate(null) }, t('btn.cancel')),
              ),
            )
          : h(
              'button',
              { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle || !canRun || running, onClick: generate },
              icon('sparkle', 15),
              t('tidy.generate'),
            ),
      );

      const batches = history.slice(0, 5);
      const undoTarget = batches.find((item) => item.undoable);
      const historyCard = batches.length > 0
        ? h(
            'section',
            { className: 'ccm-card' },
            h('div', { className: 'ccm-card-head' }, h('span', { className: 'ccm-card-title' }, t('tidy.historyTitle'))),
            batches.map((item) =>
              h(
                'div',
                { key: item.ts, className: 'ccm-hist' },
                h(
                  'div',
                  { className: 'ccm-row-main' },
                  h('span', { className: 'ccm-row-desc', style: { color: 'var(--ccm-fg)' } }, item.summary || t('tidy.opsCount', { n: item.ops })),
                  h(
                    'span',
                    { className: 'ccm-row-time' },
                    [formatTime(item.appliedAt) || item.ts, t('tidy.opsCount', { n: item.ops })].join(' · '),
                  ),
                ),
                item.undone ? h('span', { className: 'ccm-pill' }, t('tidy.undoneTag')) : null,
                undoTarget && undoTarget.ts === item.ts && !readOnly
                  ? h(ConfirmButton, { small: true, icon: 'undo', label: t('tidy.undo'), disabled: !idle, onConfirm: undo, t })
                  : null,
              ),
            ),
          )
        : null;

      return h(React.Fragment, null, runCard, resultCard, hero, historyCard);
    }

    // -----------------------------------------------------------------------
    // Settings tab
    // -----------------------------------------------------------------------
    function SettingsTab(props) {
      const { status, backend, t, busy, run, notify, readOnly } = props;
      const [draft, setDraft] = React.useState(null);
      const [fold, setFold] = React.useState('');
      const [lists, setLists] = React.useState({ trash: null, backup: null });
      const [openBatch, setOpenBatch] = React.useState('');
      const config = status.config;
      const rules = status.rules;
      const idle = busy === '';

      const toggle = (key, value) =>
        run('toggle', () => backend.toggle({ [key]: value }), { success: t('notice.toggled') });
      const switches = [
        ['enabled', 'settings.enabled', 'settings.enabledHint', config.enabled, false],
        ['autoMemoryEnabled', 'settings.autoMemory', 'settings.autoMemoryHint', config.autoMemoryEnabled, !config.enabled],
        ['autoDreamEnabled', 'settings.autoDream', 'settings.autoDreamHint', config.autoDreamEnabled, !config.enabled],
        ['autoExtract', 'settings.autoExtract', 'settings.autoExtractHint', config.autoExtract, !config.enabled || !config.autoMemoryEnabled],
      ];

      const rulesText = draft === null ? rules.text : draft;
      const dirty = draft !== null && draft !== rules.text;
      const saveRules = async (scope) => {
        const done = await run('rules', () => backend.saveRules(scope, rulesText), { success: t('notice.rulesSaved') });
        if (done) setDraft(null);
      };
      const resetRules = async () => {
        const done = await run('rules', () => backend.resetRules(), { success: t('notice.rulesReset') });
        if (done) setDraft(null);
      };

      const loadList = (kind) => {
        const request = kind === 'trash' ? backend.trash() : backend.backups();
        request.then(
          (result) => setLists((current) => ({ ...current, [kind]: { items: result.items, error: '' } })),
          (error) => setLists((current) => ({ ...current, [kind]: { items: [], error: errorText(error, t) } })),
        );
      };
      const openFold = (kind) => {
        if (fold === kind) {
          setFold('');
          return;
        }
        setFold(kind);
        setOpenBatch('');
        if (lists[kind] === null) loadList(kind);
      };
      const restore = async (kind, id, file) => {
        const done = await run('restore', () => backend.restore(kind, id, file), { success: t('notice.restored') });
        if (done) loadList(kind);
      };
      const copyPath = () => {
        const value = status.project.memoryDir || '';
        try {
          window.navigator.clipboard.writeText(value).then(
            () => notify('ok', t('notice.copied')),
            (error) => notify('error', formatError(error)),
          );
        } catch (error) {
          notify('error', formatError(error));
        }
      };

      const restoreSection = (kind, label) => {
        const isOpen = fold === kind;
        const data = lists[kind];
        let content = null;
        if (isOpen) {
          if (data === null) content = h('div', { className: 'ccm-batch' }, h('div', { className: 'ccm-note', style: { padding: '8px 0 12px' } }, t('detail.loading')));
          else if (data.error) content = h('div', { className: 'ccm-batch' }, h('div', { className: 'ccm-note ccm-note-error', style: { padding: '8px 0 12px' } }, data.error));
          else if (data.items.length === 0) content = h('div', { className: 'ccm-batch' }, h('div', { className: 'ccm-note', style: { padding: '8px 0 12px' } }, t('restore.empty')));
          else {
            content = h(
              'div',
              { className: 'ccm-batch' },
              data.items.slice(0, 20).map((item) => {
                const batchKey = kind + ':' + item.id;
                const expanded = openBatch === batchKey;
                return h(
                  'div',
                  { key: item.id },
                  h(
                    'div',
                    { className: 'ccm-batch-head' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ccm-op-toggle',
                        'aria-expanded': expanded ? 'true' : 'false',
                        onClick: () => setOpenBatch(expanded ? '' : batchKey),
                      },
                      h('span', { className: 'ccm-chev' + (expanded ? ' is-open' : '') }, icon('chevron', 13)),
                      h('span', { className: 'ccm-op-file', style: { fontFamily: 'inherit' } }, formatTime(item.at) || item.id),
                      h('span', { className: 'ccm-op-delta' }, t('restore.files', { n: item.files.length })),
                    ),
                    h(ConfirmButton, {
                      small: true,
                      icon: 'undo',
                      label: t('restore.all'),
                      disabled: !idle || readOnly,
                      onConfirm: () => restore(kind, item.id),
                      t,
                    }),
                  ),
                  expanded
                    ? item.files.map((file) =>
                        h(
                          'div',
                          { key: file, className: 'ccm-batch-file' },
                          h('span', { className: 'ccm-mono' }, file),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'ccm-btn ccm-btn-sm ccm-btn-ghost',
                              disabled: !idle || readOnly,
                              onClick: () => restore(kind, item.id, file),
                            },
                            t('restore.one'),
                          ),
                        ),
                      )
                    : null,
                );
              }),
            );
          }
        }
        return h(
          React.Fragment,
          { key: kind },
          h(
            'button',
            { type: 'button', className: 'ccm-fold', 'aria-expanded': isOpen ? 'true' : 'false', onClick: () => openFold(kind) },
            h('span', { className: 'ccm-chev' + (isOpen ? ' is-open' : '') }, icon('chevron', 14)),
            h('span', { className: 'ccm-spacer', style: { flex: 1 } }, label),
            kind === 'trash' && status.trashCount > 0 ? h('span', { className: 'ccm-card-sub' }, t('restore.files', { n: status.trashCount })) : null,
          ),
          content,
        );
      };

      // ---- what new conversations load (read-only facts) ---------------------
      const maxLines = config.indexMaxLines || 200;
      const maxBytes = config.indexMaxBytes || 25600;
      const meter = budgetMeter(status.index.lines, status.index.bytes, maxLines, maxBytes, status.index.overflow);
      const loadingCard = h(
        'section',
        { className: 'ccm-card' },
        h(
          'div',
          { className: 'ccm-card-head' },
          h('span', { className: 'ccm-card-title' }, t('settings.loading')),
          h('span', { className: 'ccm-card-sub' }, t('settings.loadingHint')),
        ),
        h(
          'dl',
          { className: 'ccm-kv' },
          h('dt', null, t('settings.mode')),
          h('dd', null, t('settings.modeIndex')),
          h('dt', null, t('settings.recall')),
          h(
            'dd',
            null,
            config.recallMode === 'model' ? t('settings.recallModel') : t('settings.recallNone'),
          ),
          h('dt', null, t('settings.perAgent')),
          h(
            'dd',
            null,
            config.subagentMemory === 'shared'
              ? t('settings.perAgentShared')
              : config.subagentMemory === 'own'
                ? config.agentMemoryPresets.length > 0
                  ? t('settings.perAgentOnList', { names: config.agentMemoryPresets.join('、') })
                  : t('settings.perAgentOn')
                : t('settings.perAgentOff'),
          ),
          h('dt', null, t('settings.indexBudget')),
          h(
            'dd',
            null,
            t('tidy.indexMeta', { lines: status.index.lines, maxLines, bytes: formatBytes(status.index.bytes), maxBytes: formatBytes(maxBytes) }),
            h('div', { className: meter.className }, h('span', { style: { width: meter.width } })),
            meter.over ? h('div', { className: 'ccm-help', style: { marginTop: 4 } }, t('settings.indexOver')) : null,
          ),
        ),
      );

      const metrics = status.metrics;
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'ccm-section' },
          h('span', { className: 'ccm-section-title' }, t('settings.switches')),
          h('span', { className: 'ccm-card-sub' }, t('settings.switchesHint')),
        ),
        h(
          'section',
          { className: 'ccm-card' },
          switches.map(([key, name, hint, value, blocked]) =>
            h(
              'div',
              { key, className: 'ccm-setting' },
              h(
                'div',
                { className: 'ccm-setting-text' },
                h('div', { className: 'ccm-setting-name' }, t(name)),
                h('div', { className: 'ccm-setting-hint' }, t(hint, { n: config.autoExtractEveryTurns || 1 })),
              ),
              h(Switch, {
                checked: value,
                label: t(name),
                disabled: !idle || readOnly || blocked,
                onChange: (next) => toggle(key, next),
              }),
            ),
          ),
        ),
        loadingCard,
        h(
          'section',
          { className: 'ccm-card' },
          h(
            'div',
            { className: 'ccm-card-head' },
            h('span', { className: 'ccm-card-title' }, t('rules.title')),
            h('span', { className: 'ccm-pill' }, t('rules.source.' + (['project', 'global'].includes(rules.source) ? rules.source : 'default'))),
          ),
          h('p', { className: 'ccm-card-text' }, t('rules.hint')),
          h(
            'div',
            { className: 'ccm-card-body' },
            h('textarea', {
              className: 'ccm-textarea',
              rows: 9,
              value: rulesText,
              placeholder: t('rules.placeholder'),
              disabled: readOnly,
              'aria-label': t('rules.title'),
              onChange: (event) => setDraft(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'ccm-foot' },
            h(
              'button',
              { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle || readOnly || !dirty, onClick: () => saveRules('project') },
              t('rules.saveProject'),
            ),
            h(
              'button',
              { type: 'button', className: 'ccm-btn', disabled: !idle || readOnly || !dirty, onClick: () => saveRules('global') },
              t('rules.saveGlobal'),
            ),
            h('span', { className: 'ccm-spacer' }),
            h('span', { className: 'ccm-card-sub' }, t('rules.count', { n: rulesText.length, max: rules.maxChars || 8000 })),
            rules.source !== 'default'
              ? h(ConfirmButton, {
                  tone: 'danger',
                  className: 'ccm-btn-ghost',
                  label: t('rules.reset'),
                  disabled: !idle || readOnly,
                  onConfirm: resetRules,
                  t,
                })
              : null,
          ),
        ),
        h(
          'section',
          { className: 'ccm-card' },
          h('div', { className: 'ccm-card-head' }, h('span', { className: 'ccm-card-title' }, t('restore.title'))),
          h('p', { className: 'ccm-card-text' }, t('restore.hint')),
          restoreSection('trash', t('restore.trash')),
          restoreSection('backup', t('restore.backups')),
        ),
        h(
          'section',
          { className: 'ccm-card' },
          h('div', { className: 'ccm-card-head' }, h('span', { className: 'ccm-card-title' }, t('about.title'))),
          h(
            'div',
            { className: 'ccm-card-body' },
            h('div', { className: 'ccm-label' }, t('about.dir')),
            h(
              'div',
              { className: 'ccm-path' },
              h('code', { title: status.project.memoryDir || '' }, status.project.memoryDir || '—'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ccm-btn ccm-btn-sm ccm-icon-btn',
                  'aria-label': t('btn.copy'),
                  title: t('btn.copy'),
                  disabled: !status.project.memoryDir,
                  onClick: copyPath,
                },
                icon('copy', 14),
              ),
            ),
            metrics.hasData
              ? h(
                  'div',
                  { className: 'ccm-help', style: { marginTop: 12 } },
                  t('about.usage', {
                    inject: metrics.injections.count,
                    reads: metrics.reads.total,
                    writes: metrics.writes.total,
                    searches: metrics.searches.count,
                  }),
                )
              : null,
            status.version
              ? h(
                  'div',
                  { className: 'ccm-help', style: { marginTop: 6 } },
                  `${t('about.version', { v: status.version })}${status.build?.id ? ` · ${status.build.id}` : ''}`,
                )
              : null,
          ),
        ),
      );
    }

    // -----------------------------------------------------------------------
    // MemoryView (conversation.view)
    // -----------------------------------------------------------------------
    function MemoryViewReady(props) {
      return h(ViewBoundary, null, h(MemoryView, props));
    }

    function MemoryView(props) {
      const t = resolveT(props);
      const backend = resolveBackend(props);
      const [tab, setTab] = React.useState(readStoredTab);
      const [load, setLoad] = React.useState({ phase: 'loading', status: null, error: null });
      const [busy, setBusy] = React.useState('');
      const [toast, setToast] = React.useState(null);
      const [focusFile, setFocusFile] = React.useState('');
      const alive = React.useRef(true);
      const busyRef = React.useRef('');
      const scrollRef = React.useRef(null);

      React.useEffect(
        () => () => {
          alive.current = false;
        },
        [],
      );

      // Visible height of the scroll area: caps the sticky detail pane so its
      // own content (e.g. the editor's Save button) always stays reachable.
      React.useEffect(() => {
        const node = scrollRef.current;
        if (!node || !node.style) return undefined;
        const measure = () => node.style.setProperty('--ccm-vh', node.clientHeight + 'px');
        measure();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
      }, [load.phase]);

      const refreshSeq = React.useRef(0);
      const refreshInFlight = React.useRef(null);
      const refresh = React.useCallback(async () => {
        if (backend === null || backend.mode === 'none') {
          if (alive.current) setLoad({ phase: 'error', status: null, error: new Error('no-backend') });
          return null;
        }
        // One poll at a time: a burst of clicks (or a timer tick landing on a
        // slow request) shares the same read instead of queueing another one.
        if (refreshInFlight.current !== null) return refreshInFlight.current;
        const mine = refreshSeq.current + 1;
        refreshSeq.current = mine;
        const task = (async () => {
          try {
            const status = await backend.status();
            // An older answer must never overwrite a newer list.
            if (alive.current && mine === refreshSeq.current) setLoad({ phase: 'ready', status, error: null });
            return status;
          } catch (error) {
            if (alive.current && mine === refreshSeq.current) {
              setLoad((current) =>
                current.status ? { ...current, error } : { phase: 'error', status: null, error },
              );
            }
            return null;
          } finally {
            refreshInFlight.current = null;
          }
        })();
        refreshInFlight.current = task;
        return task;
      }, [backend]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      // A detailed error (a list of reasons) stays until it is closed.
      React.useEffect(() => {
        if (toast === null || toast.items.length > 0) return undefined;
        const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      const notify = (kind, text, items) =>
        setToast({ kind, text, items: Array.isArray(items) ? items : [], id: Date.now() });
      const notifyError = (error) => {
        const info = errorInfo(error, t);
        notify('error', info.text, info.items);
      };

      /**
       * Run one user action: one at a time, toast on success or failure, then
       * reload the status. Resolves `{value}` on success and `null` otherwise.
       */
      const run = async (key, task, options = {}) => {
        if (busyRef.current !== '') return null;
        busyRef.current = key;
        setBusy(key);
        let outcome = null;
        try {
          const value = await task();
          const failure = options.check ? options.check(value) : '';
          if (failure) {
            notifyError(failure);
          } else {
            if (options.success) {
              notify('ok', typeof options.success === 'function' ? options.success(value) : options.success);
            }
            outcome = { value };
          }
        } catch (error) {
          notifyError(error);
        }
        if (options.refresh !== false) await refresh();
        busyRef.current = '';
        if (alive.current) setBusy('');
        return outcome;
      };

      const selectTab = (value) => {
        setTab(value);
        storeTab(value);
        const node = scrollRef.current;
        if (node && typeof node.scrollTo === 'function') node.scrollTo(0, 0);
      };
      const openNote = (file) => {
        setFocusFile(file);
        selectTab('memories');
      };

      const status = load.status;
      const readOnly = backend === null || backend.mode !== 'api';
      const errorMessage = load.error ? formatError(load.error) : '';
      const tokenExpired =
        load.error !== null && (load.error.status === 401 || /401|unauthori[sz]ed/i.test(errorMessage));
      const activeTab = tab;

      // ---- header ------------------------------------------------------------
      const attention = attentionCount(status);
      const summary = loadSummary(status, t);
      const tabs = [
        ['memories', t('tab.memories'), status ? h('span', { className: 'ccm-tab-n' }, String(status.entries.length)) : null],
        ['inbox', t('tab.inbox'), attention > 0 ? h('span', { className: 'ccm-badge' }, String(attention)) : null],
        ['tidy', t('tab.tidy'), status && planWaiting(status) ? h('span', { className: 'ccm-badge-dot' }) : null],
        ['settings', t('tab.settings'), null],
      ].filter(Boolean);
      const header = h(
        'header',
        { className: 'ccm-head' },
        h(
          'div',
          { className: 'ccm-head-main' },
          h(
            'h1',
            { className: 'ccm-title' },
            t('view.title'),
            status ? h('span', { className: 'ccm-title-sub' }, projectLabel(status.project)) : null,
          ),
          summary
            ? h(
                'div',
                { className: 'ccm-load', 'data-tone': summary.tone },
                icon(summary.icon, 14),
                h(
                  'span',
                  null,
                  summary.text,
                  summary.tone !== 'warn' && status.injection.recallMode === 'model'
                    ? h('span', { className: 'ccm-load-extra' }, ' ' + t('load.recall'))
                    : null,
                ),
              )
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ccm-btn ccm-btn-ghost ccm-icon-btn' + (busy === 'refresh' ? ' ccm-spinning' : ''),
            'aria-label': t('btn.refresh'),
            title: t('btn.refresh'),
            disabled: busy !== '',
            onClick: () => run('refresh', () => refresh(), { refresh: false }),
          },
          icon('refresh', 15),
        ),
      );
      const tabBar = h(
        'nav',
        { className: 'ccm-tabs', role: 'tablist', 'aria-label': t('view.title') },
        tabs.map(([value, label, badge]) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              role: 'tab',
              className: 'ccm-tab',
              'aria-selected': activeTab === value ? 'true' : 'false',
              onClick: () => selectTab(value),
            },
            label,
            badge,
          ),
        ),
      );

      // ---- banners -------------------------------------------------------------
      const banners = [];
      if (backend === null || backend.mode === 'none') {
        banners.push(h(Banner, { key: 'nb', tone: 'error', text: t('banner.noBackend'), action: reloadButton(t) }));
      }
      if (tokenExpired) {
        banners.push(h(Banner, { key: 'tk', tone: 'error', text: t('banner.tokenExpired'), action: reloadButton(t) }));
      }
      // The host keeps imported backend modules until it restarts, so a page
      // can be newer than the code answering it; say so once, up front.
      if (status && status.uiApi < UI_API) {
        banners.push(h(Banner, { key: 'stale', tone: 'error', text: t('banner.backendStale') }));
      }
      if (status && !readOnly) {
        const turnOn = (patch) =>
          h(
            'button',
            {
              type: 'button',
              className: 'ccm-btn ccm-btn-sm',
              disabled: busy !== '',
              onClick: () => run('toggle', () => backend.toggle(patch), { success: t('notice.toggled') }),
            },
            t('btn.turnOn'),
          );
        if (!status.config.enabled) {
          banners.push(h(Banner, { key: 'off', text: t('banner.pluginOff'), action: turnOn({ enabled: true }) }));
        } else if (!status.config.autoMemoryEnabled) {
          banners.push(h(Banner, { key: 'am', text: t('banner.autoMemoryOff'), action: turnOn({ autoMemoryEnabled: true }) }));
        }
      }

      // ---- body ----------------------------------------------------------------
      let body;
      if (load.phase === 'loading') {
        body = h(
          'div',
          { className: 'ccm-card', 'aria-busy': 'true' },
          [0, 1, 2, 3].map((index) =>
            h(
              'div',
              { key: index, className: 'ccm-skel-row' },
              h('span', { className: 'ccm-skel ccm-skel-dot' }),
              h(
                'span',
                { className: 'ccm-skel-lines' },
                h('span', { className: 'ccm-skel', style: { width: 46 - index * 6 + '%' } }),
                h('span', { className: 'ccm-skel', style: { width: 82 - index * 8 + '%' } }),
              ),
            ),
          ),
        );
      } else if (!status) {
        body = h(EmptyState, {
          icon: 'alert',
          title: t('error.load'),
          text: errorText(load.error, t),
          action:
            backend && backend.mode !== 'none'
              ? h('button', { type: 'button', className: 'ccm-btn', disabled: busy !== '', onClick: () => run('refresh', () => refresh(), { refresh: false }) }, t('btn.retry'))
              : null,
        });
      } else {
        const tabProps = { status, backend, t, busy, run, notify, readOnly, refresh };
        if (activeTab === 'tidy') body = h(DreamTab, tabProps);
        else if (activeTab === 'inbox') body = h(InboxTab, { ...tabProps, goTo: selectTab, openNote });
        else if (activeTab === 'settings') body = h(SettingsTab, tabProps);
        else body = h(MemoriesTab, { ...tabProps, focusFile, onFocused: () => setFocusFile('') });
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'ccm-style' }, CSS),
        h(
          'div',
          { className: 'ccm-root', 'data-cc-memory-view': '1' },
          h('div', { className: 'ccm-headbar' }, h('div', { className: 'ccm-shell' }, header, tabBar)),
          h('div', { className: 'ccm-scroll', ref: scrollRef }, h('div', { className: 'ccm-shell' }, banners, body)),
          toast
            ? h(
                'div',
                { className: 'ccm-toast-dock' },
                h(
                  'div',
                  {
                    key: toast.id,
                    className: 'ccm-toast' + (toast.kind === 'error' ? ' ccm-toast-error' : '') + (toast.items.length > 0 ? ' has-items' : ''),
                    role: 'status',
                  },
                  icon(toast.kind === 'error' ? 'alert' : 'check', 15),
                  h(
                    'div',
                    { className: 'ccm-toast-body' },
                    toast.text ? h('div', { className: 'ccm-toast-title' }, toast.text) : null,
                    toast.items.length > 0
                      ? h(
                          'ul',
                          { className: 'ccm-toast-items' },
                          toast.items.slice(0, 6).map((item, index) => h('li', { key: index }, item)),
                          toast.items.length > 6 ? h('li', { key: 'more' }, t('err.more', { n: toast.items.length - 6 })) : null,
                        )
                      : null,
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'ccm-toast-close', 'aria-label': t('btn.close'), onClick: () => setToast(null) },
                    icon('close', 13),
                  ),
                ),
              )
            : null,
        ),
      );
    }

    // -----------------------------------------------------------------------
    // Status chip (conversation.composer.dock)
    // -----------------------------------------------------------------------
    function MemoryStatusChipReady(props) {
      return h(ViewBoundary, null, h(MemoryStatusChip, props));
    }

    function MemoryStatusChip(props) {
      const t = resolveT(props);
      const backend = resolveBackend(props);
      const [status, setStatus] = React.useState(null);
      const [hidden, setHidden] = React.useState(false);

      React.useEffect(() => {
        if (backend === null || backend.mode === 'none') return undefined;
        let alive = true;
        const tick = async () => {
          try {
            const next = await backend.status();
            if (!alive) return;
            setStatus(next);
            setHidden(false);
          } catch {
            if (alive) setHidden(true);
          }
        };
        tick();
        const timer = setInterval(tick, 60000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [backend]);

      if (hidden || status === null) return null;
      const on = status.config.enabled !== false && status.config.autoMemoryEnabled !== false;
      const attention = attentionCount(status);
      const summary = loadSummary(status, t);
      return h(
        React.Fragment,
        null,
        h('style', null, CHIP_CSS),
        h(
          'div',
          {
            className: 'ccm-chip-dock',
            title: summary ? summary.text : status.project.memoryDir || t('chip.title'),
            'data-cc-memory-chip': '1',
          },
          h('span', { className: 'ccm-chip-dot', 'data-on': on ? 'true' : 'false' }),
          h('span', null, t('chip.label')),
          h('span', { className: 'ccm-chip-count' }, String(status.entries.length)),
          attention > 0 ? h('span', { className: 'ccm-chip-alert' }, '· ' + t('chip.attention', { n: attention })) : null,
        ),
      );
    }

    // -----------------------------------------------------------------------
    // Locale registration
    // -----------------------------------------------------------------------
    function makeFallbackTranslate(ctx) {
      return (key, params) => {
        let active = 'en';
        try {
          const snapshot =
            ctx && ctx.locale && typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : undefined;
          if (snapshot && typeof snapshot.active === 'string') active = snapshot.active;
        } catch {
          active = 'en';
        }
        const dictionary = String(active).toLowerCase().startsWith('zh') ? ZH : EN;
        let template = dictionary[key];
        if (typeof template !== 'string') template = EN[key];
        if (typeof template !== 'string') return key;
        if (params && typeof params === 'object') {
          template = template.replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
          );
        }
        return template;
      };
    }

    function registerDictionaries(ctx) {
      const locale = ctx && ctx.locale;
      if (!locale || typeof locale.register !== 'function') return false;
      try {
        ctx.effect(() => {
          try {
            return locale.register(NS, DICTIONARIES);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('[cc-memory] locale dictionary registration failed:', formatError(error));
            return () => {};
          }
        }, 'cc-memory: dictionaries');
        return true;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[cc-memory] locale effect registration failed:', formatError(error));
        return false;
      }
    }

    // -----------------------------------------------------------------------
    // Plugin body
    // -----------------------------------------------------------------------
    const inject = ['slots', 'locale'];

    async function apply(ctx) {
      const fallbackT = makeFallbackTranslate(ctx);

      try {
        registerDictionaries(ctx);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[cc-memory] dictionary setup failed:', formatError(error));
      }

      let boundT = fallbackT;
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') boundT = ctx.locale.bind(NS);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[cc-memory] locale bind failed:', formatError(error));
      }

      // The silent HTTP API is the only data path; page data never touches the
      // session log.
      const api = await discoverBridge();
      backendFactory = (sessionId) => createBackend({ api, sessionId });
      const backendFor = backendFactory;
      const labelT = boundT;

      // 1. Memory page
      try {
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'cc-memory',
              order: 40,
              label: () => {
                try {
                  return labelT('view.title');
                } catch {
                  return 'Memory';
                }
              },
              inject: (owner) => {
                const sessionId = sessionIdOf(owner);
                return {
                  memSessionId: sessionId,
                  memBackend: backendFor(sessionId),
                  memT: fallbackT,
                };
              },
            },
            MemoryViewReady,
          ),
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[cc-memory] memory view registration failed:', formatError(error));
      }

      // 2. Composer status chip
      try {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'cc-memory-status',
              order: 50,
              inject: () => ({ memBackend: backendFor(undefined), memT: fallbackT }),
            },
            MemoryStatusChipReady,
          ),
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[cc-memory] status chip registration failed:', formatError(error));
      }
    }

    // -----------------------------------------------------------------------
    // Test hook: pure helpers for the verifier (no DOM, no effects).
    // Exposing them must not affect rendering in any way.
    // -----------------------------------------------------------------------
    try {
      if (typeof window !== 'undefined') {
        window.__CC_MEMORY_INTERNALS__ = {
          normalizeStatus,
          normalizeFile,
          createBackend,
          renderMarkdown,
          renderInline,
          apiRequest,
          normalizeMetrics,
          normalizeReadiness,
          normalizeHealth,
          normalizeDreamHistory,
          normalizeSearch,
          normalizeTrend,
          normalizePendingSwitch,
          normalizeFileHistory,
          filterEntries,
          countByType,
          countByTrust,
          trustOf,
          matchesTrust,
          splitBody,
          loadSummary,
          errorInfo,
          reasonText,
          opKind,
          projectLabel,
          attentionCount,
          viaLabel,
          readinessText,
        };
      }
    } catch {
      /* a restricted global must not break the module */
    }

    return { inject, apply };
  },
});
