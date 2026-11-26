import { Banner, EmptyState, icon } from './ui.js';
import { CSS } from './styles.js';
import { DreamTab } from './dream-tab.js';
import { MemoriesTab } from './memories-tab.js';
import { React, ViewBoundary, h } from './react.js';
import { SettingsTab } from './settings-tab.js';
import { UI_API } from './normalize.js';
import { errorInfo, errorText, loadSummary, planWaiting, projectLabel } from './model.js';
import { formatError } from './format.js';
import { resolveBackend, resolveT } from './slot-props.js';

const TABS = ['memories', 'tidy', 'settings'];

function readStoredTab() {
  try {
    const value = window.localStorage.getItem('cc-memory.tab');
    if (value === 'inbox') return 'tidy';
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

export function MemoryViewReady(props) {
  return h(ViewBoundary, { key: props.memSessionId }, h(MemoryView, props));
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

  const refreshSeq = React.useRef(0);
  const refreshInFlight = React.useRef(null);
  const refresh = React.useCallback(async () => {
    if (backend === null) {
      if (alive.current) setLoad({ phase: 'error', status: null, error: { code: 'no-backend' } });
      return null;
    }
    // One poll at a time: a burst of clicks (or a timer tick landing on a
    // slow request) shares the same read instead of queueing another one.
    if (refreshInFlight.current !== null) return refreshInFlight.current;
    const mine = refreshSeq.current + 1;
    refreshSeq.current = mine;
    const task = (async () => {
      try {
        const status = await backend.status({ view: 'panel' });
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
  const status = load.status;
  const readOnly = backend === null || backend.mode !== 'api';
  const errorMessage = load.error ? formatError(load.error) : '';
  const tokenExpired =
    load.error !== null && (load.error.status === 401 || /401|unauthori[sz]ed/i.test(errorMessage));
  const activeTab = tab;

  // ---- header ------------------------------------------------------------
  const summary = loadSummary(status, t);
  const tabs = [
    ['memories', t('tab.memories'), status ? h('span', { className: 'ccm-tab-n' }, String(status.entries.length)) : null],
    ['tidy', t('tab.tidy'), status && planWaiting(status) ? h('span', { className: 'ccm-badge-dot', title: t('tidy.reviewReady'), 'aria-label': t('tidy.reviewReady') }) : null],
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
  if (load.error?.code === 'no-backend') {
    banners.push(h(Banner, { key: 'nb', tone: 'error', text: t('banner.noBackend') }));
  }
  if (tokenExpired) {
    banners.push(h(Banner, {
      key: 'tk', tone: 'error', text: t('banner.tokenExpired'),
      action: status ? h('button', {
        type: 'button', className: 'ccm-btn ccm-btn-sm', disabled: busy !== '',
        onClick: () => run('refresh', refresh, { refresh: false }),
      }, t('btn.retry')) : null,
    }));
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
        backend
          ? h('button', { type: 'button', className: 'ccm-btn', disabled: busy !== '', onClick: () => run('refresh', () => refresh(), { refresh: false }) }, t('btn.retry'))
          : null,
    });
  } else {
    const tabProps = { status, backend, t, busy, run, notify, readOnly, refresh };
    if (activeTab === 'tidy') body = h(DreamTab, tabProps);
    else if (activeTab === 'settings') body = h(SettingsTab, tabProps);
    else body = h(MemoriesTab, tabProps);
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
