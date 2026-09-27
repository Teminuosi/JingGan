const EPSILON = 0.15;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const seconds = value => {
  if (!finite(value) || value < 0 || value % 100 >= 60) return NaN;
  return Number((Math.floor(value / 100) * 60 + value % 100).toFixed(6));
};

// Only recover a complete MMSS.s encoding; never scale or guess a partial timeline.
/** @param {import('./types').VideoDnaAnalysis} analysis */
export function normalizeMinuteSecondTimeline(analysis, duration = analysis?.source?.duration_seconds) {
  if (!finite(duration) || duration <= 0 || !Array.isArray(analysis?.beats) || !analysis.beats.length) return analysis;
  const last = analysis.beats.at(-1)?.end_seconds;
  if (!finite(last) || last <= duration + EPSILON || !finite(seconds(last)) || Math.abs(seconds(last) - duration) > EPSILON) return analysis;
  let previous = 0;
  const changes = [];
  for (const beat of analysis.beats) {
    const start = seconds(beat.start_seconds), end = seconds(beat.end_seconds);
    if (beat.timeline_exception || !finite(start) || !finite(end) || end <= start || Math.abs(start - previous) > EPSILON || end > duration + EPSILON) return analysis;
    previous = end;
    let actionTime = start;
    for (const action of beat.action_beats || []) {
      const at = seconds(action.at_seconds);
      if (!finite(at) || at < start || at > end || at < actionTime) return analysis;
      actionTime = at;
    }
    for (const actor of beat.blocking?.actors || []) {
      for (const key of ['entry_at', 'exit_at']) {
        if (actor[key] === undefined) continue;
        const at = seconds(actor[key]);
        if (!finite(at) || at < start || at > end) return analysis;
      }
      if (actor.entry_at !== undefined && actor.exit_at !== undefined && seconds(actor.exit_at) < seconds(actor.entry_at)) return analysis;
    }
  }
  const result = structuredClone(analysis);
  for (const beat of result.beats) {
    const convert = (object, key, field) => {
      if (object[key] === undefined) return;
      const value = seconds(object[key]);
      if (value !== object[key]) changes.push(`${beat.beat_id}.${field}: ${object[key]} → ${value}`);
      object[key] = value;
    };
    convert(beat, 'start_seconds', 'start_seconds');
    convert(beat, 'end_seconds', 'end_seconds');
    (beat.action_beats || []).forEach((action, i) => convert(action, 'at_seconds', `action_beats[${i}].at_seconds`));
    (beat.blocking?.actors || []).forEach((actor, i) => {
      convert(actor, 'entry_at', `blocking.actors[${i}].entry_at`);
      convert(actor, 'exit_at', `blocking.actors[${i}].exit_at`);
    });
  }
  result.uncertainties = [...(result.uncertainties || []), `已修正分秒编码（MMSS.s → 秒），转换后完整覆盖原片 ${duration} 秒；未缩放时间或改写动作。此前对应的时间轴越界待核已由此次转换解决。${changes.join('；')}`];
  return result;
}
