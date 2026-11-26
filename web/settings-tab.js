import { ConfirmButton, Switch, budgetMeter, icon } from './ui.js';
import { React, h } from './react.js';
import { errorText } from './model.js';
import { formatBytes, formatError, formatTime } from './format.js';

export function SettingsTab(props) {
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
    const done = await run('rules', () => backend.saveRules(scope, rulesText), {
      success: (saved) => {
        const warnings = saved && Array.isArray(saved.warnings) ? saved.warnings : [];
        return warnings.length > 0
          ? `${t('notice.rulesSaved')} — ${warnings.join('; ')}`
          : t('notice.rulesSaved');
      },
    });
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
