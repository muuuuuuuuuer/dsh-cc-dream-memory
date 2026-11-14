/**
 * Host agents wrap a session, while scheduler events and stored transcripts
 * can expose its header directly. Classify the same delegation metadata once.
 */
export function isDelegated(value) {
  const session = value?.session ?? value;
  const header = session?.header ?? value?.header ?? session;
  return Boolean(header?.parentSession || header?.origin === 'subagent' ||
    session?.origin === 'subagent' || value?.origin === 'subagent');
}
