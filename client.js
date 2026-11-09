/**
 * dsh-cc-dream-memory — browser half (v4 UI).
 *
 * Two registrations:
 *  - `conversation.view` (id `cc-memory`, order 40): the Memory page, three tabs:
 *      Memories — search, type filters, one list, a detail/editor pane, and the
 *                 writes waiting for review;
 *      Dream    — one flow: create a plan, review the changes, apply the
 *                 selected ones, undo the last dream; auto dream switch;
 *      Settings — the global switches, the memory rules, trash/backup restore
 *                 and the storage location.
 *  - `conversation.composer.dock` (id `cc-memory-status`, order 50): a small
 *    ambient chip (memory count and anything waiting for review), polled 60s.
 *
 * Data comes from the silent HTTP API injected by the Host as
 * `window.__CC_MEMORY_API__ = { base, token }` — these requests never write
 * session-log command rows. Without that bridge the page falls back to slash
 * commands in read-only mode and says so in a banner.
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
      'view.title': 'Memory',
      'view.count': '{n} memories',
      'tab.memories': 'Memories',
      'tab.tidy': 'Dream',
      'tab.settings': 'Settings',
      'chip.label': 'Memory',
      'chip.attention': '{n} to review',
      'chip.title': 'Memory for this project',

      'btn.refresh': 'Refresh',
      'btn.reload': 'Reload page',
      'btn.retry': 'Retry',
      'btn.turnOn': 'Turn on',
      'btn.new': 'New',
      'btn.edit': 'Edit',
      'btn.delete': 'Delete',
      'btn.confirmDelete': 'Delete for sure?',
      'btn.save': 'Save',
      'btn.saving': 'Saving…',
      'btn.cancel': 'Cancel',
      'btn.close': 'Close',
      'btn.back': 'Back',
      'btn.clear': 'Clear search',
      'btn.keep': 'Keep',
      'btn.discard': 'Discard',
      'btn.copy': 'Copy path',
      'btn.confirm': 'Click again to confirm',

      'banner.pluginOff': 'Memory is turned off: nothing is loaded, saved or dreamed.',
      'banner.autoMemoryOff': "Auto memory is off: new conversations don't load the index and the agent can't save memories.",
      'banner.apiMissing':
        'This page opened before the memory plugin loaded, so it is read-only for now. Reload the page to edit.',
      'banner.noBackend':
        "The memory service isn't available on this page. Reload the page; if it still fails, check that the plugin is installed.",
      'banner.tokenExpired': 'The connection to the memory service expired. Reload the page to reconnect.',
      'error.load': "Couldn't load memory",

      'type.all': 'All',
      'type.user': 'User',
      'type.feedback': 'Feedback',
      'type.project': 'Project',
      'type.reference': 'Reference',
      'scope.project': 'This project',
      'scope.user': 'All projects',

      'search.placeholder': 'Search memories',
      'search.empty': 'No memories match "{q}".',
      'list.emptyTitle': 'No memories yet',
      'list.emptyBody': 'Tell the agent "remember …" in a conversation, or add one yourself.',
      'list.typeEmpty': 'No memories of this type.',

      'pending.title': 'Waiting for your review',
      'pending.hint': "The agent wasn't sure these are worth keeping.",

      'detail.loading': 'Loading…',
      'detail.emptyBody': 'This memory has no details.',
      'detail.updated': 'Updated {time}',
      'detail.missing': 'This memory no longer exists.',
      'via.agent': 'Saved by the agent',
      'via.command': 'Saved with /remember',
      'via.tidy': 'Written by a dream',
      'via.you': 'Edited by you',
      'via.import': 'Imported',

      'edit.newTitle': 'New memory',
      'edit.editTitle': 'Edit memory',
      'edit.name': 'Name',
      'edit.namePlaceholder': 'e.g. Reply language',
      'edit.nameRequired': 'Give the memory a name.',
      'edit.type': 'Type',
      'edit.typeHint.user': 'Who you are and what you prefer.',
      'edit.typeHint.feedback': 'Corrections and approaches you confirmed.',
      'edit.typeHint.project': "Decisions and ongoing work the code doesn't show.",
      'edit.typeHint.reference': 'Where to find outside information.',
      'edit.description': 'One-line summary',
      'edit.descriptionHint': 'Shown in the index that every new conversation loads.',
      'edit.content': 'Details',
      'edit.contentPlaceholder': 'Markdown is supported. Ctrl+Enter saves.',

      'notice.saved': 'Saved.',
      'notice.deleted': 'Moved to trash. You can restore it in Settings.',
      'notice.kept': 'Saved to memory.',
      'notice.discarded': 'Discarded.',
      'notice.toggled': 'Updated.',
      'notice.rulesSaved': 'Rules saved. They apply from the next request.',
      'notice.rulesReset': 'Rules reset to the defaults.',
      'notice.restored': 'Restored.',
      'notice.copied': 'Path copied.',
      'notice.planDiscarded': 'Plan discarded.',

      'err.locked': 'Another dream is running. Try again in a moment.',
      'err.stale': 'Memory changed after this plan was made. Create a new plan.',
      'err.deleteDisabled': 'Deleting is turned off in the plugin config (dreamAllowDelete).',

      'tidy.title': 'Dream: memory consolidation',
      'tidy.intro':
        'A dream reads your memories and recent conversations, merges duplicates and fixes outdated notes. You review every change before it is applied, and you can undo it under Recent dreams.',
      'tidy.generate': 'Start a dream',
      'tidy.regenerate': 'Dream again',
      'tidy.generating': 'Dreaming: reading memories and recent conversations… this usually takes 1–2 minutes.',
      'tidy.nothing': 'Nothing needs a dream right now.',
      'tidy.planTitle': 'Proposed changes',
      'tidy.proposal': 'Waiting for review',
      'tidy.preview': 'Preview',
      'tidy.apply': 'Apply {n} selected',
      'tidy.applyConfirm': 'Apply {n} changes?',
      'tidy.applied': 'Applied {n} changes. You can undo this under Recent dreams.',
      'tidy.selectAll': 'Select all',
      'tidy.selectNone': 'Clear selection',
      'tidy.discard': 'Discard plan',
      'tidy.op.create': 'New',
      'tidy.op.update': 'Edit',
      'tidy.op.delete': 'Remove',
      'tidy.op.index': 'Index',
      'tidy.unchanged': 'no change',
      'tidy.chars': '{before} → {after} chars',
      'tidy.newChars': '{n} chars',
      'tidy.before': 'Before',
      'tidy.after': 'After',
      'tidy.truncated': 'Too long to rewrite safely, left as is: {files}',
      'tidy.dropped': '{n} unsafe changes were left out of the plan.',
      'tidy.costExceeded': 'This plan went over the token limit.',
      'tidy.last': 'Last dream {time}',
      'tidy.never': 'Never dreamed',
      'tidy.sessionsSince': '{n} conversations since',
      'tidy.lastError': 'Last dream failed: {error}',
      'tidy.auto': 'Dream automatically',
      'tidy.autoHint': 'Runs a dream in the background once {hours} h and {sessions} conversations have passed.',
      'tidy.ready': 'Ready: the next dream runs after the next conversation turn.',
      'tidy.index': 'Index size',
      'tidy.indexMeta': '{lines} / {maxLines} lines · {bytes} / {maxBytes}',
      'tidy.indexOver': "The index is over budget, so its end isn't loaded into new conversations. Dreaming shortens it.",
      'tidy.historyTitle': 'Recent dreams',
      'tidy.opsCount': '{n} changes',
      'tidy.undo': 'Undo',
      'tidy.undone': 'Undone. Memory is back to how it was before.',
      'tidy.undoneTag': 'Undone',
      'tidy.undoConflict': "These files changed after the dream, so it can't be undone safely: {files}",
      'readiness.min-hours': 'Waiting for the {hours} h interval.',
      'readiness.min-sessions': '{current} of {required} conversations so far.',
      'readiness.pending-proposal': 'A plan is waiting for your review.',
      'readiness.lock': 'A dream is running.',
      'readiness.backoff': 'The last attempt failed; it will retry later.',
      'readiness.throttle': 'Checked recently; it will check again soon.',

      'settings.switches': 'Switches',
      'settings.switchesHint': 'These apply to every project.',
      'settings.enabled': 'Memory',
      'settings.enabledHint': 'Master switch for loading, saving and dreaming memory.',
      'settings.autoMemory': 'Auto memory',
      'settings.autoMemoryHint': 'New conversations load the index, and the agent saves what is worth remembering.',
      'settings.autoDream': 'Auto dream',
      'settings.autoDreamHint': 'Dream memory in the background from time to time.',
      'settings.userMemory': 'Cross-project memory',
      'settings.userMemoryHint': 'A separate memory shared by all projects, for things like your preferences.',
      'rules.title': 'What to remember',
      'rules.hint': 'Guidance sent with every request about what is worth saving. The two safety rules are always kept.',
      'rules.source.default': 'Default',
      'rules.source.project': 'This project',
      'rules.source.global': 'All projects',
      'rules.saveProject': 'Save for this project',
      'rules.saveGlobal': 'Save for all projects',
      'rules.reset': 'Restore defaults',
      'rules.count': '{n} / {max} characters',
      'restore.title': 'Trash and backups',
      'restore.hint': 'Deleted memories, and the copy taken before each dream.',
      'restore.trash': 'Trash',
      'restore.backups': 'Before dreams',
      'restore.empty': 'Nothing here.',
      'restore.files': '{n} files',
      'restore.all': 'Restore all',
      'restore.one': 'Restore',
      'about.title': 'Storage',
      'about.dir': 'Memory folder',
      'about.usage': 'Loaded {inject} times · read {reads} · saved {writes} · searched {searches}',

      'time.justNow': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} days ago',
    };

    const ZH = {
      'view.title': '记忆',
      'view.count': '{n} 条记忆',
      'tab.memories': '记忆',
      'tab.tidy': 'Dream',
      'tab.settings': '设置',
      'chip.label': '记忆',
      'chip.attention': '{n} 项待处理',
      'chip.title': '本项目的记忆',

      'btn.refresh': '刷新',
      'btn.reload': '刷新页面',
      'btn.retry': '重试',
      'btn.turnOn': '开启',
      'btn.new': '新建',
      'btn.edit': '编辑',
      'btn.delete': '删除',
      'btn.confirmDelete': '确认删除？',
      'btn.save': '保存',
      'btn.saving': '保存中…',
      'btn.cancel': '取消',
      'btn.close': '关闭',
      'btn.back': '返回',
      'btn.clear': '清除搜索',
      'btn.keep': '保留',
      'btn.discard': '丢弃',
      'btn.copy': '复制路径',
      'btn.confirm': '再点一次确认',

      'banner.pluginOff': '记忆功能已关闭：不会载入、保存或 Dream 记忆。',
      'banner.autoMemoryOff': '自动记忆已关闭：新会话不会载入索引，智能体也不能保存记忆。',
      'banner.apiMissing': '页面在记忆插件加载前打开，目前只能查看。刷新页面后即可编辑。',
      'banner.noBackend': '此页面连不上记忆服务。请刷新页面；如仍失败，检查插件是否已安装。',
      'banner.tokenExpired': '与记忆服务的连接已失效，刷新页面即可重新连接。',
      'error.load': '无法加载记忆',

      'type.all': '全部',
      'type.user': '用户',
      'type.feedback': '反馈',
      'type.project': '项目',
      'type.reference': '参考',
      'scope.project': '本项目',
      'scope.user': '跨项目',

      'search.placeholder': '搜索记忆',
      'search.empty': '没有匹配「{q}」的记忆。',
      'list.emptyTitle': '还没有记忆',
      'list.emptyBody': '在对话里说「记住……」，或者自己新建一条。',
      'list.typeEmpty': '这个类型下还没有记忆。',

      'pending.title': '等你确认',
      'pending.hint': '智能体不确定这些是否值得记住。',

      'detail.loading': '加载中…',
      'detail.emptyBody': '这条记忆没有正文。',
      'detail.updated': '更新于 {time}',
      'detail.missing': '这条记忆已不存在。',
      'via.agent': '由智能体保存',
      'via.command': '通过 /remember 保存',
      'via.tidy': '由 Dream 写入',
      'via.you': '由你编辑',
      'via.import': '导入',

      'edit.newTitle': '新建记忆',
      'edit.editTitle': '编辑记忆',
      'edit.name': '名称',
      'edit.namePlaceholder': '例如：回复语言',
      'edit.nameRequired': '请填写名称。',
      'edit.type': '类型',
      'edit.typeHint.user': '你是谁、你的偏好。',
      'edit.typeHint.feedback': '你纠正过的地方、确认过的做法。',
      'edit.typeHint.project': '代码里看不出来的决定和进行中的工作。',
      'edit.typeHint.reference': '外部信息在哪里找。',
      'edit.description': '一句话摘要',
      'edit.descriptionHint': '会出现在每个新会话载入的索引里。',
      'edit.content': '详细内容',
      'edit.contentPlaceholder': '支持 Markdown。Ctrl+Enter 保存。',

      'notice.saved': '已保存。',
      'notice.deleted': '已移到回收站，可在「设置」里恢复。',
      'notice.kept': '已存入记忆。',
      'notice.discarded': '已丢弃。',
      'notice.toggled': '已更新。',
      'notice.rulesSaved': '规则已保存，下一次请求起生效。',
      'notice.rulesReset': '已恢复默认规则。',
      'notice.restored': '已恢复。',
      'notice.copied': '路径已复制。',
      'notice.planDiscarded': '已放弃这个方案。',

      'err.locked': '另一次Dream正在进行，请稍后再试。',
      'err.stale': '方案生成后记忆又有改动，请重新 Dream 方案。',
      'err.deleteDisabled': '插件配置关闭了删除（dreamAllowDelete）。',

      'tidy.title': 'Dream：记忆整合',
      'tidy.intro':
        'Dream会读取现有记忆和最近的对话，合并重复内容、修正过时的记录。每项改动都先给你确认再应用，应用后也可以撤销。',
      'tidy.generate': '开始 Dream',
      'tidy.regenerate': '重新 Dream',
      'tidy.generating': 'Dream 正在读取记忆和最近的对话，通常需要 1–2 分钟…',
      'tidy.nothing': '目前没有需要 Dream 的内容。',
      'tidy.planTitle': 'Dream 方案',
      'tidy.proposal': '待审',
      'tidy.preview': '预览',
      'tidy.apply': '应用所选 {n} 项',
      'tidy.applyConfirm': '确认应用 {n} 项？',
      'tidy.applied': '已应用 {n} 项改动，可以在「最近 Dream」里撤销。',
      'tidy.selectAll': '全选',
      'tidy.selectNone': '清空选择',
      'tidy.discard': '放弃方案',
      'tidy.op.create': '新增',
      'tidy.op.update': '修改',
      'tidy.op.delete': '删除',
      'tidy.op.index': '索引',
      'tidy.unchanged': '无变化',
      'tidy.chars': '{before} → {after} 字',
      'tidy.newChars': '{n} 字',
      'tidy.before': '改前',
      'tidy.after': '改后',
      'tidy.truncated': '以下文件太长，方案不会改写：{files}',
      'tidy.dropped': '有 {n} 项不安全的改动已被剔除。',
      'tidy.costExceeded': '这个方案超出了 token 上限。',
      'tidy.last': '上次 Dream：{time}',
      'tidy.never': '还没 Dream 过',
      'tidy.sessionsSince': '之后有 {n} 次对话',
      'tidy.lastError': '上次 Dream 失败：{error}',
      'tidy.auto': '自动 Dream',
      'tidy.autoHint': '距上次至少 {hours} 小时且有 {sessions} 次对话后，会在后台自动 Dream。',
      'tidy.ready': '条件已满足，下一轮对话结束后会自动 Dream。',
      'tidy.index': '索引大小',
      'tidy.indexMeta': '{lines} / {maxLines} 行 · {bytes} / {maxBytes}',
      'tidy.indexOver': '索引超出预算，末尾部分不会载入新会话。Dream 可以压缩它。',
      'tidy.historyTitle': '最近 Dream',
      'tidy.opsCount': '{n} 项改动',
      'tidy.undo': '撤销',
      'tidy.undone': '已撤销，记忆恢复到 Dream 前。',
      'tidy.undoneTag': '已撤销',
      'tidy.undoConflict': '这些文件在 Dream 后又被修改过，无法安全撤销：{files}',
      'readiness.min-hours': '还没到 {hours} 小时的间隔。',
      'readiness.min-sessions': '已有 {current}/{required} 次对话。',
      'readiness.pending-proposal': '有一个方案在等你确认。',
      'readiness.lock': '正在Dream中。',
      'readiness.backoff': '上次失败了，稍后会重试。',
      'readiness.throttle': '刚检查过，稍后会再检查。',

      'settings.switches': '开关',
      'settings.switchesHint': '对所有项目生效。',
      'settings.enabled': '记忆功能',
      'settings.enabledHint': '总开关：载入、保存和Dream记忆。',
      'settings.autoMemory': '自动记忆',
      'settings.autoMemoryHint': '新会话载入记忆索引，智能体会自动保存值得记住的内容。',
      'settings.autoDream': '自动 Dream',
      'settings.autoDreamHint': '定期在后台Dream记忆。',
      'settings.userMemory': '跨项目记忆',
      'settings.userMemoryHint': '所有项目共用的一份记忆，适合放个人偏好。',
      'rules.title': '记忆规则',
      'rules.hint': '每次请求都会附带的「什么值得记」指引。两条安全规则始终保留。',
      'rules.source.default': '默认',
      'rules.source.project': '本项目',
      'rules.source.global': '全局',
      'rules.saveProject': '保存到本项目',
      'rules.saveGlobal': '保存为全局',
      'rules.reset': '恢复默认',
      'rules.count': '{n} / {max} 字符',
      'restore.title': '回收站与备份',
      'restore.hint': '删除的记忆，以及每次Dream前留下的备份。',
      'restore.trash': '回收站',
      'restore.backups': 'Dream前备份',
      'restore.empty': '这里是空的。',
      'restore.files': '{n} 个文件',
      'restore.all': '全部恢复',
      'restore.one': '恢复',
      'about.title': '存储',
      'about.dir': '记忆目录',
      'about.usage': '载入 {inject} 次 · 读取 {reads} · 写入 {writes} · 搜索 {searches}',

      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
    };

    const DICTIONARIES = { en: EN, zh: ZH };
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
  --ccm-warn:var(--dsw-static-amber-500,#f59e0b);
  --ccm-danger:var(--dsw-alias-state-error-primary,#dc2626);
  --ccm-strong:var(--dsw-alias-button-primary-fill,#0f1115);
  --ccm-on-strong:var(--dsw-alias-label-primary-inverted,#fff);
  position:relative;flex:1;min-height:0;height:100%;display:flex;flex-direction:column;overflow:hidden;
  font-family:inherit;font-size:13px;line-height:1.55;color:var(--ccm-fg);
  background:var(--dsw-alias-bg-module-platform,#f5f6f7);-webkit-font-smoothing:antialiased}
body[data-ds-dark-theme] .ccm-root{background:var(--dsw-alias-bg-base,#151517)}
.ccm-root *,.ccm-root *::before,.ccm-root *::after{box-sizing:border-box}
.ccm-root button,.ccm-root input,.ccm-root textarea{font:inherit;color:inherit}
.ccm-root :focus-visible{outline:2px solid var(--ccm-accent);outline-offset:2px}
.ccm-headbar{flex:none;container-type:inline-size}
.ccm-scroll{flex:1;min-height:0;overflow:auto;container-type:inline-size}
.ccm-shell{max-width:940px;margin:0 auto;padding:4px 24px 80px;display:flex;flex-direction:column;gap:16px}
.ccm-headbar .ccm-shell{padding:20px 24px 12px}
.ccm-mono{font-family:${MONO}}
.ccm-spacer{flex:1}

.ccm-top{display:flex;align-items:center;justify-content:space-between;gap:12px 20px;flex-wrap:wrap}
.ccm-title{margin:0;font-size:20px;font-weight:650;letter-spacing:-.015em;line-height:1.3}
.ccm-subtitle{margin-top:2px;font-size:12.5px;color:var(--ccm-fg3)}
.ccm-top-right{display:flex;align-items:center;gap:6px}
.ccm-tabs{display:inline-flex;padding:3px;gap:2px;border-radius:10px;background:var(--ccm-hover)}
.ccm-tab{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 14px;border:0;border-radius:8px;background:transparent;
  color:var(--ccm-fg2);font-size:13px;font-weight:500;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.ccm-tab:hover{color:var(--ccm-fg)}
.ccm-tab[aria-selected=true]{background:var(--ccm-surface);color:var(--ccm-fg);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px var(--ccm-line)}
.ccm-badge{min-width:17px;height:17px;padding:0 5px;border-radius:99px;background:var(--ccm-warn);color:#1b1206;
  font-size:10.5px;font-weight:700;line-height:17px;text-align:center;font-variant-numeric:tabular-nums}
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

.ccm-banner{display:flex;align-items:center;gap:10px;padding:10px 12px 10px 14px;border-radius:10px;font-size:12.5px;color:var(--ccm-fg2);
  background:color-mix(in srgb,var(--ccm-warn) 10%,var(--ccm-surface));border:1px solid color-mix(in srgb,var(--ccm-warn) 28%,transparent)}
.ccm-banner-error{background:color-mix(in srgb,var(--ccm-danger) 8%,var(--ccm-surface));border-color:color-mix(in srgb,var(--ccm-danger) 25%,transparent)}
.ccm-banner>svg{flex:none;color:var(--ccm-warn)}
.ccm-banner-error>svg{color:var(--ccm-danger)}
.ccm-banner-text{flex:1;min-width:0}

.ccm-card{background:var(--ccm-surface);border:1px solid var(--ccm-line);border-radius:12px;min-width:0}
.ccm-card-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;flex-wrap:wrap}
.ccm-card-title{font-size:14px;font-weight:600}
.ccm-card-sub{font-size:12px;color:var(--ccm-fg3)}
.ccm-card-text{margin:-4px 16px 12px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-card-body{padding:0 16px 16px}
.ccm-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:99px;font-size:11px;font-weight:600;
  background:var(--ccm-hover);color:var(--ccm-fg2)}
.ccm-pill-warn{background:color-mix(in srgb,var(--ccm-warn) 18%,transparent);color:var(--dsw-static-amber-600,#b45309)}
.ccm-dot{width:8px;height:8px;border-radius:99px;flex:none;background:var(--ccm-type,var(--ccm-fg3))}
.ccm-tag{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:600;
  color:var(--ccm-type);background:color-mix(in srgb,var(--ccm-type) 12%,transparent)}
.ccm-tag .ccm-dot{width:6px;height:6px}

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
.ccm-textarea:disabled{opacity:.6}

.ccm-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ccm-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:99px;border:1px solid var(--ccm-line2);
  background:transparent;color:var(--ccm-fg2);font-size:12.5px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.ccm-chip:hover{background:var(--ccm-hover);color:var(--ccm-fg)}
.ccm-chip[aria-pressed=true]{background:var(--ccm-strong);border-color:transparent;color:var(--ccm-on-strong)}
.ccm-chip-n{font-variant-numeric:tabular-nums;opacity:.55}
.ccm-seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--ccm-hover)}
.ccm-seg button{height:24px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--ccm-fg2);font-size:12px;cursor:pointer}
.ccm-seg button[aria-pressed=true]{background:var(--ccm-surface);color:var(--ccm-fg);box-shadow:0 0 0 1px var(--ccm-line)}

.ccm-mem{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
.ccm-mem.has-detail{grid-template-columns:minmax(0,1fr) minmax(0,1.3fr)}
.ccm-listpane{display:flex;flex-direction:column;gap:12px;min-width:0}
.ccm-rows{overflow:hidden}
.ccm-row{display:flex;align-items:flex-start;gap:11px;width:100%;padding:12px 16px;border:0;border-top:1px solid var(--ccm-line);
  background:transparent;text-align:left;cursor:pointer;transition:background .12s}
.ccm-row:first-child{border-top:0}
.ccm-row:hover{background:var(--ccm-hover)}
.ccm-row[aria-current=true]{background:color-mix(in srgb,var(--ccm-accent) 10%,transparent)}
.ccm-row>.ccm-dot{margin-top:6px}
.ccm-row-main{flex:1;min-width:0;display:block}
.ccm-row-name{display:block;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-row-desc{display:-webkit-box;margin-top:2px;font-size:12.5px;color:var(--ccm-fg2);-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ccm-row-snippet{display:block;margin-top:5px;padding:4px 8px;border-radius:6px;font-size:12px;color:var(--ccm-fg2);background:var(--ccm-hover);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-row-time{flex:none;margin-top:2px;font-size:11.5px;color:var(--ccm-fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.ccm-none{padding:28px 16px;text-align:center;font-size:12.5px;color:var(--ccm-fg3)}

.ccm-detail{position:sticky;top:4px;display:flex;flex-direction:column;max-height:calc(var(--ccm-vh,100vh) - 20px);overflow:hidden}
.ccm-detail-bar{flex:none;display:flex;align-items:center;gap:6px;min-height:48px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--ccm-line)}
.ccm-detail-body{min-height:0;overflow:auto;padding:18px 20px 20px}
.ccm-detail .ccm-form{min-height:0;overflow:auto}
.ccm-detail-name{margin:10px 0 4px;font-size:18px;font-weight:650;letter-spacing:-.01em;line-height:1.35;overflow-wrap:anywhere}
.ccm-detail-desc{margin:0;font-size:13px;color:var(--ccm-fg2)}
.ccm-meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:20px;padding-top:12px;border-top:1px solid var(--ccm-line);font-size:11.5px;color:var(--ccm-fg3)}
.ccm-muted{color:var(--ccm-fg3)}
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
.ccm-md a{color:var(--dsw-alias-text-link,var(--ccm-accent))}
.ccm-md hr{border:0;border-top:1px solid var(--ccm-line);margin:14px 0}

.ccm-form{display:flex;flex-direction:column;gap:16px;padding:18px 20px 20px}
.ccm-field{display:flex;flex-direction:column;gap:6px}
.ccm-label{font-size:12px;font-weight:600;color:var(--ccm-fg2)}
.ccm-help{font-size:11.5px;color:var(--ccm-fg3)}
.ccm-form-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}

.ccm-pending{border-color:color-mix(in srgb,var(--ccm-warn) 35%,transparent);background:color-mix(in srgb,var(--ccm-warn) 5%,var(--ccm-surface))}
.ccm-pending-item{display:flex;align-items:flex-start;gap:11px;padding:12px 16px;border-top:1px solid var(--ccm-line)}
.ccm-pending-item>.ccm-dot{margin-top:6px}
.ccm-pending-actions{display:flex;gap:6px;flex:none}

.ccm-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:44px 24px}
.ccm-empty-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;margin-bottom:4px;border-radius:14px;
  background:color-mix(in srgb,var(--ccm-accent) 10%,transparent);color:var(--ccm-accent)}
.ccm-empty-title{font-size:15px;font-weight:650}
.ccm-empty-text{max-width:440px;font-size:12.5px;line-height:1.65;color:var(--ccm-fg2)}
.ccm-empty .ccm-btn{margin-top:8px}

.ccm-hero{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:22px}
.ccm-hero .ccm-empty-icon{margin-bottom:6px}
.ccm-hero-title{font-size:16px;font-weight:650}
.ccm-hero-text{margin:0 0 6px;max-width:600px;font-size:13px;line-height:1.65;color:var(--ccm-fg2)}
.ccm-progress{position:relative;width:100%;height:3px;border-radius:99px;background:var(--ccm-hover);overflow:hidden}
.ccm-progress::after{content:'';position:absolute;top:0;bottom:0;left:0;width:35%;border-radius:inherit;background:var(--ccm-accent);
  animation:ccm-slide 1.3s ease-in-out infinite}
.ccm-plan-summary{margin:-2px 16px 12px;font-size:13px;line-height:1.6;color:var(--ccm-fg2)}
.ccm-op{border-top:1px solid var(--ccm-line)}
.ccm-op-row{display:flex;align-items:center;gap:10px;padding:9px 12px 9px 16px}
.ccm-op.is-muted .ccm-op-row{opacity:.55}
.ccm-check{display:flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;padding:0;border-radius:5px;
  border:1.5px solid var(--ccm-line2);background:var(--ccm-input);color:#fff;cursor:pointer;transition:background .12s,border-color .12s}
.ccm-check[aria-checked=true]{background:var(--ccm-accent);border-color:var(--ccm-accent)}
.ccm-check:disabled{cursor:not-allowed;opacity:.5}
.ccm-opkind{flex:none;min-width:40px;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:650;line-height:20px;text-align:center;
  color:var(--ccm-k);background:color-mix(in srgb,var(--ccm-k) 13%,transparent)}
.ccm-opkind[data-kind=create]{--ccm-k:var(--dsw-static-green-600,#16a34a)}
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
.ccm-diff{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;padding:2px 16px 14px 44px}
.ccm-diff-label{margin-bottom:4px;font-size:11px;font-weight:650;color:var(--ccm-fg3)}
.ccm-pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--ccm-hover);font-family:${MONO};font-size:12px;line-height:1.6;
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;color:var(--ccm-fg2)}
.ccm-pre-after{background:color-mix(in srgb,var(--ccm-ok) 9%,transparent);color:var(--ccm-fg)}
.ccm-notes{display:flex;flex-direction:column;gap:4px;padding:10px 16px 0;border-top:1px solid var(--ccm-line)}
.ccm-note{font-size:12px;color:var(--ccm-fg3)}
.ccm-note-error{color:var(--ccm-danger)}
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
.ccm-meter{height:6px;margin-top:8px;border-radius:99px;background:var(--ccm-hover);overflow:hidden}
.ccm-meter>span{display:block;height:100%;border-radius:inherit;background:var(--ccm-accent);transition:width .3s}
.ccm-meter.is-warn>span{background:var(--ccm-warn)}
.ccm-meter.is-over>span{background:var(--ccm-danger)}
.ccm-hist{display:flex;align-items:center;gap:12px;padding:11px 16px;border-top:1px solid var(--ccm-line)}
.ccm-section{display:flex;align-items:baseline;gap:8px;margin:6px 2px -6px}
.ccm-section-title{font-size:12px;font-weight:650;color:var(--ccm-fg2)}
.ccm-fold{display:flex;align-items:center;gap:10px;width:100%;padding:12px 16px;border:0;border-top:1px solid var(--ccm-line);
  background:transparent;text-align:left;cursor:pointer;font-size:13px;font-weight:550}
.ccm-fold:hover{background:var(--ccm-hover)}
.ccm-batch{padding:0 16px 4px 40px}
.ccm-batch-head{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--ccm-line)}
.ccm-batch-file{display:flex;align-items:center;gap:8px;padding:4px 0 4px 18px;font-size:12px}
.ccm-batch-file .ccm-mono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ccm-fg2)}
.ccm-path{display:flex;align-items:center;gap:6px;margin-top:6px}
.ccm-path code{flex:1;min-width:0;padding:7px 10px;border-radius:8px;background:var(--ccm-hover);font-family:${MONO};font-size:12px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.ccm-skel-row{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-top:1px solid var(--ccm-line)}
.ccm-skel-row:first-child{border-top:0}
.ccm-skel-lines{flex:1;display:flex;flex-direction:column;gap:8px}
.ccm-skel{display:block;height:10px;border-radius:6px;background:var(--ccm-hover);animation:ccm-pulse 1.4s ease-in-out infinite}
.ccm-skel-dot{width:8px;height:8px;border-radius:99px;margin-top:2px}

.ccm-toast-dock{position:absolute;left:0;right:0;bottom:20px;display:flex;justify-content:center;padding:0 16px;pointer-events:none;z-index:5}
.ccm-toast{display:flex;align-items:center;gap:8px;max-width:560px;padding:9px 14px;border-radius:10px;pointer-events:auto;
  background:var(--ccm-strong);color:var(--ccm-on-strong);font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.2);animation:ccm-pop .18s ease-out}
.ccm-toast-error{background:var(--ccm-danger);color:#fff}

@keyframes ccm-spin{to{transform:rotate(360deg)}}
@keyframes ccm-slide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
@keyframes ccm-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes ccm-pop{from{transform:translateY(8px)}to{transform:none}}
@media (prefers-reduced-motion:reduce){.ccm-root *{animation:none!important;transition:none!important}}

@container (max-width:720px){
  .ccm-shell{padding:4px 16px 72px}
  .ccm-headbar .ccm-shell{padding:14px 16px 10px}
  .ccm-mem.has-detail{grid-template-columns:minmax(0,1fr)}
  .ccm-mem.has-detail .ccm-listpane{display:none}
  .ccm-detail{position:static;max-height:none}
  .ccm-detail-body,.ccm-detail .ccm-form{overflow:visible}
  .ccm-only-narrow{display:inline-flex}
  .ccm-only-wide{display:none}
  .ccm-top-right{width:100%}
  .ccm-tabs{flex:1}
  .ccm-tab{flex:1;justify-content:center;padding:0 8px}
  .ccm-diff{padding-left:16px}
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
     * (`via`, `sourceSession`, `created`) when the host reports them.
     */
    function normalizeEntry(entry) {
      const meta = entry && typeof entry === 'object' ? entry : {};
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

    /** One queued write from `/status.pendingWrites`. */
    function normalizePendingWrite(item) {
      const record = item && typeof item === 'object' ? item : {};
      const candidate = record.candidate && typeof record.candidate === 'object' ? record.candidate : {};
      const reasons = Array.isArray(record.reasons)
        ? record.reasons
            .map((reason) => {
              if (typeof reason === 'string') return reason;
              if (reason && typeof reason.message === 'string' && reason.message !== '') return reason.message;
              if (reason && typeof reason.code === 'string') return reason.code;
              return '';
            })
            .filter((reason) => reason !== '')
        : [];
      return {
        id: typeof record.id === 'string' ? record.id : '',
        createdAt: asNumber(record.createdAt, 0),
        reasons,
        source: typeof record.source === 'string' ? record.source : '',
        candidate: {
          name: typeof candidate.name === 'string' ? candidate.name : '',
          type: typeof candidate.type === 'string' ? candidate.type : 'user',
          description: typeof candidate.description === 'string' ? candidate.description : '',
        },
      };
    }

    /** v9: `{count, items:[{id,createdAt,reasons,candidate}]}`. */
    function normalizePendingWrites(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const source = record.result && typeof record.result === 'object' ? record.result : record;
      const list = Array.isArray(source.items)
        ? source.items
        : Array.isArray(source.pendingWrites)
          ? source.pendingWrites
          : [];
      const items = list.filter((item) => item && typeof item === 'object').map(normalizePendingWrite);
      const rawCount = Number(source.count);
      const count = Number.isFinite(rawCount) && rawCount >= 0 ? Math.trunc(rawCount) : items.length;
      return { count, items };
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
          pendingProposal: Boolean(gates.pendingProposal),
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

    /** v10: `{items:[{ts,kind,appliedAt,ops,summary,files,undoable,hasMeta}]}`. */
    function normalizeDreamHistory(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const source = record.result && typeof record.result === 'object' ? record.result : record;
      const list = Array.isArray(source.items) ? source.items : Array.isArray(source.batches) ? source.batches : [];
      const items = list
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const hasMeta = item.hasMeta === true || (item.meta !== undefined && item.meta !== null);
          return {
            ts: typeof item.ts === 'string' ? item.ts : typeof item.id === 'string' ? item.id : '',
            kind: typeof item.kind === 'string' ? item.kind : '',
            appliedAt: asNumber(item.appliedAt ?? item.at, 0),
            ops: asNumber(item.ops, 0),
            summary: typeof item.summary === 'string' ? item.summary : '',
            files: Array.isArray(item.files) ? item.files.filter((file) => typeof file === 'string') : [],
            hasMeta,
            undoable: item.undoable === undefined ? hasMeta : item.undoable === true,
            undone: item.undone === true,
          };
        })
        .filter((item) => item.ts !== '');
      return { items, total: asNumber(source.total, items.length) };
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
    function normalizeStatus(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const config = record.config && typeof record.config === 'object' ? record.config : {};
      const stateRecord = record.state && typeof record.state === 'object' ? record.state : {};
      const userScope = record.userScope && typeof record.userScope === 'object' ? record.userScope : {};
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
          userMemoryEnabled: Boolean(config.userMemoryEnabled),
          minHours: asNumber(config.minHours, 0),
          minSessions: asNumber(config.minSessions, 0),
          userIndexMaxLines: asNumber(config.userIndexMaxLines, 30),
          userIndexMaxBytes: asNumber(config.userIndexMaxBytes, 4096),
          dreamMaxTotalTokens: asNumber(config.dreamMaxTotalTokens, 0),
          dreamCostMode:
            config.dreamCostMode === 'review' || config.dreamCostMode === 'block'
              ? config.dreamCostMode
              : 'warn',
          writeMode: config.writeMode === 'confirm' ? 'confirm' : 'auto',
          pendingProposalTtlHours: asNumber(config.pendingProposalTtlHours, 72),
        },
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
        userScope: {
          enabled: Boolean(userScope.enabled),
          entries: Array.isArray(userScope.entries)
            ? userScope.entries.filter(isEntryLike).map(normalizeEntry)
            : [],
          budgets: {
            maxLines: asNumber(userScope.budgets && userScope.budgets.maxLines, asNumber(config.userIndexMaxLines, 30)),
            maxBytes: asNumber(userScope.budgets && userScope.budgets.maxBytes, asNumber(config.userIndexMaxBytes, 4096)),
            lines: asNumber(userScope.usage && userScope.usage.lines, 0),
            bytes: asNumber(userScope.usage && userScope.usage.bytes, 0),
          },
        },
        state: {
          lastDreamAt: asNumber(stateRecord.lastDreamAt, 0),
          lastDreamAttemptAt: asNumber(stateRecord.lastDreamAttemptAt, 0),
          lastDreamSummary:
            typeof stateRecord.lastDreamSummary === 'string' ? stateRecord.lastDreamSummary : '',
          lastDreamSessions: asNumber(stateRecord.lastDreamSessions, 0),
          lastDreamOps: asNumber(stateRecord.lastDreamOps, 0),
          lastDreamMode: typeof stateRecord.lastDreamMode === 'string' ? stateRecord.lastDreamMode : '',
          lastPlanPath: typeof stateRecord.lastPlanPath === 'string' ? stateRecord.lastPlanPath : '',
          pendingProposal:
            typeof stateRecord.pendingProposal === 'string' ? stateRecord.pendingProposal : '',
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
        },
        changelogTail: typeof record.changelogTail === 'string' ? record.changelogTail : '',
        trashCount: asNumber(record.trashCount, 0),
        rules: normalizeRules(record.rules),
        metrics: normalizeMetrics(record.metrics),
        pendingWrites: normalizePendingWrites(record.pendingWrites),
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
          injectSubagents:
            record.subagentPolicy && typeof record.subagentPolicy === 'object'
              ? record.subagentPolicy.injectSubagents !== false
              : true,
          mode:
            record.subagentPolicy && typeof record.subagentPolicy === 'object' && record.subagentPolicy.mode === 'off'
              ? 'off'
              : 'shared',
        },
        degraded: record.__fallback === true,
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
        scope: record.scope === 'user' ? 'user' : 'project',
        frontmatter,
        body: typeof record.body === 'string' ? record.body : rawText,
        raw: rawText,
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

    /** Normalize one v7 preview operation from `POST /dream {action:'preview'}`. */
    function normalizePreviewOp(op, fallbackIndex) {
      const meta = op && typeof op === 'object' ? op : {};
      const index = asNumber(meta.index, fallbackIndex);
      return {
        index,
        op: typeof meta.op === 'string' ? meta.op : 'write',
        scope: meta.scope === 'user' ? 'user' : 'project',
        file: typeof meta.file === 'string' ? meta.file : '',
        type: typeof meta.type === 'string' ? meta.type : '',
        before: typeof meta.before === 'string' ? meta.before : '',
        after: typeof meta.after === 'string' ? meta.after : '',
        changed: meta.changed === undefined ? true : Boolean(meta.changed),
      };
    }

    /** Normalize the v7 preview plan payload (`{path,summary,ops,...}`). */
    function normalizePreviewPlan(raw) {
      const record = raw && typeof raw === 'object' ? raw : {};
      const source = record.result && typeof record.result === 'object' ? record.result : record;
      const opsRaw = Array.isArray(source.ops) ? source.ops : [];
      const usage = normalizeUsage(source.usage);
      return {
        path: typeof source.path === 'string' ? source.path : '',
        summary: typeof source.summary === 'string' ? source.summary : '',
        ops: opsRaw.map((op, index) => normalizePreviewOp(op, index)),
        truncatedFiles: Array.isArray(source.truncatedFiles)
          ? source.truncatedFiles.filter((file) => typeof file === 'string')
          : [],
        dropped: Array.isArray(source.dropped) ? source.dropped : [],
        durationMs: asNumber(source.durationMs, 0),
        inputChars: asNumber(source.inputChars, 0),
        outputChars: asNumber(source.outputChars, 0),
        usage,
        costExceeded: Boolean(source.costExceeded),
        warnings: Array.isArray(source.warnings) ? source.warnings.filter((item) => typeof item === 'string') : [],
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

    /** Render a remote failure object as text. */
    function remoteErrorMessage(error) {
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object') {
        const code = typeof error.code === 'string' && error.code !== '' ? error.code + ': ' : '';
        if (typeof error.message === 'string' && error.message !== '') return code + error.message;
      }
      try {
        return JSON.stringify(error);
      } catch {
        return 'remote call failed';
      }
    }

    /**
     * Unwrap a `ctx.remote.commands.execute()` RemoteResult (degraded fallback
     * mode only). Accepts the verified envelope plus bare result shapes.
     */
    function unwrapCommandResult(result) {
      if (result === undefined || result === null) throw new Error('empty response from the host');
      if (typeof result !== 'object') throw new Error('malformed response from the host');
      if (result.ok === false) throw new Error(remoteErrorMessage(result.error));
      let value = result.ok === true ? result.value : result;
      if (value !== undefined && value !== null && typeof value === 'object' && 'ok' in value) {
        if (value.ok === false) throw new Error(remoteErrorMessage(value.error));
        value = value.value;
      }
      if (value === undefined || value === null) throw new Error('unknown or malformed command');
      const commandResult =
        value && typeof value === 'object' && value.result !== undefined ? value.result : value;
      if (!commandResult || typeof commandResult !== 'object' || typeof commandResult.kind !== 'string') {
        throw new Error('unexpected command result from the host');
      }
      if (commandResult.kind === 'success') {
        return typeof commandResult.text === 'string' ? commandResult.text : '';
      }
      const text = typeof commandResult.text === 'string' ? commandResult.text.trim() : '';
      throw new Error(text !== '' ? text : 'command failed');
    }

    /** The Host injects this into index.html; absent = fallback mode. */
    function readApiConfig() {
      try {
        const bridge = typeof window !== 'undefined' ? window.__CC_MEMORY_API__ : undefined;
        if (!bridge || typeof bridge !== 'object') return null;
        if (typeof bridge.base !== 'string' || bridge.base === '') return null;
        return {
          base: bridge.base.replace(/\/+$/, ''),
          token: typeof bridge.token === 'string' ? bridge.token : '',
        };
      } catch {
        return null;
      }
    }

    /**
     * Last-resort bridge discovery for a page that started before the Host
     * injected `__CC_MEMORY_API__` (cached desktop boot rows, plugin reloaded
     * after the page loaded). The Host exposes the same {base, token} at
     * `/api/cc-memory/bridge` (loopback + DSH auth gated), so a same-origin
     * credentialed fetch can recover API mode without a reload. Only runs when
     * the injected global is absent; failure keeps the command fallback.
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
          const bridge = { base: data.base, token: typeof data.token === 'string' ? data.token : '' };
          window.__CC_MEMORY_API__ = bridge;
          return { base: bridge.base.replace(/\/+$/, ''), token: bridge.token };
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
    // Backend: silent API first, slash-command fallback only when it is absent.
    // -----------------------------------------------------------------------

    function sessionIdOf(owner) {
      if (typeof owner === 'string' && owner !== '') return owner;
      if (owner && typeof owner === 'object' && typeof owner.sessionId === 'string' && owner.sessionId !== '') {
        return owner.sessionId;
      }
      return undefined;
    }

    function createBackend({ api, commandRunner, sessionId }) {
      const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
      const hasCommands = typeof commandRunner === 'function' && sid !== undefined;
      const mode = api !== null ? 'api' : hasCommands ? 'commands' : 'none';
      // Why the silent API is unavailable: the page needs a reload either way.
      const reason = api !== null ? null : hasCommands ? 'bridge-missing' : 'no-backend';

      /** Run one slash command (fallback mode only). */
      async function command(line) {
        if (!hasCommands) throw new Error('the command fallback is unavailable');
        return commandRunner(sid, line);
      }

      async function status() {
        if (mode === 'api') {
          const data = await apiRequest(api, 'GET', '/status', { query: { sessionId: sid } });
          return normalizeStatus(data);
        }
        if (mode === 'commands') {
          const text = await command('/memory json');
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            throw new Error('the host returned an unreadable memory payload');
          }
          if (!payload || typeof payload !== 'object' || payload.ok !== true) {
            throw new Error(payload && typeof payload.error === 'string' ? payload.error : 'memory is unavailable');
          }
          payload.__fallback = true;
          return normalizeStatus(payload);
        }
        throw new Error('the memory service is unavailable');
      }

      async function file(file, scope) {
        const safeScope = scope === 'user' ? 'user' : 'project';
        if (mode === 'api') {
          const data = await apiRequest(api, 'GET', '/file', {
            query: { sessionId: sid, file, scope: safeScope },
          });
          return normalizeFile(data);
        }
        const text = await command(
          safeScope === 'user' ? '/memory show --scope=user ' + file : '/memory show ' + file,
        );
        return normalizeFile({ file, scope: safeScope, raw: text, body: text });
      }

      async function saveRules(scope, text) {
        if (mode !== 'api') throw new Error('rules editing requires the silent API');
        const data = await apiRequest(api, 'POST', '/rules', {
          body: { sessionId: sid, scope: scope === 'global' ? 'global' : 'project', text },
        });
        return normalizeRules(data.rules);
      }

      /** Reset: clear both layered files so the built-in defaults win again. */
      async function resetRules() {
        if (mode === 'api') {
          const cleared = [];
          for (const scope of ['project', 'global']) {
            try {
              const data = await apiRequest(api, 'POST', '/rules', {
                body: { sessionId: sid, scope, text: '' },
              });
              cleared.push(normalizeRules(data.rules));
            } catch (error) {
              // A layer that is already empty is fine; report anything else.
              if (!(error && typeof error.message === 'string' && error.message.includes('empty'))) throw error;
            }
          }
          return cleared.length > 0 ? cleared[cleared.length - 1] : null;
        }
        const text = await command('/memory rules reset');
        return { text, source: 'default', projectPath: '', globalPath: '', maxChars: 0, notice: text };
      }

      async function toggle(patch) {
        if (mode === 'api') {
          const data = await apiRequest(api, 'POST', '/toggle', { body: { sessionId: sid, ...patch } });
          return {
            overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : {},
            config: data.config && typeof data.config === 'object' ? data.config : {},
          };
        }
        if ('enabled' in patch) await command('/memory plugin ' + (patch.enabled ? 'on' : 'off'));
        if ('autoMemoryEnabled' in patch) await command('/memory ' + (patch.autoMemoryEnabled ? 'on' : 'off'));
        if ('autoDreamEnabled' in patch) {
          await command('/memory dream ' + (patch.autoDreamEnabled ? 'on' : 'off'));
        }
        return { overrides: {}, config: {} };
      }

      async function dream(action) {
        if (mode === 'api') {
          const data = await apiRequest(api, 'POST', '/dream', { body: { sessionId: sid, action } });
          return data.result;
        }
        const lines = {
          'dry-run': '/memory dream run --dry-run',
          run: '/memory dream run',
          'apply-last': '/memory dream apply',
          'apply-pending': '/memory dream apply',
          reject: '/memory dream reject',
        };
        const line = lines[action];
        if (line === undefined) throw new Error('unknown dream action: ' + action);
        const text = await command(line);
        return { text };
      }

      async function deleteFile(file, scope) {
        if (mode === 'api') {
          return apiRequest(api, 'POST', '/delete', {
            body: { sessionId: sid, file, scope: scope === 'user' ? 'user' : 'project' },
          });
        }
        const text = await command('/memory delete ' + file);
        return { ok: true, text };
      }

      /** v7: these operations need the silent API; say so explicitly otherwise. */
      function requireApi(feature) {
        if (mode !== 'api') throw new Error(feature + ' requires the silent memory API');
        return api;
      }

      /** POST /dream {action:'preview'} → `{path,summary,ops,truncatedFiles,dropped}`. */
      async function previewDream() {
        requireApi('plan preview');
        const data = await apiRequest(api, 'POST', '/dream', {
          body: { sessionId: sid, action: 'preview' },
        });
        return normalizePreviewPlan(data.result === undefined ? data : data.result);
      }

      /** POST /dream {action:'apply-ops', indexes} → dream result. */
      async function applySelected(indexes) {
        requireApi('applying selected operations');
        const list = (Array.isArray(indexes) ? indexes : [])
          .map((value) => asNumber(value, -1))
          .filter((value) => value >= 0);
        const data = await apiRequest(api, 'POST', '/dream', {
          body: { sessionId: sid, action: 'apply-ops', indexes: list },
        });
        return data.result === undefined ? data : data.result;
      }

      /** GET /backups → `{items:[{id,at,files[]}]}`. */
      async function backups() {
        requireApi('backup restore');
        const data = await apiRequest(api, 'GET', '/backups', { query: { sessionId: sid } });
        return { items: normalizeBackupList(data) };
      }

      /** GET /trash → `{items:[{id,at,files[]}]}`. */
      async function trash() {
        requireApi('trash restore');
        const data = await apiRequest(api, 'GET', '/trash', { query: { sessionId: sid } });
        return { items: normalizeBackupList(data) };
      }

      /** POST /restore `{kind:'backup'|'trash',id,file?}` → `{restored,reconciled}`. */
      async function restore(kind, id, file) {
        requireApi('restoring files');
        const body = {
          sessionId: sid,
          kind: kind === 'backup' ? 'backup' : 'trash',
          id,
        };
        if (typeof file === 'string' && file !== '') body.file = file;
        const data = await apiRequest(api, 'POST', '/restore', { body });
        return data.result === undefined ? data : data.result;
      }

      /** POST /pending-writes `{action:'approve',id}` → approve one queued write. */
      async function approveWrite(id) {
        if (mode === 'api') {
          const data = await apiRequest(api, 'POST', '/pending-writes', {
            body: { sessionId: sid, action: 'approve', id },
          });
          return data.result === undefined ? data : data.result;
        }
        const text = await command('/memory approve ' + id);
        return { text };
      }

      /** POST /pending-writes `{action:'reject',id}` → reject one queued write. */
      async function rejectWrite(id) {
        if (mode === 'api') {
          const data = await apiRequest(api, 'POST', '/pending-writes', {
            body: { sessionId: sid, action: 'reject', id },
          });
          return data.result === undefined ? data : data.result;
        }
        const text = await command('/memory reject ' + id);
        return { text };
      }

      // -- v10: dream history / edit / merge / search / trend / transfer ------

      /** GET /dream-history → `{items:[{ts,kind,appliedAt,ops,summary,undoable,undone}]}`, newest first. */
      async function dreamHistory() {
        requireApi('dream history');
        const data = await apiRequest(api, 'GET', '/dream-history', { query: { sessionId: sid } });
        return normalizeDreamHistory(data);
      }

      /** POST /dream {action:'undo'} → undo the latest applied batch. */
      async function undoDream() {
        if (mode === 'api') {
          const data = await apiRequest(api, 'POST', '/dream', {
            body: { sessionId: sid, action: 'undo' },
          });
          return data.result === undefined ? data : data.result;
        }
        const text = await command('/memory dream undo');
        return { text };
      }

      /** POST /file — create or update one memory file (frontmatter + body). */
      async function saveFile(payload) {
        requireApi('editing memory files');
        const body = {
          sessionId: sid,
          name: String(payload && payload.name !== undefined ? payload.name : ''),
          type: String(payload && payload.type !== undefined ? payload.type : 'user'),
          description: String(payload && payload.description !== undefined ? payload.description : ''),
          content: String(payload && payload.content !== undefined ? payload.content : ''),
        };
        if (payload && typeof payload.file === 'string' && payload.file !== '') body.file = payload.file;
        if (payload && payload.scope === 'user') body.scope = 'user';
        const data = await apiRequest(api, 'POST', '/file', { body });
        return data.result === undefined ? data : data.result;
      }

      /** GET /search → ranked `{query,total,items:[{file,name,type,score,snippets}]}`. */
      async function search(query, options = {}) {
        requireApi('search');
        const data = await apiRequest(api, 'GET', '/search', {
          query: {
            sessionId: sid,
            q: String(query === undefined || query === null ? '' : query),
            limit: String(asNumber(options.limit, 20)),
            offset: String(asNumber(options.offset, 0)),
            type: options.type === undefined || options.type === null ? '' : String(options.type),
            scope: options.scope === 'user' ? 'user' : '',
          },
        });
        return normalizeSearch(data);
      }

      return {
        mode,
        reason,
        sessionId: sid,
        status,
        file,
        saveRules,
        resetRules,
        toggle,
        dream,
        deleteFile,
        previewDream,
        applySelected,
        backups,
        trash,
        restore,
        approveWrite,
        rejectWrite,
        dreamHistory,
        undoDream,
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

    /** Very small safe Markdown renderer (no HTML injection). */
    function renderInline(text) {
      const source = String(text === undefined || text === null ? '' : text);
      const parts = [];
      // `[*]` instead of `\*`: the Host's client snapshot drops the backslash in
      // `\*\*`, which turns this literal into a boot-time SyntaxError.
      const pattern = /([*][*][^*]+[*][*]|[*][^*]+[*]|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      let match;
      let key = 0;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) parts.push(source.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('**')) parts.push(h('strong', { key: 'b' + key++ }, token.slice(2, -2)));
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
    function renderMarkdown(text) {
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
          nodes.push(h('h' + level, { key: 'h' + key++, className: 'ccm-md-h' }, renderInline(heading[2])));
          index += 1;
          continue;
        }
        if (/^---+$/.test(line.trim())) { nodes.push(h('hr', { key: 'hr' + key++ })); index += 1; continue; }
        if (/^>\s?/.test(line)) {
          const buffer = [];
          while (index < lines.length && /^>\s?/.test(lines[index])) buffer.push(lines[index++].replace(/^>\s?/, ''));
          nodes.push(h('blockquote', { key: 'q' + key++ }, renderInline(buffer.join(' '))));
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
            items.push(h('li', { key: 'li' + key++ }, renderInline(lines[index++].replace(/^\s*[-*]\s+/, ''))));
          }
          nodes.push(h('ul', { key: 'ul' + key++ }, items));
          continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
            items.push(h('li', { key: 'ol' + key++ }, renderInline(lines[index++].replace(/^\s*\d+[.)]\s+/, ''))));
          }
          nodes.push(h('ol', { key: 'oll' + key++ }, items));
          continue;
        }
        const paragraph = [];
        while (index < lines.length && lines[index].trim() !== '' && !blockStart.test(lines[index])) paragraph.push(lines[index++]);
        if (paragraph.length === 0) { index += 1; continue; }
        nodes.push(h('p', { key: 'p' + key++ }, renderInline(paragraph.join(' '))));
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
     * Filter and rank the memory list. Local name/description matches always
     * count; `hits` (file -> {score}) adds the server's body matches.
     */
    function filterEntries(entries, options = {}) {
      const type = MEMORY_TYPES.includes(options.type) ? options.type : '';
      const needle = String(options.query === undefined || options.query === null ? '' : options.query)
        .trim()
        .toLowerCase();
      const hits = options.hits && typeof options.hits.get === 'function' ? options.hits : new Map();
      const pool = (Array.isArray(entries) ? entries : []).filter((entry) => type === '' || entry.type === type);
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
      return Boolean(state.pendingProposal || state.lastPlanPath);
    }

    /** Items waiting for the user: queued writes plus an unreviewed plan. */
    function attentionCount(status) {
      if (!status) return 0;
      return asNumber(status.pendingWrites && status.pendingWrites.count, 0) + (planWaiting(status) ? 1 : 0);
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
      return message;
    }

    /** One sentence for the auto-tidy row, from the readiness gates. */
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
        return value === 'tidy' || value === 'settings' ? value : 'memories';
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
    // Memories tab
    // -----------------------------------------------------------------------
    function MemoriesTab(props) {
      const { status, backend, t, busy, run, readOnly } = props;
      const [query, setQuery] = React.useState('');
      const [type, setType] = React.useState('');
      const [scope, setScope] = React.useState('project');
      const [hits, setHits] = React.useState(() => new Map());
      const [selected, setSelected] = React.useState('');
      const [editor, setEditor] = React.useState(null);
      const [doc, setDoc] = React.useState({ phase: 'idle', file: null, error: '' });
      const [reloadKey, setReloadKey] = React.useState(0);

      const userEnabled = status.userScope.enabled;
      const activeScope = userEnabled ? scope : 'project';
      const entries = activeScope === 'user' ? status.userScope.entries : status.entries;
      const counts = countByType(entries);
      const visible = filterEntries(entries, { query, type, hits });
      const selectedEntry = entries.find((entry) => entry.file === selected) || null;
      const idle = busy === '';

      // Body matches come from the server; names/descriptions filter locally.
      React.useEffect(() => {
        const text = query.trim();
        if (text.length < 2 || readOnly || typeof backend.search !== 'function') {
          setHits((current) => (current.size === 0 ? current : new Map()));
          return undefined;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
          backend.search(text, { limit: 50, type, scope: activeScope }).then(
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
      }, [query, type, activeScope, backend, readOnly]);

      React.useEffect(() => {
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
        backend.file(selected, activeScope).then(
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
      }, [selected, activeScope, backend, reloadKey]);

      const open = (file) => {
        setEditor(null);
        setSelected((current) => (current === file ? '' : file));
      };
      const startNew = () => {
        setSelected('');
        setEditor({ mode: 'new', file: '', name: '', type: type || 'user', description: '', content: '', error: '' });
      };
      const startEdit = () => {
        if (!doc.file) return;
        const front = doc.file.frontmatter || {};
        setEditor({
          mode: 'edit',
          file: selected,
          name: typeof front.name === 'string' && front.name !== '' ? front.name : selectedEntry ? selectedEntry.name : '',
          type: knownType(typeof front.type === 'string' ? front.type : selectedEntry ? selectedEntry.type : 'user'),
          description:
            typeof front.description === 'string' ? front.description : selectedEntry ? selectedEntry.description : '',
          content: doc.file.body,
          error: '',
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
          scope: activeScope,
        };
        if (editor.mode === 'edit') payload.file = editor.file;
        const done = await run('save', () => backend.saveFile(payload), { success: t('notice.saved') });
        if (!done) return;
        const file = done.value && typeof done.value.file === 'string' ? done.value.file : editor.file;
        setEditor(null);
        if (file) {
          setSelected(file);
          setReloadKey((key) => key + 1);
        }
      };
      const removeSelected = async () => {
        const done = await run('delete', () => backend.deleteFile(selected, activeScope), { success: t('notice.deleted') });
        if (done) setSelected('');
      };
      const onKeyDown = (event) => {
        if (event.key !== 'Escape') return;
        if (editor) setEditor(null);
        else if (selected !== '') setSelected('');
      };

      // ---- list pane ------------------------------------------------------
      const pending = activeScope === 'project' ? status.pendingWrites.items : [];
      const pendingCard =
        pending.length === 0
          ? null
          : h(
              'section',
              { className: 'ccm-card ccm-pending' },
              h(
                'div',
                { className: 'ccm-card-head' },
                h('span', { className: 'ccm-card-title' }, t('pending.title')),
                h('span', { className: 'ccm-badge' }, String(pending.length)),
                h('span', { className: 'ccm-card-sub' }, t('pending.hint')),
              ),
              pending.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'ccm-pending-item' },
                  h('span', { className: 'ccm-dot', style: typeStyle(item.candidate.type) }),
                  h(
                    'div',
                    { className: 'ccm-row-main' },
                    h('span', { className: 'ccm-row-name' }, item.candidate.name || item.id),
                    item.candidate.description ? h('span', { className: 'ccm-row-desc' }, item.candidate.description) : null,
                  ),
                  h(
                    'div',
                    { className: 'ccm-pending-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ccm-btn ccm-btn-sm ccm-btn-primary',
                        disabled: !idle,
                        onClick: () => run('approve', () => backend.approveWrite(item.id), { success: t('notice.kept') }),
                      },
                      icon('check', 14),
                      t('btn.keep'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ccm-btn ccm-btn-sm',
                        disabled: !idle,
                        onClick: () => run('reject', () => backend.rejectWrite(item.id), { success: t('notice.discarded') }),
                      },
                      t('btn.discard'),
                    ),
                  ),
                ),
              ),
            );

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

      const filters = h(
        'div',
        { className: 'ccm-filters' },
        ['', ...MEMORY_TYPES].map((value) => {
          const n = value === '' ? counts.all : counts[value];
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
        userEnabled
          ? h(
              'div',
              { className: 'ccm-seg', role: 'group' },
              ['project', 'user'].map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    'aria-pressed': activeScope === value ? 'true' : 'false',
                    onClick: () => {
                      setScope(value);
                      setSelected('');
                      setEditor(null);
                    },
                  },
                  t('scope.' + value),
                ),
              ),
            )
          : null,
      );

      let list;
      if (entries.length === 0) {
        list = h(
          'div',
          { className: 'ccm-card ccm-empty' },
          h('div', { className: 'ccm-empty-icon' }, icon('book', 22)),
          h('div', { className: 'ccm-empty-title' }, t('list.emptyTitle')),
          h('div', { className: 'ccm-empty-text' }, t('list.emptyBody')),
          readOnly || editor
            ? null
            : h(
                'button',
                { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle, onClick: startNew },
                icon('plus', 15),
                t('btn.new'),
              ),
        );
      } else if (visible.length === 0) {
        list = h(
          'div',
          { className: 'ccm-card ccm-none' },
          query.trim() !== '' ? t('search.empty', { q: query.trim() }) : t('list.typeEmpty'),
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
                className: 'ccm-row',
                'aria-current': entry.file === selected ? 'true' : undefined,
                onClick: () => open(entry.file),
              },
              h('span', { className: 'ccm-dot', style: typeStyle(entry.type) }),
              h(
                'span',
                { className: 'ccm-row-main' },
                h('span', { className: 'ccm-row-name' }, entry.name || entry.file),
                entry.description ? h('span', { className: 'ccm-row-desc' }, entry.description) : null,
                hit && hit.snippet && query.trim() !== '' ? h('span', { className: 'ccm-row-snippet' }, hit.snippet) : null,
              ),
              h('span', { className: 'ccm-row-time', title: entry.modified }, ago(entry.modified, t)),
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
        let body;
        if (doc.phase === 'error') body = h('div', { className: 'ccm-inline-error' }, doc.error || t('detail.missing'));
        else if (!file) body = h('div', { className: 'ccm-md ccm-muted' }, t('detail.loading'));
        else if (file.body.trim() === '') body = h('div', { className: 'ccm-md ccm-muted' }, t('detail.emptyBody'));
        else body = h('div', { className: 'ccm-md' }, renderMarkdown(file.body));
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
            selectedEntry ? h(TypeTag, { type: selectedEntry.type, t }) : null,
            h('h2', { className: 'ccm-detail-name' }, selectedEntry ? selectedEntry.name : selected),
            selectedEntry && selectedEntry.description
              ? h('p', { className: 'ccm-detail-desc' }, selectedEntry.description)
              : null,
            body,
            h(
              'div',
              { className: 'ccm-meta' },
              updated ? h('span', null, t('detail.updated', { time: updated })) : null,
              via ? h('span', null, via) : null,
              h('span', { className: 'ccm-mono' }, selected),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'ccm-mem' + (detail ? ' has-detail' : ''), onKeyDown },
        h('div', { className: 'ccm-listpane' }, pendingCard, toolbar, filters, list),
        detail,
      );
    }

    // -----------------------------------------------------------------------
    // Tidy tab: create a plan -> review -> apply selected -> undo.
    // -----------------------------------------------------------------------
    function TidyTab(props) {
      const { status, backend, t, busy, run, notify, readOnly } = props;
      const [preview, setPreview] = React.useState({ phase: 'idle', plan: null, error: '' });
      const [picked, setPicked] = React.useState([]);
      const [openOp, setOpenOp] = React.useState(-1);
      const [history, setHistory] = React.useState(status.dreamHistory.items);
      const state = status.state;
      const config = status.config;
      const waiting = planWaiting(status);
      const isProposal = state.pendingProposal !== '';
      const planKey = state.pendingProposal || state.lastPlanPath;
      const idle = busy === '';
      const generating = busy === 'dry-run';
      const canRun = !readOnly && config.enabled && config.autoMemoryEnabled;

      React.useEffect(() => {
        if (!waiting || readOnly) {
          setPreview({ phase: 'idle', plan: null, error: '' });
          return undefined;
        }
        let cancelled = false;
        setPreview((current) => ({ phase: 'loading', plan: current.plan, error: '' }));
        backend.previewDream().then(
          (plan) => {
            if (cancelled) return;
            setPreview({ phase: 'ready', plan, error: '' });
            setPicked(plan.ops.filter((op) => op.changed).map((op) => op.index));
            setOpenOp(-1);
          },
          (error) => {
            if (!cancelled) setPreview({ phase: 'error', plan: null, error: errorText(error, t) });
          },
        );
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [planKey, readOnly, backend]);

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
        const done = await run('dry-run', () => backend.dream('dry-run'), {
          check: (result) => (result && result.skipped ? result.skipReason || 'skipped' : result && result.error ? result.error : ''),
        });
        if (done && asNumber(done.value && done.value.ops, 0) === 0) notify('ok', t('tidy.nothing'));
      };
      const apply = async () => {
        const indexes = [...picked].sort((left, right) => left - right);
        await run('apply', () => backend.applySelected(indexes), {
          check: (result) => {
            if (result && (result.applied === true || (result.ok === true && result.applied !== false))) return '';
            return (result && (result.error || result.skipReason)) || 'failed';
          },
          success: (result) =>
            t('tidy.applied', { n: asNumber(result && (result.ops ?? result.operations), indexes.length) }),
        });
      };
      const discard = () =>
        run('reject', () => backend.dream('reject'), { success: t('notice.planDiscarded') });
      const undo = () =>
        run('undo', () => backend.undoDream(), {
          check: (result) => {
            if (!result || result.ok !== false) return '';
            if (result.error === 'conflict' && Array.isArray(result.conflicts)) {
              return t('tidy.undoConflict', { files: result.conflicts.map((item) => item.file).join(', ') });
            }
            return result.message || result.error || 'failed';
          },
          success: t('tidy.undone'),
        });
      const toggleOp = (index) =>
        setPicked((current) => (current.includes(index) ? current.filter((value) => value !== index) : [...current, index]));

      // ---- plan or intro ---------------------------------------------------
      const plan = preview.plan;
      const changedOps = plan ? plan.ops.filter((op) => op.changed) : [];
      const allPicked = changedOps.length > 0 && changedOps.every((op) => picked.includes(op.index));
      let main;
      if (!waiting || readOnly) {
        main = h(
          'section',
          { className: 'ccm-card ccm-hero' },
          h('div', { className: 'ccm-empty-icon' }, icon('sparkle', 22)),
          h('div', { className: 'ccm-hero-title' }, t('tidy.title')),
          h('p', { className: 'ccm-hero-text' }, generating ? t('tidy.generating') : t('tidy.intro')),
          generating
            ? h('div', { className: 'ccm-progress' })
            : h(
                'button',
                { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle || !canRun, onClick: generate },
                icon('sparkle', 15),
                t('tidy.generate'),
              ),
        );
      } else {
        const pane = (label, text, after) =>
          h(
            'div',
            { key: label },
            h('div', { className: 'ccm-diff-label' }, label),
            h('pre', { className: 'ccm-pre' + (after ? ' ccm-pre-after' : '') }, truncatePreview(text) || '—'),
          );
        const notes = [];
        if (plan && plan.truncatedFiles.length > 0) {
          notes.push(h('div', { key: 'tr', className: 'ccm-note' }, t('tidy.truncated', { files: plan.truncatedFiles.join(', ') })));
        }
        if (plan && plan.dropped.length > 0) {
          notes.push(h('div', { key: 'dr', className: 'ccm-note' }, t('tidy.dropped', { n: plan.dropped.length })));
        }
        if (plan && plan.costExceeded) {
          notes.push(h('div', { key: 'co', className: 'ccm-note ccm-note-error' }, t('tidy.costExceeded')));
        }
        main = h(
          'section',
          { className: 'ccm-card' },
          h(
            'div',
            { className: 'ccm-card-head' },
            h('span', { className: 'ccm-card-title' }, t('tidy.planTitle')),
            h('span', { className: 'ccm-pill' + (isProposal ? ' ccm-pill-warn' : '') }, isProposal ? t('tidy.proposal') : t('tidy.preview')),
            h('span', { className: 'ccm-spacer' }),
            plan ? h('span', { className: 'ccm-card-sub' }, t('tidy.opsCount', { n: changedOps.length })) : null,
          ),
          plan && plan.summary ? h('p', { className: 'ccm-plan-summary' }, plan.summary) : null,
          preview.phase === 'loading' && !plan ? h('p', { className: 'ccm-plan-summary' }, t('detail.loading')) : null,
          preview.phase === 'error' ? h('p', { className: 'ccm-plan-summary ccm-note-error' }, preview.error) : null,
          plan && changedOps.length === 0 ? h('p', { className: 'ccm-plan-summary' }, t('tidy.nothing')) : null,
          plan
            ? plan.ops.map((op) => {
                const kind = opKind(op);
                const checked = picked.includes(op.index);
                const isOpen = openOp === op.index;
                let delta;
                if (!op.changed) delta = t('tidy.unchanged');
                else if (kind === 'create') delta = t('tidy.newChars', { n: op.after.length });
                else if (kind === 'delete') delta = t('tidy.newChars', { n: op.before.length });
                else delta = t('tidy.chars', { before: op.before.length, after: op.after.length });
                return h(
                  'div',
                  { key: op.index, className: 'ccm-op' + (op.changed ? '' : ' is-muted') },
                  h(
                    'div',
                    { className: 'ccm-op-row' },
                    h(
                      'button',
                      {
                        type: 'button',
                        role: 'checkbox',
                        className: 'ccm-check',
                        'aria-checked': checked ? 'true' : 'false',
                        'aria-label': op.file || 'MEMORY.md',
                        disabled: !op.changed || !idle,
                        onClick: () => toggleOp(op.index),
                      },
                      checked ? icon('check', 12) : null,
                    ),
                    h('span', { className: 'ccm-opkind', 'data-kind': kind }, t('tidy.op.' + kind)),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ccm-op-toggle',
                        'aria-expanded': isOpen ? 'true' : 'false',
                        onClick: () => setOpenOp(isOpen ? -1 : op.index),
                      },
                      h('span', { className: 'ccm-op-file' }, op.file || 'MEMORY.md'),
                      h('span', { className: 'ccm-op-delta' }, delta),
                      h('span', { className: 'ccm-chev' + (isOpen ? ' is-open' : '') }, icon('chevron', 14)),
                    ),
                  ),
                  isOpen
                    ? h(
                        'div',
                        { className: 'ccm-diff' },
                        kind !== 'create' ? pane(t('tidy.before'), op.before, false) : null,
                        kind !== 'delete' ? pane(t('tidy.after'), op.after, true) : null,
                      )
                    : null,
                );
              })
            : null,
          notes.length > 0 ? h('div', { className: 'ccm-notes' }, notes) : null,
          h(
            'div',
            { className: 'ccm-foot' },
            generating
              ? h('div', { className: 'ccm-progress' })
              : [
                  changedOps.length > 0
                    ? h(ConfirmButton, {
                        key: 'apply',
                        className: 'ccm-btn-primary',
                        icon: 'check',
                        label: t('tidy.apply', { n: picked.length }),
                        confirmLabel: t('tidy.applyConfirm', { n: picked.length }),
                        disabled: !idle || picked.length === 0 || !canRun,
                        onConfirm: apply,
                        t,
                      })
                    : null,
                  changedOps.length > 1
                    ? h(
                        'button',
                        {
                          key: 'all',
                          type: 'button',
                          className: 'ccm-btn ccm-btn-ghost',
                          disabled: !idle,
                          onClick: () => setPicked(allPicked ? [] : changedOps.map((op) => op.index)),
                        },
                        allPicked ? t('tidy.selectNone') : t('tidy.selectAll'),
                      )
                    : null,
                  h('span', { key: 'sp', className: 'ccm-spacer' }),
                  isProposal
                    ? h(ConfirmButton, {
                        key: 'discard',
                        tone: 'danger',
                        className: 'ccm-btn-ghost ccm-btn-danger',
                        label: t('tidy.discard'),
                        disabled: !idle,
                        onConfirm: discard,
                        t,
                      })
                    : h(
                        'button',
                        { key: 'regen', type: 'button', className: 'ccm-btn ccm-btn-ghost', disabled: !idle || !canRun, onClick: generate },
                        icon('refresh', 14),
                        t('tidy.regenerate'),
                      ),
                ],
          ),
        );
      }

      // ---- status: last run, auto switch, index size -----------------------
      const maxLines = config.indexMaxLines || 100;
      const maxBytes = config.indexMaxBytes || 8192;
      const ratio = Math.max(status.index.lines / maxLines, status.index.bytes / maxBytes);
      const over = status.index.overflow || ratio > 1;
      const meterClass = 'ccm-meter' + (over ? ' is-over' : ratio > 0.8 ? ' is-warn' : '');
      const lastLine = [
        t('tidy.sessionsSince', { n: state.sessionsSince }),
        state.lastDreamAt && state.lastDreamOps ? t('tidy.opsCount', { n: state.lastDreamOps }) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const statusCard = h(
        'section',
        { className: 'ccm-card' },
        h(
          'div',
          { className: 'ccm-setting' },
          h(
            'div',
            { className: 'ccm-setting-text' },
            h(
              'div',
              { className: 'ccm-setting-name' },
              state.lastDreamAt ? t('tidy.last', { time: ago(state.lastDreamAt, t) }) : t('tidy.never'),
            ),
            h('div', { className: 'ccm-setting-hint' }, lastLine),
            state.lastError ? h('div', { className: 'ccm-setting-hint ccm-note-error' }, t('tidy.lastError', { error: state.lastError })) : null,
          ),
        ),
        h(
          'div',
          { className: 'ccm-setting' },
          h(
            'div',
            { className: 'ccm-setting-text' },
            h('div', { className: 'ccm-setting-name' }, t('tidy.auto')),
            h(
              'div',
              { className: 'ccm-setting-hint' },
              config.autoDreamEnabled
                ? readinessText(status.readiness, config, t) ||
                    t('tidy.autoHint', { hours: config.minHours || 24, sessions: config.minSessions || 5 })
                : t('tidy.autoHint', { hours: config.minHours || 24, sessions: config.minSessions || 5 }),
            ),
          ),
          h(Switch, {
            checked: config.autoDreamEnabled,
            label: t('tidy.auto'),
            disabled: !idle || readOnly || !config.enabled,
            onChange: (value) =>
              run('toggle', () => backend.toggle({ autoDreamEnabled: value }), { success: t('notice.toggled') }),
          }),
        ),
        h(
          'div',
          { className: 'ccm-setting' },
          h(
            'div',
            { className: 'ccm-setting-text' },
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } },
              h('span', { className: 'ccm-setting-name' }, t('tidy.index')),
              h(
                'span',
                { className: 'ccm-card-sub' },
                t('tidy.indexMeta', {
                  lines: status.index.lines,
                  maxLines,
                  bytes: formatBytes(status.index.bytes),
                  maxBytes: formatBytes(maxBytes),
                }),
              ),
            ),
            h('div', { className: meterClass }, h('span', { style: { width: Math.min(100, Math.round(ratio * 100)) + '%' } })),
            over ? h('div', { className: 'ccm-setting-hint' }, t('tidy.indexOver')) : null,
          ),
        ),
      );

      // ---- recent tidy-ups ---------------------------------------------------
      const batches = history.filter((item) => item.kind !== '' || item.ops > 0).slice(0, 5);
      const undoTarget = batches.find((item) => item.undoable);
      const historyCard =
        batches.length === 0
          ? null
          : h(
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
                    h('span', { className: 'ccm-row-name' }, item.summary || t('tidy.opsCount', { n: item.ops })),
                    h(
                      'span',
                      { className: 'ccm-row-desc' },
                      [formatTime(item.appliedAt) || item.ts, t('tidy.opsCount', { n: item.ops })].join(' · '),
                    ),
                  ),
                  item.undone ? h('span', { className: 'ccm-pill' }, t('tidy.undoneTag')) : null,
                  undoTarget && undoTarget.ts === item.ts && !readOnly
                    ? h(ConfirmButton, { small: true, icon: 'undo', label: t('tidy.undo'), disabled: !idle, onConfirm: undo, t })
                    : null,
                ),
              ),
            );

      return h(React.Fragment, null, main, statusCard, historyCard);
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
        ['userMemoryEnabled', 'settings.userMemory', 'settings.userMemoryHint', config.userMemoryEnabled, !config.enabled],
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
                h('div', { className: 'ccm-setting-hint' }, t(hint)),
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

      const refresh = React.useCallback(async () => {
        if (backend === null || backend.mode === 'none') {
          if (alive.current) setLoad({ phase: 'error', status: null, error: new Error('no-backend') });
          return null;
        }
        try {
          const status = await backend.status();
          if (alive.current) setLoad({ phase: 'ready', status, error: null });
          return status;
        } catch (error) {
          if (alive.current) {
            setLoad((current) =>
              current.status ? { ...current, error } : { phase: 'error', status: null, error },
            );
          }
          return null;
        }
      }, [backend]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      React.useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      const notify = (kind, text) => setToast({ kind, text, id: Date.now() });

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
            notify('error', errorText(failure, t));
          } else {
            if (options.success) {
              notify('ok', typeof options.success === 'function' ? options.success(value) : options.success);
            }
            outcome = { value };
          }
        } catch (error) {
          notify('error', errorText(error, t));
        }
        if (options.refresh !== false) await refresh();
        busyRef.current = '';
        if (alive.current) setBusy('');
        return outcome;
      };

      const selectTab = (value) => {
        setTab(value);
        storeTab(value);
      };

      const status = load.status;
      const readOnly = backend === null || backend.mode !== 'api';
      const errorMessage = load.error ? formatError(load.error) : '';
      const tokenExpired =
        load.error !== null && (load.error.status === 401 || /401|unauthori[sz]ed/i.test(errorMessage));

      // ---- header ------------------------------------------------------------
      const pendingCount = status ? status.pendingWrites.count : 0;
      const tabs = [
        ['memories', t('tab.memories'), pendingCount > 0 ? h('span', { className: 'ccm-badge' }, String(pendingCount)) : null],
        ['tidy', t('tab.tidy'), status && planWaiting(status) ? h('span', { className: 'ccm-badge-dot' }) : null],
        ['settings', t('tab.settings'), null],
      ];
      const header = h(
        'header',
        { className: 'ccm-top' },
        h(
          'div',
          null,
          h('h1', { className: 'ccm-title' }, t('view.title')),
          status
            ? h(
                'div',
                { className: 'ccm-subtitle' },
                [projectLabel(status.project), t('view.count', { n: status.entries.length })].filter(Boolean).join(' · '),
              )
            : null,
        ),
        h(
          'div',
          { className: 'ccm-top-right' },
          h(
            'div',
            { className: 'ccm-tabs', role: 'tablist' },
            tabs.map(([value, label, badge]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  role: 'tab',
                  className: 'ccm-tab',
                  'aria-selected': tab === value ? 'true' : 'false',
                  onClick: () => selectTab(value),
                },
                label,
                badge,
              ),
            ),
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
        ),
      );

      // ---- banners -------------------------------------------------------------
      const banners = [];
      if (backend === null || backend.mode === 'none') {
        banners.push(h(Banner, { key: 'nb', tone: 'error', text: t('banner.noBackend'), action: reloadButton(t) }));
      } else if (backend.mode === 'commands') {
        banners.push(h(Banner, { key: 'ro', text: t('banner.apiMissing'), action: reloadButton(t) }));
      }
      if (tokenExpired) {
        banners.push(h(Banner, { key: 'tk', tone: 'error', text: t('banner.tokenExpired'), action: reloadButton(t) }));
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
        body = h(
          'div',
          { className: 'ccm-card ccm-empty' },
          h('div', { className: 'ccm-empty-icon' }, icon('alert', 22)),
          h('div', { className: 'ccm-empty-title' }, t('error.load')),
          h('div', { className: 'ccm-empty-text' }, errorText(load.error, t)),
          backend && backend.mode !== 'none'
            ? h('button', { type: 'button', className: 'ccm-btn', disabled: busy !== '', onClick: () => run('refresh', () => refresh(), { refresh: false }) }, t('btn.retry'))
            : null,
        );
      } else {
        const tabProps = { status, backend, t, busy, run, notify, readOnly };
        if (tab === 'tidy') body = h(TidyTab, tabProps);
        else if (tab === 'settings') body = h(SettingsTab, tabProps);
        else body = h(MemoriesTab, tabProps);
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'ccm-style' }, CSS),
        h(
          'div',
          { className: 'ccm-root', 'data-cc-memory-view': '1' },
          h('div', { className: 'ccm-headbar' }, h('div', { className: 'ccm-shell' }, header)),
          h('div', { className: 'ccm-scroll', ref: scrollRef }, h('div', { className: 'ccm-shell' }, banners, body)),
          toast
            ? h(
                'div',
                { className: 'ccm-toast-dock' },
                h(
                  'div',
                  { key: toast.id, className: 'ccm-toast' + (toast.kind === 'error' ? ' ccm-toast-error' : ''), role: 'status' },
                  icon(toast.kind === 'error' ? 'alert' : 'check', 15),
                  h('span', null, toast.text),
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
        if (backend.mode === 'commands' && backend.sessionId === undefined) return undefined;
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
      return h(
        React.Fragment,
        null,
        h('style', null, CHIP_CSS),
        h(
          'div',
          { className: 'ccm-chip-dock', title: status.project.memoryDir || t('chip.title'), 'data-cc-memory-chip': '1' },
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
    const inject = ['slots', 'locale', 'remote', 'remote.commands'];

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

      // Silent HTTP API (preferred). The command runner exists only for the
      // degraded fallback used when the Host does not inject the API bridge;
      // normal page data never touches the session log. A page that started
      // before the injection can recover the bridge from the loopback endpoint.
      const api = readApiConfig() ?? (await discoverBridge());
      let commandRunner = null;
      try {
        const remote = ctx.remote;
        const commands = remote && remote.commands;
        if (commands && typeof commands.execute === 'function') {
          commandRunner = async (sessionId, line) => {
            const result = await commands.execute(sessionId, line, []);
            return unwrapCommandResult(result);
          };
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[cc-memory] command fallback unavailable:', formatError(error));
      }
      backendFactory = (sessionId) => createBackend({ api, commandRunner, sessionId });
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
    // Test hook: pure helpers for the verifier (v7, no DOM, no effects).
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
          resolveApiConfig: readApiConfig,
          apiRequest,
          normalizeMetrics,
          normalizePendingWrites,
          normalizeReadiness,
          normalizeHealth,
          normalizeDreamHistory,
          normalizeSearch,
          normalizeTrend,
          filterEntries,
          countByType,
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
