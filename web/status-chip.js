import { CHIP_CSS } from './styles.js';
import { React, ViewBoundary, h } from './react.js';
import { loadSummary } from './model.js';
import { resolveBackend, resolveT } from './slot-props.js';

export function MemoryStatusChipReady(props) {
  return h(ViewBoundary, { key: props.memBackend?.sessionId }, h(MemoryStatusChip, props));
}

function MemoryStatusChip(props) {
  const t = resolveT(props);
  const backend = resolveBackend(props);
  const [status, setStatus] = React.useState(null);
  const [hidden, setHidden] = React.useState(false);

  React.useEffect(() => {
    if (!backend?.sessionId) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const next = await backend.chipStatus();
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
  const summary = loadSummary(status, t);
  return h(
    React.Fragment,
    null,
    h('style', null, CHIP_CSS),
    h(
      'div',
      {
        className: 'ccm-chip-dock',
        title: summary?.text || t('chip.title'),
        'data-cc-memory-chip': '1',
      },
      h('span', { className: 'ccm-chip-dot', 'data-on': on ? 'true' : 'false' }),
      h('span', null, t('chip.label')),
      h('span', { className: 'ccm-chip-count' }, String(status.entryCount)),
      status.needsReview ? h('span', { className: 'ccm-chip-alert' }, '· ' + t('chip.attention', { n: 1 })) : null,
    ),
  );
}
