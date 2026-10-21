import type { StoryMoment, VideoDnaAnalysis } from './types';

/**
 * 关键时刻（analysis.moments）的取证时间与新片时间换算。纯函数，不调模型。
 *
 * 时刻挂在镜头和锚点上，不以秒数为准：新片每段的实际时长会和原片不同，
 * 这里按「时刻在原片这一段里的相对位置 × 新生成这一段的实际时长」换算（方案 2a）。
 * 有对白的时刻以后可以用语音对齐精修（2b，另批），这里只用模型给的 source_seconds。
 */

export const MOMENT_KINDS: StoryMoment['kind'][] = ['hook', 'reversal', 'gag', 'reveal', 'danger', 'product', 'emotion'];
export const MOMENT_KIND_LABELS: Record<StoryMoment['kind'], string> = { hook: '钩子', reversal: '反转', gag: '笑点', reveal: '揭晓', danger: '危机', product: '产品', emotion: '情绪' };

/** 新片里的一段：覆盖原片哪几镜、原片哪段时间，生成出来从第几秒开始、实际多长。 */
export interface MomentSegment {
  /** 本段覆盖的镜头。拆过的镜头编号是 原编号_2，也认作原镜头。 */
  beatIds: string[];
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputDuration: number;
}

const EPS = 0.001;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const round = (value: number) => +value.toFixed(3);
const beatOf = (analysis: VideoDnaAnalysis, beatId: string) => analysis.beats.find(beat => beat.beat_id === beatId);

/** 时刻在原片里的绝对秒数：动作锚点跟着那一拍走；相对位置按本镜长度算；对白用模型给的秒数，夹进本镜。 */
export function momentSourceSeconds(analysis: VideoDnaAnalysis, moment: StoryMoment): number | undefined {
  const beat = beatOf(analysis, moment.beat_id);
  if (!beat) return undefined;
  const { start_seconds: start, end_seconds: end } = beat;
  const anchor = moment.anchor;
  if (anchor?.type === 'action') {
    const step = beat.action_beats?.[anchor.action_index];
    if (step && Number.isFinite(step.at_seconds)) return round(clamp(step.at_seconds, start, end));
  }
  if (anchor?.type === 'beat' && Number.isFinite(anchor.position)) return round(start + clamp(anchor.position, 0, 1) * (end - start));
  if (Number.isFinite(moment.source_seconds)) return round(clamp(moment.source_seconds, start, end));
  return round((start + end) / 2);
}

const covers = (segment: MomentSegment, beatId: string) => segment.beatIds.some(id => id === beatId || id.startsWith(`${beatId}_`));

/**
 * 时刻在新片里的绝对秒数。找覆盖这一镜、且原片时间包含该时刻的那一段，段内按比例换算。
 * 段边界上的时刻归后一段（段区间左闭右开），最后一段的结尾也算在内。找不到返回 undefined。
 */
export function mapMomentTime(analysis: VideoDnaAnalysis, moment: StoryMoment, segments: MomentSegment[]): number | undefined {
  const at = momentSourceSeconds(analysis, moment);
  if (at === undefined) return undefined;
  const mine = segments.filter(segment => covers(segment, moment.beat_id) && segment.sourceEnd > segment.sourceStart);
  const segment = mine.find(item => at >= item.sourceStart - EPS && at < item.sourceEnd - EPS)
    ?? mine.find(item => Math.abs(at - item.sourceEnd) <= EPS);
  if (!segment || !(segment.outputDuration >= 0)) return undefined;
  const ratio = clamp((at - segment.sourceStart) / (segment.sourceEnd - segment.sourceStart), 0, 1);
  return round(segment.outputStart + ratio * segment.outputDuration);
}

/**
 * 模型给的时刻做一遍清洗：未知镜头、无标签、未知类型的丢掉；编号缺失或重复的重新编号；
 * 锚点不成立（空对白片段、动作序号越界）退回本镜相对位置；秒数夹进本镜；重要程度夹到 1–3。
 * 丢了什么写进 dropped，由调用方放进待核清单，不静默吞掉。
 */
export function normalizeMoments(analysis: VideoDnaAnalysis, raw: unknown): { moments: StoryMoment[]; dropped: string[] } {
  const dropped: string[] = [];
  if (!Array.isArray(raw)) return { moments: [], dropped: raw === undefined ? [] : ['moments 不是数组'] };
  const used = new Set<string>();
  const moments: StoryMoment[] = [];
  raw.forEach((item, index) => {
    const label = `moments 第 ${index + 1} 项`;
    if (!item || typeof item !== 'object') { dropped.push(`${label} 不是对象`); return; }
    const value = item as Record<string, unknown>;
    const beat = typeof value.beat_id === 'string' ? beatOf(analysis, value.beat_id) : undefined;
    if (!beat) { dropped.push(`${label} 指向不存在的镜头 ${String(value.beat_id)}`); return; }
    if (!MOMENT_KINDS.includes(value.kind as StoryMoment['kind'])) { dropped.push(`${label} 类型 ${String(value.kind)} 无效`); return; }
    if (typeof value.label !== 'string' || !value.label.trim()) { dropped.push(`${label} 没有说明`); return; }
    const length = beat.end_seconds - beat.start_seconds;
    const given = Number(value.source_seconds);
    const seconds = Number.isFinite(given) ? round(clamp(given, beat.start_seconds, beat.end_seconds)) : undefined;
    const fallbackPosition = seconds === undefined || length <= 0 ? 0.5 : round((seconds - beat.start_seconds) / length);
    const rawAnchor = (value.anchor && typeof value.anchor === 'object' ? value.anchor : {}) as Record<string, unknown>;
    let anchor: StoryMoment['anchor'];
    if (rawAnchor.type === 'dialogue' && typeof rawAnchor.phrase === 'string' && rawAnchor.phrase.trim()) anchor = { type: 'dialogue', phrase: rawAnchor.phrase.trim() };
    else if (rawAnchor.type === 'action' && Number.isInteger(rawAnchor.action_index) && (rawAnchor.action_index as number) >= 0 && (rawAnchor.action_index as number) < (beat.action_beats?.length ?? 0)) anchor = { type: 'action', action_index: rawAnchor.action_index as number };
    else anchor = { type: 'beat', position: Number.isFinite(Number(rawAnchor.position)) && rawAnchor.type === 'beat' ? round(clamp(Number(rawAnchor.position), 0, 1)) : fallbackPosition };
    let id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
    if (!id || used.has(id)) { let n = moments.length + 1; while (used.has(`m${n}`)) n += 1; id = `m${n}`; }
    used.add(id);
    const emphasis = Math.round(Number(value.emphasis));
    const moment: StoryMoment = { id, beat_id: beat.beat_id, kind: value.kind as StoryMoment['kind'], label: value.label.trim(), anchor, source_seconds: 0, emphasis: (Number.isFinite(emphasis) ? clamp(emphasis, 1, 3) : 1) as StoryMoment['emphasis'] };
    moment.source_seconds = seconds ?? momentSourceSeconds(analysis, moment)!;
    moments.push(moment);
  });
  // 只按原片时间排序，不改动各自内容；同一时间保持模型给的先后。
  moments.sort((a, b) => (momentSourceSeconds(analysis, a) ?? 0) - (momentSourceSeconds(analysis, b) ?? 0));
  return { moments, dropped };
}
