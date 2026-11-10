/** Shared authority boundary for model-originated saves and updates. */
import { createHash } from 'node:crypto';
import { detectConflict, evaluateWrite } from './policy.js';
import { queuePendingWrite } from './pending-writes.js';

export const memoryHash = (raw) => createHash('sha256').update(raw).digest('hex');

/** Returns a tool result when the write must stop, otherwise null. */
export async function reviewWrite({ paths, candidate, entries = [], force = false, action = 'save', file = '', name = '', content, description, source, config = {}, existing }) {
  const decision = evaluateWrite({ candidate, entries, config });
  // Check independently: neither a high similarity score nor force may hide
  // a negation. A lexical conflict needs human review, not permanent rejection.
  const conflict = detectConflict(candidate, entries);
  const reasons = decision.action === 'low-confidence' ? [...decision.reasons] : [];
  if (conflict) reasons.push(conflict.reason);
  if (reasons.length > 0) {
    const queued = await queuePendingWrite(paths, {
      action, file, name, candidate, content, description, source,
      reasons,
      ...(typeof existing?.raw === 'string' ? { expectedHash: memoryHash(existing.raw) } : {}),
    });
    return { ok: true, written: false, action: 'queued-review', pendingId: queued.id, reasons,
      ...(conflict ? { existingFile: conflict.existingFile, conflicts: [{ file: conflict.existingFile, reason: conflict.reason }] } : {}),
      hint: 'Queued for human review. Use /memory writes; approve with /memory approve <id>.' };
  }
  if (!force && decision.action === 'duplicate') {
    return { ok: true, written: false, action: 'duplicate', existingFile: decision.existingFile, similarity: decision.similarity,
      hint: `Not written: ${decision.existingFile} already covers this memory. Use memory_update, or force:true for an intentional duplicate.` };
  }
  return null;
}
