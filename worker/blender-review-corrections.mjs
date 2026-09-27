const fields = ['camera', 'actors', 'objects', 'environment', 'action_timeline', 'expression_timeline', 'summary'];

/** Only execution descriptions may change; identities and source timing stay fixed. */
export function applyReviewCorrections(dna, review) {
  const result = structuredClone(dna);
  if (!review.executionCorrections) return result;
  if (!review.evidence?.trim()) throw new Error('执行修正缺少原片依据');
  for (const [key, value] of Object.entries(review.executionCorrections)) {
    if (!fields.includes(key)) throw new Error(`不允许修改 ${key}`);
    result[key] = structuredClone(value);
  }
  const ids = dna.actors.map((a) => a.character_id).sort();
  if (JSON.stringify(result.actors.map((a) => a.character_id).sort()) !== JSON.stringify(ids)) throw new Error('修正不能增删角色');
  for (const actor of result.actors) {
    if (!['foreground', 'midground', 'background'].includes(actor.depth_layer)) throw new Error('角色景深无效');
    for (const key of ['entry_at', 'exit_at']) {
      if (actor[key] !== undefined && !Number.isFinite(actor[key])) throw new Error('角色时间无效');
    }
  }
  return result;
}
