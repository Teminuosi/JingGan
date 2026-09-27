import type { RemixBrief, RemixMode } from './types';

export function resolveRemixMode(brief: RemixBrief): RemixMode {
  const requestsContentChanges = Boolean(
    brief.newConcept.trim() || brief.settingBrief.trim(),
  );
  if (
    brief.mode === 'character_swap' &&
    (
      brief.sourceRightsScope !== 'owned_or_authorized' ||
      requestsContentChanges ||
      Object.values(brief.locks).some((enabled) => !enabled)
    )
  ) {
    return 'light_remix';
  }
  return brief.mode;
}

export function minimumDifferentiationAxes(mode: RemixMode): number {
  if (mode === 'character_swap') return 2;
  if (mode === 'light_remix') return 3;
  return 4;
}
