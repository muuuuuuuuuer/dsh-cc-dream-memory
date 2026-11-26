import { React, h } from './react.js';
import { STATUS_NAMES, knownType, trustOf, typeStyle } from './model.js';

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
  layers: 'M12 2l10 5-10 5L2 7z M2 17l10 5 10-5 M2 12l10 5 10-5',
  archive: 'M21 8v13H3V8 M1 3h22v5H1z M10 12h4',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 3',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  dot: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
};

export function icon(name, size) {
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

/** Index usage ratio and meter class for a budget. */
export function budgetMeter(lines, bytes, maxLines, maxBytes, overflow) {
  const ratio = Math.max(maxLines > 0 ? lines / maxLines : 0, maxBytes > 0 ? bytes / maxBytes : 0);
  const over = overflow === true || ratio > 1;
  return {
    ratio,
    over,
    className: 'ccm-meter' + (over ? ' is-over' : ratio > 0.8 ? ' is-warn' : ''),
    width: Math.min(100, Math.round(ratio * 100)) + '%',
  };
}

/** Two-step button: the first click arms it, the second confirms. */
export function ConfirmButton(props) {
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

export function Switch(props) {
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

export function TypeTag(props) {
  const type = knownType(props.type);
  return h('span', { className: 'ccm-tag', style: typeStyle(type) }, h('span', { className: 'ccm-dot' }), props.t('type.' + type));
}

export const TRUST_ICONS = { verified: 'shield', changed: 'edit', stale: 'archive', unverified: 'dot' };

/** Trust pill; quiet (nothing) for unverified notes. */
export function TrustBadge(props) {
  const trust = trustOf(props.entry);
  if (trust === 'unverified') return null;
  const label =
    trust === 'stale'
      ? props.t(STATUS_NAMES.includes(props.entry.status) ? 'status.' + props.entry.status : 'trust.stale')
      : props.t('trust.' + trust);
  return h('span', { className: 'ccm-trust', 'data-trust': trust }, icon(TRUST_ICONS[trust], 11), label);
}

export function Field(props) {
  return h(
    'label',
    { className: 'ccm-field' },
    h('span', { className: 'ccm-label' }, props.label),
    props.children,
    props.help ? h('span', { className: 'ccm-help' }, props.help) : null,
  );
}

export function Banner(props) {
  return h(
    'div',
    { className: 'ccm-banner' + (props.tone === 'error' ? ' ccm-banner-error' : ''), role: 'status' },
    icon('alert', 16),
    h('span', { className: 'ccm-banner-text' }, props.text),
    props.action || null,
  );
}

export function EmptyState(props) {
  return h(
    'div',
    { className: 'ccm-card ccm-empty' },
    h('div', { className: 'ccm-empty-icon' + (props.tone === 'ok' ? ' is-ok' : '') }, icon(props.icon, 22)),
    h('div', { className: 'ccm-empty-title' }, props.title),
    props.text ? h('div', { className: 'ccm-empty-text' }, props.text) : null,
    props.action || null,
  );
}
