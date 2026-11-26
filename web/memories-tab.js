import { ConfirmButton, EmptyState, Field, TRUST_ICONS, TrustBadge, TypeTag, icon } from './ui.js';
import { MEMORY_TYPES, NOTE_TYPES, STATUS_NAMES, TRUST_FILTERS, ago, countByTrust, countByType, errorText, filterEntries, knownType, splitBody, timeOf, trustOf, typeStyle, viaLabel } from './model.js';
import { React, h } from './react.js';
import { dreamEvidenceRows } from './normalize.js';
import { formatTime } from './format.js';
import { renderInline, renderMarkdown } from './markdown.js';

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
    text = t(entry.verified.source === 'user-explicit' ? 'detail.userConfirmed' : 'detail.verified',
      { date: entry.verified.date || '—' });
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

export function MemoriesTab(props) {
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
  // A conflict reloads the page. Adopt the hash it came back with, or every
  // retry resends the same stale baseline and fails the same way.
  React.useEffect(() => {
    const fresh =
      doc.phase === 'ready' && doc.file && typeof doc.file.expectedHash === 'string' ? doc.file.expectedHash : '';
    if (fresh === '' || !doc.file) return;
    setEditor((current) => (
      current && current.mode === 'edit' && current.file === doc.file.file && current.expectedHash !== fresh
        ? { ...current, expectedHash: fresh }
        : current
    ));
  }, [doc]);
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
        // The server sends `STALE_WRITE` from the store and `stale-write`
        // from the status helpers; compare on one spelling.
        const code = error && typeof error.code === 'string'
          ? error.code.toLowerCase().replace(/_/gu, '-')
          : '';
        if (code === 'stale-write') {
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
            NOTE_TYPES.map((value) =>
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
      // `[[file-name]]` between notes and wiki pages opens that file; `[[slug]]` may be wiki_slug.md.
      const linked = (slug) => {
        const stem = String(slug || '').replace(/.md$/i, '');
        return entries.find((entry) => entry.file === stem + '.md') || entries.find((entry) => entry.file === 'wiki_' + stem + '.md') || null;
      };
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
              h('div', null, t('detail.historyDream', { n: ref.ops }),
                ref.confirmedWithoutSource ? h('div', { className: 'ccm-help' }, t('detail.historyConfirmed')) : null,
                ...dreamEvidenceRows(ref.evidence, t)),
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
        readOnly || (selectedEntry && selectedEntry.type === 'wiki')
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
