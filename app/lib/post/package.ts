// 后期包装层：从项目数据推出默认字幕、时刻在成片里的时间、包装轨。纯函数，node 里可直接单测。
// 改这里的任何东西都只重算包装层：不调用模型、不扣费。
import type { CreativeBeat, SeedanceRun, StoryMoment, VideoDnaAnalysis } from '../types';
import { mapMomentTime, type MomentSegment } from '../moments';
import { textWidth, type OverlaySpec, type TimelineSegment } from './timeline';

/** 一条默认字幕：属于哪一镜、在本段里的相对位置（0..1）。 */
export interface CaptionLine { beatId: string; text: string; from: number; to: number }

/** 去掉 "CHAR_A:" 说话人标签，按说话人/换行拆成一句一句。 */
export function dialogueLines(dialogue: string): string[] {
  return dialogue
    .split(/\n+|(?=\bCHAR_[A-Z0-9_]+\s*[:：])/)
    .map(line => line.replace(/^\s*CHAR_[A-Z0-9_]+\s*[:：]\s*/, '').replace(/^["“「『]+|["”」』]+$/g, '').trim())
    .filter(Boolean);
}

/**
 * 一段的默认字幕：取这一段覆盖的每一镜的台词（保留原剧情 = 翻译后的对白；重写 = 新台词，
 * 都是出片时实际用的 beat.dialogue），按这一镜在本段里的时间窗放；一镜多句按字数分时间。
 */
export function defaultCaptionLines(run: Pick<SeedanceRun, 'beat_ids' | 'source_start_seconds' | 'source_end_seconds'>, beats: Pick<CreativeBeat, 'beat_id' | 'start_seconds' | 'end_seconds' | 'dialogue'>[]): CaptionLine[] {
  const span = run.source_end_seconds - run.source_start_seconds;
  if (!(span > 0)) return [];
  const result: CaptionLine[] = [];
  for (const beatId of run.beat_ids) {
    const beat = beats.find(item => item.beat_id === beatId);
    if (!beat || !beat.dialogue?.trim()) continue;
    const start = Math.max(run.source_start_seconds, beat.start_seconds);
    const end = Math.min(run.source_end_seconds, beat.end_seconds);
    // 镜头时间和段落对不上时，整段都算这一镜的。
    const from = end > start ? (start - run.source_start_seconds) / span : 0;
    const to = end > start ? (end - run.source_start_seconds) / span : 1;
    const lines = dialogueLines(beat.dialogue);
    const weights = lines.map(line => Math.max(1, textWidth(line)));
    const total = weights.reduce((sum, value) => sum + value, 0);
    let cursor = from;
    lines.forEach((text, index) => {
      const next = index === lines.length - 1 ? to : cursor + ((to - from) * weights[index]) / total;
      result.push({ beatId, text, from: round(cursor), to: round(next) });
      cursor = next;
    });
  }
  return result;
}

/** 用户改过的字幕（每行一句）。base 是改的时候的默认文字，默认变了（重新编译了故事）就作废，跟提示词编辑同一个规矩。 */
export interface CaptionEdit { base: string; lines: string[] }

export const captionBase = (lines: CaptionLine[]) => lines.map(line => line.text).join('\n');

/**
 * 这一段最终用的字幕（相对位置）。没改过 → 默认；改过且行数没变 → 每行沿用原来的时间窗；
 * 行数变了 → 按字数在整段里重新铺开。空行跳过。
 */
export function effectiveCaptionLines(defaults: CaptionLine[], edit?: CaptionEdit): Array<Pick<CaptionLine, 'text' | 'from' | 'to'>> {
  if (!edit || edit.base !== captionBase(defaults)) return defaults;
  const lines = edit.lines.map(line => line.trim());
  if (lines.length === defaults.length) return defaults.map((line, index) => ({ ...line, text: lines[index] })).filter(line => line.text);
  const kept = lines.filter(Boolean);
  const weights = kept.map(line => Math.max(1, textWidth(line)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return kept.map((text, index) => {
    const from = cursor;
    cursor = index === kept.length - 1 ? 1 : cursor + weights[index] / total;
    return { text, from: round(from), to: round(cursor) };
  });
}

/** 时刻在成片里的时间：手动修正优先，其次按比例换算（mapMomentTime），都没有就是 undefined。 */
export function momentOutputTime(analysis: VideoDnaAnalysis, moment: StoryMoment, segments: MomentSegment[], overrides: Record<string, number> = {}): { seconds?: number; manual: boolean } {
  const manual = overrides[moment.id];
  if (manual !== undefined && Number.isFinite(manual) && manual >= 0) return { seconds: manual, manual: true };
  return { seconds: mapMomentTime(analysis, moment, segments), manual: false };
}

/** 时间轴上的段落 → 时刻换算用的段落（新片时间 = 段落设计时间；成片里实际保留多久就按多久换算）。 */
export function momentSegments(runs: Pick<SeedanceRun, 'run_id' | 'beat_ids' | 'source_start_seconds' | 'source_end_seconds'>[], placed: TimelineSegment[]): MomentSegment[] {
  return placed.flatMap(segment => {
    const run = runs.find(item => item.run_id === segment.id);
    return run ? [{ beatIds: run.beat_ids, sourceStart: run.source_start_seconds, sourceEnd: run.source_end_seconds, outputStart: segment.outputStart, outputDuration: segment.keepSeconds }] : [];
  });
}

export interface PostToggles { captions: boolean; flash: boolean; pop: boolean }

/** 已定的默认：字幕开、闪白开（只在强度 3 的时刻）、弹字关。没有音效；背景音乐只能自己上传。 */
export const DEFAULT_TOGGLES: PostToggles = { captions: true, flash: true, pop: false };
export const POP_SECONDS = 1.4;

/**
 * 组装包装轨（以成片时间计）。字幕按段落的保留时长铺；闪白只打在强度 3 的时刻；
 * 弹字打在强度 ≥ 2 的时刻，文字默认是时刻说明，可改。
 */
export function buildOverlays({ toggles, segments, captions, moments, popText = {} }: {
  toggles: PostToggles;
  segments: TimelineSegment[];
  captions: Record<string, Array<Pick<CaptionLine, 'text' | 'from' | 'to'>>>;
  moments: Array<{ moment: StoryMoment; seconds?: number }>;
  popText?: Record<string, string>;
}): OverlaySpec[] {
  const overlays: OverlaySpec[] = [];
  if (toggles.captions) {
    for (const segment of segments) {
      for (const line of captions[segment.id] ?? []) {
        const start = segment.outputStart + line.from * segment.keepSeconds;
        const end = segment.outputStart + line.to * segment.keepSeconds;
        if (end - start > 0.05 && line.text.trim()) overlays.push({ type: 'caption', text: line.text, start: round(start), end: round(end) });
      }
    }
  }
  for (const { moment, seconds } of moments) {
    if (seconds === undefined) continue;
    if (toggles.flash && moment.emphasis === 3) overlays.push({ type: 'flash', at: seconds });
    if (toggles.pop && moment.emphasis >= 2) {
      const text = (popText[moment.id] ?? moment.label).trim();
      if (text) overlays.push({ type: 'pop', text, at: seconds, duration: POP_SECONDS });
    }
  }
  return overlays;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;
