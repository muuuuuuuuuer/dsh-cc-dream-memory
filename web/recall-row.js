import { React, ViewBoundary, h } from './react.js';
import { formatError } from './format.js';
import { resolveBackend, resolveT } from './slot-props.js';

/** Registered through `uiConversation.events` for the recall attachment the Host logs as a user message. */
export const RECALL_KIND = 'cc-memory-recall';

const RECALL_SOURCE_KIND = 'plugin:cc-memory-recall';

const RECALL_CSS = `
.ccm-recall{margin:4px 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ccm-recall-head{display:flex;align-items:center;gap:6px;width:100%;min-width:0;padding:4px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ccm-recall-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ccm-recall-head:focus-visible{outline:2px solid var(--dsw-alias-trajectory-accent);outline-offset:1px}
.ccm-recall-title{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}
.ccm-recall-files{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.ccm-recall-caret{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .15s}
.ccm-recall-head[aria-expanded=true] .ccm-recall-caret{transform:rotate(90deg)}
.ccm-recall-body{display:flex;flex-direction:column;gap:10px;margin:4px 0 0 8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-card-fill)}
.ccm-recall-item-head{display:flex;align-items:center;gap:8px}
.ccm-recall-file{font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ccm-recall-scope{color:var(--dsw-alias-label-tertiary)}
.ccm-recall-text{margin:4px 0 0;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:var(--dsw-alias-label-secondary)}
.ccm-recall-action{flex:none;margin-left:auto;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.ccm-recall-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ccm-recall-action:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.ccm-recall-error{margin-top:2px;color:var(--dsw-alias-state-error-primary)}
`;

/** The text of a user message's content blocks. */
function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function parseRecall(text) {
  const source = String(text === undefined || text === null ? '' : text);
  const found = [...source.matchAll(/^## (project|user)\/(\S+\.md)(?: \(updated [^)]*\))?[ \t]*$/gm)];
  return found.map((match, index) => {
    const end = index + 1 < found.length ? found[index + 1].index : source.length;
    const body = source.slice(match.index + match[0].length, end).replace(/<\/system-reminder>\s*$/u, '').trim();
    return { scope: match[1], file: match[2], body };
  });
}

/** Chat event definition: claims the recall message so Chat does not draw it as generic injected context. */
export const RECALL_DEFINITION = {
  kind: RECALL_KIND,
  target: 'chat',
  match: (event) => (event
    && event.type === 'user/message'
    && event.surfaceOp === 'append'
    && event.data
    && event.data.source
    && event.data.source.kind === RECALL_SOURCE_KIND
    ? { id: String(event.data.id), role: 'start', exclusive: true }
    : null),
  start: (_context, match) => ({ seq: match.event.seq, text: contentText(match.event.data.content) }),
  update: (context) => context.state,
  buildViewNode: (context) => (context.state === undefined
    ? null
    : {
      key: context.key,
      kind: RECALL_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: (context.start && context.start.location) || (context.matches[0] && context.matches[0].location) || { kind: 'unresolved' },
      visibility: 'visible',
      // Stay in the Turn outside its process disclosure: a completed Turn folds Step-level rows away.
      groupTree: 'turn',
      data: { text: context.state.text },
    }),
};

export function RecallRowReady(props) {
  return h(ViewBoundary, { key: props.memBackend?.sessionId }, h(RecallRow, props));
}

function RecallRow(props) {
  const t = resolveT(props);
  const backend = resolveBackend(props);
  const text = props.node && props.node.data ? props.node.data.text : '';
  const items = React.useMemo(() => parseRecall(text), [text]);
  const [open, setOpen] = React.useState(false);
  const [marks, setMarks] = React.useState({});
  if (items.length === 0) return null;

  const dismiss = async (item) => {
    const key = item.scope + '/' + item.file;
    setMarks((previous) => ({ ...previous, [key]: { pending: true } }));
    try {
      await backend.dismissRecall(item.file, item.scope);
      setMarks((previous) => ({ ...previous, [key]: { done: true } }));
    } catch (error) {
      setMarks((previous) => ({ ...previous, [key]: { error: formatError(error) } }));
    }
  };

  const title = items.length === 1 ? t('recall.title.one') : t('recall.title.other', { n: items.length });
  return h(
    'div',
    { className: 'ccm-recall', 'data-cc-memory-recall': '1' },
    h('style', null, RECALL_CSS),
    h(
      'button',
      { type: 'button', className: 'ccm-recall-head', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen(!open) },
      h('span', { className: 'ccm-recall-title' }, title + ':'),
      h('span', { className: 'ccm-recall-files' }, items.map((item) => item.file).join(' · ')),
      h('span', { className: 'ccm-recall-caret', 'aria-hidden': 'true' }, '›'),
    ),
    open
      ? h(
        'div',
        { className: 'ccm-recall-body' },
        items.map((item) => {
          const key = item.scope + '/' + item.file;
          const mark = marks[key] || {};
          return h(
            'div',
            { key },
            h(
              'div',
              { className: 'ccm-recall-item-head' },
              h('span', { className: 'ccm-recall-file' }, item.file),
              item.scope === 'user' ? h('span', { className: 'ccm-recall-scope' }, t('recall.scopeUser')) : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'ccm-recall-action',
                  title: t('recall.hint'),
                  disabled: mark.done === true || mark.pending === true,
                  onClick: () => dismiss(item),
                },
                mark.done === true ? t('recall.dismissed') : t('recall.dismiss'),
              ),
            ),
            h('pre', { className: 'ccm-recall-text' }, item.body),
            mark.error ? h('div', { className: 'ccm-recall-error', role: 'alert' }, t('recall.dismissFailed', { error: mark.error })) : null,
          );
        }),
      )
      : null,
  );
}
