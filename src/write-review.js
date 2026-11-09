/** Shared authority boundary for model-originated saves and updates. */
import { createHash } from 'node:crypto';
import { detectConflict, evaluateWrite } from './policy.js';
import { queuePendingWrite } from './pending-writes.js';

export const memoryHash = (raw) => createHash('sha256').update(raw).digest('hex');

/** Returns a tool result when the write must stop, otherwise null. */
export async function reviewWrite({ paths, candidate, entries = [], force = false, action = 'save', file = '', name = '', content, description, source, config = {}, existing }) {
  const decision = evaluateWrite({ candidate, entries, config });
  if (decision.action === 'low-confidence') {
    const queued = await queuePendingWrite(paths, {
      action, file, name, candidate, content, description, source,
      reasons: decision.reasons,
      ...(typeof existing?.raw === 'string' ? { expectedHash: memoryHash(existing.raw) } : {}),
    });
    return { ok: true, written: false, action: 'queued-review', pendingId: queued.id, reasons: decision.reasons,
      hint: 'Queued for human review. Use /memory writes; approve with /memory approve <id>.' };
  }
  // Check conflict independently: a high similarity score or force flag must
  // not hide a negation of the existing fact. This is a lexical heuristic.
  const conflict = detectConflict(candidate, entries);
  if (conflict) {
    return { ok: true, written: false, action: 'conflict', existingFile: conflict.existingFile,
      conflicts: [{ file: conflict.existingFile, reason: conflict.reason }],
      hint: `Not written: it may contradict ${conflict.existingFile}. Read that note; if the user clearly corrected it, update its owning file instead.` };
  }
  if (!force && decision.action === 'duplicate') {
    return { ok: true, written: false, action: 'duplicate', existingFile: decision.existingFile, similarity: decision.similarity,
      hint: `Not written: ${decision.existingFile} already covers this memory. Use memory_update, or force:true for an intentional duplicate.` };
  }
  return null;
}
