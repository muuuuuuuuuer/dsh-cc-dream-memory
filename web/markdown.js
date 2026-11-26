import { h } from './react.js';

/** `spec.md#p2, 2026-11-10` → `spec.md#p2` for the chip; the title keeps it all. */
function shortCite(inner) {
  const value = String(inner === undefined || inner === null ? '' : inner).trim();
  const head = value.split(',')[0].trim();
  const parts = head.split('/');
  return parts[parts.length - 1] || value;
}

export function renderInline(text, options) {
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
export function renderMarkdown(text, options) {
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
