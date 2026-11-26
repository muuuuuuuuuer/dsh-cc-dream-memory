import { ConfirmButton, Field, icon } from './ui.js';
import { React, h } from './react.js';
import { asNumber, dreamEvidenceRows } from './normalize.js';
import { errorText, formatNumber } from './model.js';
import { formatTime } from './format.js';

const TASK_ORDER = ['done', 'review', 'new', 'partial', 'todo', 'excluded'];

const TASK_LEFT = new Set(['new', 'partial', 'todo']);

const TASK_LIMIT = 12;

/** Which conversations of this workspace Dream has reviewed, as a bar and a list. */
function DreamTasksCard({ tasks, error, t }) {
  const [filter, setFilter] = React.useState('all');
  const [all, setAll] = React.useState(false);
  const sessions = tasks?.sessions ?? [];
  const counts = Object.fromEntries(TASK_ORDER.map((key) => [key, 0]));
  for (const item of sessions) counts[item.status in counts ? item.status : 'todo'] += 1;
  const total = sessions.length;
  const left = sessions.filter((item) => TASK_LEFT.has(item.status)).length;
  const shown = sessions.filter((item) => filter === 'all'
    || (filter === 'left' ? TASK_LEFT.has(item.status) : item.status === 'done'));
  const visible = all ? shown : shown.slice(0, TASK_LIMIT);
  return h(
    'section',
    { className: 'ccm-card', 'aria-busy': tasks === null && !error },
    h('div', { className: 'ccm-card-head' },
      h('span', { className: 'ccm-card-title' }, t('tasks.title')),
      h('span', { className: 'ccm-spacer' }),
      total > 0 ? h('span', { className: 'ccm-row-time' }, t('tasks.summary', { done: counts.done, total, left })) : null),
    tasks === null
      ? h('p', { className: 'ccm-card-text' }, error ? errorText(error, t) : t('detail.loading'))
      : total === 0
      ? h('p', { className: 'ccm-card-text' }, t('tasks.empty'))
      : h(React.Fragment, null,
        h('div', { className: 'ccm-tasks-bar', role: 'img', 'aria-label': t('tasks.summary', { done: counts.done, total, left }) },
          ...TASK_ORDER.filter((key) => counts[key] > 0).map((key) => h('span', {
            key, className: 'ccm-task-seg ccm-task-' + key, style: { flexGrow: counts[key] },
            title: t('tasks.status.' + key) + ' ' + counts[key],
          }))),
        h('div', { className: 'ccm-tasks-legend' },
          ...TASK_ORDER.filter((key) => counts[key] > 0).map((key) => h('span', { key, className: 'ccm-task-key' },
            h('span', { className: 'ccm-task-dot ccm-task-' + key }), t('tasks.status.' + key), h('b', null, counts[key])))),
        h('div', { className: 'ccm-tasks-filter', role: 'tablist' },
          ...['all', 'left', 'done'].map((key) => h('button', {
            key, type: 'button', role: 'tab', 'aria-selected': filter === key,
            className: 'ccm-btn ccm-btn-ghost ccm-btn-sm' + (filter === key ? ' ccm-on' : ''),
            onClick: () => { setFilter(key); setAll(false); },
          }, t('tasks.filter.' + key), ' ', key === 'all' ? total : key === 'left' ? left : counts.done))),
        ...visible.map((item) => h('div', { key: item.id, className: 'ccm-hist' },
          h('div', { className: 'ccm-row-main' },
            h('span', { className: 'ccm-row-desc ccm-task-name' }, item.title || t('tasks.untitled', { id: item.id.replace(/^session-/u, '').slice(0, 8) })),
            h('span', { className: 'ccm-row-time' }, [formatTime(item.createdAt),
              item.dreamedAt ? t('tasks.dreamedAt', { time: formatTime(item.dreamedAt) }) : ''].filter(Boolean).join(' · '))),
          h('span', { className: 'ccm-pill ccm-task-pill ccm-task-' + item.status }, t('tasks.status.' + item.status)))),
        shown.length > TASK_LIMIT
          ? h('div', { className: 'ccm-foot' }, h('button', { type: 'button', className: 'ccm-btn ccm-btn-ghost ccm-btn-sm', onClick: () => setAll(!all) },
            all ? t('tasks.less') : t('tasks.more', { n: shown.length })))
          : null),
  );
}

export function DreamTab(props) {
  const { status, backend, t, busy, run, notify, readOnly, refresh } = props;
  const [history, setHistory] = React.useState(status.dreamHistory.items);
  const [estimate, setEstimate] = React.useState(null);
  const [live, setLive] = React.useState(null);
  const [focus, setFocus] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  // Files of the pending copy the human did not pass, per run.
  const [rejected, setRejected] = React.useState({ runId: '', files: [] });
  // Changes without a checked source the human accepted, and the files whose
  // diff they opened (a confirmation is only offered after reading it).
  const [confirmed, setConfirmed] = React.useState({ runId: '', files: [] });
  const [viewed, setViewed] = React.useState({ runId: '', files: [] });
  const [memoryOnly, setMemoryOnly] = React.useState(false);
  const [coverage, setCoverage] = React.useState({ tasks: null, error: null });
  const state = status.state;
  const config = status.config;
  const pending = state.pendingSwitch;
  const idle = busy === '';
  const canRun = !readOnly && config.enabled && config.autoMemoryEnabled;
  // A background run reports its own progress; /status only carries a log.
  const runs = Array.isArray(status.dreamRuns) ? status.dreamRuns : [];
  const activeRun = (item) => item?.status === 'running' || item?.status === 'cancelling';
  const currentLive = (live && runs.find((item) => item.runId === live.runId && item.decision)) || live;
  const shownRun = (activeRun(currentLive) ? currentLive : null) || runs.find(activeRun)
    || (currentLive?.resumable ? currentLive : null) || runs.find((item) => item.resumable) || currentLive || runs[0] || null;
  const running = Boolean(shownRun && (shownRun.status === 'running' || shownRun.status === 'cancelling'));
  const showRun = backend.mode === 'api' && shownRun !== null &&
    (shownRun.status === 'running' || shownRun.status === 'cancelling' || shownRun.status === 'failed' ||
      shownRun.status === 'cancelled' || shownRun.status === 'blocked' || shownRun.status === 'skipped' ||
      shownRun.status === 'done' || shownRun.status === 'paused' || (shownRun.status === 'ready' && shownRun.skipReason === 'unfinished-writes'));

  React.useEffect(() => {
    if (status.dreamTasks != null || typeof backend.dreamCoverage !== 'function') return undefined;
    let cancelled = false;
    backend.dreamCoverage().then(
      (tasks) => {
        if (!cancelled) setCoverage({ tasks, error: null });
      },
      (error) => {
        if (!cancelled) setCoverage({ tasks: null, error });
      },
    );
    return () => { cancelled = true; };
  }, [status, backend]);

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
      const result = await backend.dream('estimate', { noSessions: memoryOnly });
      if (!result || result.rough !== true || !Number.isFinite(result.estimatedTokens) ||
          result.estimatedTokens < 0 || !Number.isFinite(result.limit) || result.limit < 0) {
        throw new Error(t('tidy.estimateUnavailable'));
      }
      return result;
    }, { refresh: false });
    if (done) setEstimate(done.value);
  };

  const startDream = async () => {
    setEstimate(null);
    const started = await run('start', () => backend.dream('start', { focus, noSessions: memoryOnly }), {
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
    setLive({ ...shownRun, ...value, status: action === 'cancel' ? 'cancelling' : value.status || 'running' });
  };

  /** A retired page and the page its facts moved into go together. */
  const withLinked = (files) => {
    const together = new Set(files);
    let previousSize;
    do {
      previousSize = together.size;
      for (const [from, to] of Object.entries(pending?.links ?? {})) {
        if (together.has(from) || together.has(to)) {
          together.add(from);
          together.add(to);
        }
      }
    } while (together.size !== previousSize);
    return together;
  };
  const ofRun = (value) => (pending && value.runId === pending.runId ? value.files : []);
  // A change without a checked source is left out (deferred, not rejected)
  // until the human reads its diff and accepts it.
  const blockedFiles = pending ? [...withLinked(pending.unsupported)] : [];
  const confirmedFiles = ofRun(confirmed).filter((name) => blockedFiles.includes(name));
  const viewedFiles = ofRun(viewed);
  const rejectedFiles = ofRun(rejected);
  const deferredFiles = blockedFiles.filter((name) => !confirmedFiles.includes(name) && !rejectedFiles.includes(name));
  const decisionOf = (name) => (rejectedFiles.includes(name) ? 'rejected' : deferredFiles.includes(name) ? 'deferred' : 'passed');
  const canConfirm = (target) => [...withLinked([target])].every((file) =>
    !pending.unsupported.includes(file) || viewedFiles.includes(file));
  /** Pass or reject one file together with its linked page. */
  const decide = (target, pass) => {
    if (pass && !canConfirm(target)) return;
    const together = withLinked([target]);
    setRejected({ runId: pending.runId, files: pass
      ? rejectedFiles.filter((name) => !together.has(name))
      : [...new Set([...rejectedFiles, ...together])] });
    if (blockedFiles.includes(target)) {
      setConfirmed({ runId: pending.runId, files: pass
        ? [...new Set([...confirmedFiles, ...together])]
        : confirmedFiles.filter((name) => !together.has(name)) });
    }
  };
  const switchTo = (rejectAll = false) =>
    run('switch', () => backend.dream('switch', rejectAll
      ? { runId: pending?.runId, reject: pending.files.map((item) => item.file) }
      : { runId: pending?.runId, reject: rejectedFiles, defer: deferredFiles,
        confirm: confirmedFiles.filter((file) => pending.unsupported.includes(file)) }), {
      check: (result) => {
        if (!result || result.ok === true) return '';
        if (result.error === 'conflict' && Array.isArray(result.conflicts)) {
          return t('tidy.switchConflict', { files: result.conflicts.map((item) => item.file).join(', ') });
        }
        if (result.error === 'evidence-required' && Array.isArray(result.files)) {
          return t('err.evidenceRejected') + ' ' + result.files.join(', ');
        }
        return result.message || result.error || 'failed';
      },
      success: t(rejectAll ? 'tidy.rejectAll' : 'tidy.switched'),
    });

  const discard = () =>
    run('discard', () => backend.dream('discard', { runId: pending?.runId }), {
      check: (result) => result?.error ? (result.message || result.error) : '',
      success: t('tidy.discarded'),
    });

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
          h('span', { className: 'ccm-pill' + runTone }, t(shownRun.decision ? 'tidy.decision.' + shownRun.decision : 'tidy.runState.' + runStatus)),
        ),
        // The internal stage name (agent/done) means nothing to a reader; say the outcome.
        runStatus === 'done' && shownRun.skipReason === 'nothing-new'
          ? h('p', { className: 'ccm-card-text' }, t('tidy.runNoChanges', {
            sessions: asNumber(shownRun.sessionsReviewed, 0),
            offered: asNumber(shownRun.sessionsOffered, 0),
            tokens: asNumber(shownRun.usage?.totalTokens, 0).toLocaleString(),
          }))
          : runStatus === 'done' && shownRun.skipReason === 'unfinished'
            ? h('p', { className: 'ccm-card-text' }, t('tidy.runUnfinished', { tokens: asNumber(shownRun.usage?.totalTokens, 0).toLocaleString() }))
          : (runStatus === 'done' || runStatus === 'ready') && shownRun.skipReason === 'incomplete-review'
            ? h('p', { className: 'ccm-card-text' }, t('tidy.runIncompleteReview', {
              sessions: asNumber(shownRun.sessionsReviewed, 0), offered: asNumber(shownRun.sessionsOffered, 0),
            }))
          : runStatus === 'skipped' && shownRun.skipReason
            ? h('p', { className: 'ccm-card-text' }, t('tidy.runSkipped', { reason: shownRun.skipReason }))
            : null,
        shownRun.error === 'unfinished-writes' || shownRun.skipReason === 'unfinished-writes'
          ? h('p', { className: 'ccm-card-text ccm-note-error' }, t('tidy.runUnfinishedWrites'))
          : shownRun.error === 'checkpoint-conflict'
            ? h('p', { className: 'ccm-card-text ccm-note-error' }, t('tidy.runCheckpointConflict'))
            : shownRun.error === 'checkpoint-unavailable'
              ? h('p', { className: 'ccm-card-text ccm-note-error' }, t('tidy.runCheckpointUnavailable'))
              : shownRun.error ? h('p', { className: 'ccm-card-text ccm-note-error' }, String(shownRun.error)) : null,
        shownRun.resumable ? h('p', { className: 'ccm-card-text' }, t('tidy.runCheckpoint', { n: shownRun.checkpointed || 0 })) : null,
        running ? h('div', { className: 'ccm-card-body' }, h('div', { className: 'ccm-progress' })) : null,
        running || shownRun.resumable || runStatus === 'cancelled' || runStatus === 'failed'
          ? h(
              'div',
              { className: 'ccm-foot' },
              running
                ? h('button', { type: 'button', className: 'ccm-btn', disabled: !idle || readOnly || runStatus === 'cancelling', onClick: () => runAction('cancel', 'cancel') }, t('tidy.runCancel'))
                : shownRun.resumable
                  ? h('button', { type: 'button', className: 'ccm-btn', disabled: !idle || !canRun || Boolean(pending), onClick: () => runAction('resume', 'resume') }, icon('refresh', 14), t('tidy.runResume'))
                  : h('button', { type: 'button', className: 'ccm-btn', disabled: !idle || readOnly, onClick: startDream }, icon('refresh', 14), t('tidy.runAgain')),
            )
          : null,
      )
    : null;

  const pendingFiles = pending ? [...pending.files.filter((item) => item.file !== 'MEMORY.md'),
    { file: 'MEMORY.md', action: 'index' }] : [];
  const decided = pending ? pending.files.filter((item) => item.file !== 'MEMORY.md') : [];
  const passedCount = decided.filter((item) => decisionOf(item.file) === 'passed').length;
  const linkOf = (name) => {
    if (!pending) return '';
    if (pending.links[name]) return pending.links[name];
    return Object.keys(pending.links).find((from) => pending.links[from] === name) || '';
  };
  async function openDiff(file) {
    if (preview?.runId === pending.runId && preview.file === file) {
      setPreview(null);
      return;
    }
    const request = { runId: pending.runId, file };
    setPreview(request);
    let result;
    try {
      result = await backend.dreamDiff(request.runId, file);
    } catch {
      result = { failed: true };
    }
    setPreview((current) => current === request ? { ...request, result } : current);
    if (!result?.failed) {
      setViewed((current) => ({ runId: request.runId, files: [...new Set([...(current.runId === request.runId ? current.files : []), file])] }));
    }
  }

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
        pending.wiki && (pending.wiki.pages[0] > 0 || pending.wiki.pages[1] > 0)
          ? h('p', { className: 'ccm-help' }, t('tidy.wikiSize', {
            pagesBefore: pending.wiki.pages[0], pagesAfter: pending.wiki.pages[1],
            charsBefore: pending.wiki.chars[0], charsAfter: pending.wiki.chars[1],
          })) : null,
        pendingFiles.map((item) => {
          const kind = item.action === 'added' ? 'create' : item.action === 'removed' ? 'delete' : item.action === 'index' ? 'index' : 'update';
          const expanded = preview?.runId === pending.runId && preview.file === item.file;
          const detail = expanded ? preview.result : null;
          const decision = decisionOf(item.file);
          const isRejected = decision === 'rejected';
          const unsourced = blockedFiles.includes(item.file);
          const matchedSource = pending.matchedSources?.includes(item.file);
          // An unsourced change can only be passed after its diff was read.
          const canPass = !unsourced || canConfirm(item.file);
          const linked = kind === 'index' ? '' : linkOf(item.file);
          const rejectedBefore = Array.isArray(pending.rejectedBefore?.[item.file]) ? pending.rejectedBefore[item.file] : [];
          return h(
            'div',
            { key: item.file, className: 'ccm-op' + (isRejected ? ' is-refused' : decision === 'deferred' ? ' is-muted' : '') },
            h(
              'div',
              { className: 'ccm-op-row' },
              h(
                'button',
                { type: 'button', className: 'ccm-op-toggle', 'aria-expanded': expanded, onClick: () => openDiff(item.file) },
                h('span', { className: 'ccm-chev' + (expanded ? ' is-open' : '') }, icon('chevron', 13)),
                h('span', { className: 'ccm-opkind', 'data-kind': kind }, t('tidy.op.' + kind)),
                h('span', { className: 'ccm-op-file' }, item.file),
                linked ? h('span', { className: 'ccm-op-delta' }, t('tidy.linked', { file: linked })) : null,
              ),
              // The index follows the pages that pass; it is not decided on its own.
              kind === 'index'
                ? null
                : h(
                    'div',
                    { className: 'ccm-seg', role: 'group', 'aria-label': item.file },
                    h('button', { type: 'button', 'aria-pressed': decision === 'passed' ? 'true' : 'false', disabled: !idle || readOnly || !canPass, title: canPass ? undefined : t('tidy.readDiffFirst'), onClick: () => decision !== 'passed' && decide(item.file, true) }, icon('check', 12), t(unsourced ? 'tidy.passUnsourced' : 'tidy.pass')),
                    h('button', { type: 'button', 'aria-pressed': isRejected ? 'true' : 'false', disabled: !idle || readOnly, onClick: () => !isRejected && decide(item.file, false) }, icon('close', 12), t('tidy.reject')),
                  ),
            ),
            unsourced && kind !== 'index'
              ? h('p', { className: 'ccm-note-error ccm-op-note' }, t(matchedSource
                ? (decision === 'passed' ? 'tidy.sourcePartialConfirmed' : 'tidy.sourcePartial')
                : (decision === 'passed' ? 'tidy.sourceConfirmed' : 'tidy.sourceMissing'))) : null,
            rejectedBefore.length > 0
              ? h('div', { className: 'ccm-op-note' },
                h('div', { className: 'ccm-diff-label' }, t('tidy.rejectedBefore')),
                ...rejectedBefore.map((line, index) => h('div', { key: index, className: 'ccm-help' }, line)))
              : null,
            expanded ? (detail && !detail.failed
              ? h('div', { className: 'ccm-diff-wide' },
                h('div', { className: 'ccm-diff' },
                  ...['before', 'after'].map((side) => h('div', { key: side },
                    h('div', { className: 'ccm-diff-label' }, t('tidy.' + side)),
                    h('pre', { className: 'ccm-pre' }, detail[side]
                      ? detail[side].split(/\r?\n/u).map((line, index) => {
                        const changed = (side === 'before' ? detail.removedLines : detail.addedLines)?.some((item) => item.line === index + 1);
                        return h('span', { key: index, className: changed ? (side === 'before' ? 'ccm-pre-removed' : 'ccm-pre-after') : undefined }, line, '\n');
                      })
                      : t('tidy.emptyFile'))))),
                Array.isArray(detail.evidence) && detail.evidence.length > 0
                  ? h('div', { className: 'ccm-evidence' },
                    h('div', { className: 'ccm-diff-label' }, t('tidy.evidenceTitle')),
                    ...dreamEvidenceRows(detail.evidence, t))
                  : null,
                detail.unsupportedClaims?.length > 0
                  ? h('div', { className: 'ccm-evidence' },
                    h('div', { className: 'ccm-diff-label' }, t('tidy.unsupportedClaims')),
                    ...detail.unsupportedClaims.map((claim) => h('div', { key: claim, className: 'ccm-evidence-row' }, claim)))
                  : null)
              : h('p', { className: 'ccm-card-text', role: 'status' }, t(detail ? 'tidy.diffError' : 'tidy.diffLoading')))
              : null,
          );
        }),
        h('div', { className: 'ccm-notes' }, h('div', { className: 'ccm-note' }, t('tidy.rejectHint'))),
        h(
          'div',
          { className: 'ccm-foot' },
          h('button', { type: 'button', className: 'ccm-btn ccm-btn-primary', disabled: !idle || readOnly || passedCount === 0, onClick: () => switchTo() }, icon('check', 14), t('tidy.applyPassed', { n: passedCount })),
          h('span', { className: 'ccm-spacer' }),
          h('button', { type: 'button', className: 'ccm-btn ccm-btn-ghost', disabled: !idle || readOnly, onClick: discard }, t('tidy.defer')),
          h(ConfirmButton, { tone: 'danger', className: 'ccm-btn-ghost ccm-btn-danger', label: t('tidy.rejectAll'), disabled: !idle || readOnly, onConfirm: () => switchTo(true), t }),
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
    canRun && !memoryOnly
      ? h(
          Field,
          { label: t('tidy.focus') },
          h('input', {
            className: 'ccm-input',
            value: focus,
            disabled: !idle || running,
            placeholder: t('tidy.focusPlaceholder'),
            onChange: (event) => setFocus(event.target.value),
          }),
        )
      : null,
    canRun
      ? h(
          'label',
          { className: 'ccm-checkline' },
          h('input', {
            type: 'checkbox',
            checked: memoryOnly,
            disabled: !idle || running,
            onChange: (event) => {
              setMemoryOnly(event.target.checked);
              setEstimate(null);
            },
          }),
          h('span', null, t('tidy.memoryOnly')),
        )
      : null,
    canRun && memoryOnly ? h('p', { className: 'ccm-help', style: { margin: 0 } }, t('tidy.memoryOnlyHint')) : null,
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

  const tasksCard = h(DreamTasksCard, { tasks: status.dreamTasks ?? coverage.tasks, error: coverage.error, t });
  return h(React.Fragment, null, runCard, resultCard, tasksCard, hero, historyCard);
}
