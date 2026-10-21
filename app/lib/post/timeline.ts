// 后期包装层：时间换算（纯函数，不碰浏览器 API，node 里可直接单测）。
// 输入是按顺序排好的生成段（实测时长 + 可选"只保留前 N 秒"），以及以整片时间计的包装轨；
// 输出是每段在成片里的起止、裁到片长内的包装轨、片子总长。

export interface SegmentInput {
  id: string;
  /** mediabunny 实测的段落时长（秒）。 */
  durationSeconds: number;
  /** 只保留前 N 秒（用于裁掉"多交的秒数"）。不给就整段保留。 */
  trimTo?: number;
}

export interface CaptionSpec { type: 'caption'; text: string; start: number; end: number; speaker?: string }
export interface FlashSpec { type: 'flash'; at: number; /** 闪白持续帧数，默认 6 帧 */ frames?: number }
export interface PopSpec { type: 'pop'; text: string; at: number; duration: number }
export type OverlaySpec = CaptionSpec | FlashSpec | PopSpec;

export interface TimelineSegment {
  id: string;
  index: number;
  /** 段内保留的时长（秒），从段首 0 秒开始。 */
  keepSeconds: number;
  /** 在成片中的起止（秒）。 */
  outputStart: number;
  outputEnd: number;
}

export interface PlacedCaption { type: 'caption'; start: number; end: number; lines: string[]; speaker?: string }
export interface PlacedFlash { type: 'flash'; start: number; end: number }
export interface PlacedPop { type: 'pop'; start: number; end: number; text: string }
export type PlacedOverlay = PlacedCaption | PlacedFlash | PlacedPop;

export interface Timeline {
  fps: number;
  segments: TimelineSegment[];
  overlays: PlacedOverlay[];
  /** 成片总时长（秒）。 */
  duration: number;
}

export interface CaptionLayoutOptions {
  /** 每行最多多少个"中文字宽"（西文字母约算半个字），默认 14。 */
  maxLineWidth?: number;
  /** 每屏最多几行，默认 2。 */
  maxLines?: number;
}

export interface CaptionChunk { lines: string[]; start: number; end: number }

export const DEFAULT_FPS = 30;
export const DEFAULT_FLASH_FRAMES = 6;
const EPS = 1e-6;

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** 段落顺序排好、裁好后的成片时间轴。 */
export function buildTimeline(segments: SegmentInput[], overlays: OverlaySpec[] = [], { fps = DEFAULT_FPS, caption }: { fps?: number; caption?: CaptionLayoutOptions } = {}): Timeline {
  if (!(fps > 0)) throw new Error('帧率必须大于 0');
  let cursor = 0;
  const placed: TimelineSegment[] = segments.map((segment, index) => {
    if (!(segment.durationSeconds > 0)) throw new Error(`第 ${index + 1} 段时长无效：${segment.durationSeconds}`);
    const keep = segment.trimTo !== undefined && segment.trimTo > 0 ? Math.min(segment.trimTo, segment.durationSeconds) : segment.durationSeconds;
    const outputStart = round(cursor);
    cursor += keep;
    return { id: segment.id, index, keepSeconds: round(keep), outputStart, outputEnd: round(cursor) };
  });
  const duration = round(cursor);
  const clip = (start: number, end: number) => {
    const s = Math.max(0, start);
    const e = Math.min(duration, end);
    return e - s > EPS ? { start: round(s), end: round(e) } : null;
  };
  const result: PlacedOverlay[] = [];
  for (const overlay of overlays) {
    if (overlay.type === 'caption') {
      for (const chunk of layoutCaption(overlay.text, overlay.start, overlay.end, caption)) {
        const window = clip(chunk.start, chunk.end);
        if (window) result.push({ type: 'caption', ...window, lines: chunk.lines, ...(overlay.speaker ? { speaker: overlay.speaker } : {}) });
      }
    } else if (overlay.type === 'flash') {
      const frames = overlay.frames && overlay.frames > 0 ? overlay.frames : DEFAULT_FLASH_FRAMES;
      const window = clip(overlay.at, overlay.at + frames / fps);
      if (window) result.push({ type: 'flash', ...window });
    } else if (overlay.type === 'pop') {
      const window = clip(overlay.at, overlay.at + Math.max(0, overlay.duration));
      if (window && overlay.text.trim()) result.push({ type: 'pop', ...window, text: overlay.text.trim() });
    }
  }
  result.sort((a, b) => a.start - b.start);
  return { fps, segments: placed, overlays: result, duration };
}

/** 段内时间 → 成片时间；落在被裁掉的部分返回 null。 */
export function segmentToOutputTime(timeline: Timeline, segmentId: string, localSeconds: number): number | null {
  const segment = timeline.segments.find(item => item.id === segmentId);
  if (!segment || localSeconds < 0 || localSeconds > segment.keepSeconds + EPS) return null;
  return round(segment.outputStart + localSeconds);
}

/** 成片时间 → 哪一段、段内第几秒。片尾时刻归最后一段。 */
export function locateOutputTime(timeline: Timeline, seconds: number): { segment: TimelineSegment; localSeconds: number } | null {
  const { segments } = timeline;
  if (!segments.length || seconds < -EPS || seconds > timeline.duration + EPS) return null;
  const segment = segments.find(item => seconds < item.outputEnd - EPS) ?? segments[segments.length - 1];
  return { segment, localSeconds: round(Math.max(0, seconds - segment.outputStart)) };
}

/** 成片总帧数（向下取整，保证最后一帧仍落在片长内）。 */
export function frameCount(timeline: Timeline) {
  return Math.max(0, Math.floor(timeline.duration * timeline.fps + EPS));
}

// ---------------- 字幕排版 ----------------

/** 视觉宽度：中文/全角算 1，西文、数字、半角符号算 0.5。 */
export function textWidth(text: string) {
  let width = 0;
  for (const char of text) width += isWide(char) ? 1 : 0.5;
  return width;
}

function isWide(char: string) {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x3000 && code <= 0x303f) || code >= 0x20000;
}

const CLAUSE_END = /[，。！？；：、,.!?;:…]/;
// 行尾不留的标点（问号、感叹号、省略号保留语气）。
const TRAILING_DROP = /[，。、,.;；：:\s]+$/u;

/** 先按标点切成小句，小句内再按宽度硬切（西文尽量在空格处断）。 */
function clauses(text: string, maxWidth: number) {
  const parts: string[] = [];
  let current = '';
  for (const char of text.replace(/\s+/g, ' ').trim()) {
    current += char;
    if (CLAUSE_END.test(char)) { parts.push(current); current = ''; }
  }
  if (current.trim()) parts.push(current);
  const pieces: string[] = [];
  for (const part of parts) {
    let rest = part.trim();
    // 超宽小句均分成 n 份（16 字切成 8+8，而不是 14+2）。
    const count = Math.ceil(textWidth(rest) / maxWidth);
    const target = Math.min(maxWidth, Math.ceil(textWidth(rest) / count));
    while (textWidth(rest) > maxWidth) {
      let cut = 0;
      let width = 0;
      const chars = [...rest];
      while (cut < chars.length && width + (isWide(chars[cut]) ? 1 : 0.5) <= target) { width += isWide(chars[cut]) ? 1 : 0.5; cut += 1; }
      // 西文：退回到最近的空格，别把单词劈开。
      const head = chars.slice(0, cut).join('');
      const space = head.lastIndexOf(' ');
      const nextIsLatin = cut < chars.length && !isWide(chars[cut]) && chars[cut] !== ' ';
      const breakAt = nextIsLatin && space > 0 ? [...head.slice(0, space)].length : cut;
      pieces.push(chars.slice(0, Math.max(1, breakAt)).join('').trim());
      rest = chars.slice(Math.max(1, breakAt)).join('').trim();
    }
    if (rest) pieces.push(rest);
  }
  return pieces;
}

/** 把小句尽量拼成不超宽的行。 */
function packLines(pieces: string[], maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const piece of pieces) {
    // 两边都是西文（含半角标点）时补回原有的空格。
    const joiner = line && !isWide([...line].pop() ?? '') && !isWide([...piece][0] ?? '') ? ' ' : '';
    const candidate = line ? line + joiner + piece : piece;
    if (line && textWidth(candidate.replace(TRAILING_DROP, '')) > maxWidth) { lines.push(line); line = piece; } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.map(item => item.replace(TRAILING_DROP, '').trim()).filter(Boolean);
}

/**
 * 一句台词 → 若干屏字幕。每屏 ≤ maxLines 行、每行 ≤ maxLineWidth 字宽，
 * 时间按字数比例铺满 [start, end)。
 */
export function layoutCaption(text: string, start: number, end: number, { maxLineWidth = 14, maxLines = 2 }: CaptionLayoutOptions = {}): CaptionChunk[] {
  const span = end - start;
  if (!(span > 0) || !text.trim()) return [];
  const lines = packLines(clauses(text, maxLineWidth), maxLineWidth);
  if (!lines.length) return [];
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += maxLines) groups.push(lines.slice(i, i + maxLines));
  const weights = groups.map(group => Math.max(1, group.reduce((sum, line) => sum + textWidth(line), 0)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cursor = start;
  return groups.map((group, i) => {
    const chunkStart = cursor;
    cursor = i === groups.length - 1 ? end : cursor + (span * weights[i]) / total;
    return { lines: group, start: round(chunkStart), end: round(cursor) };
  });
}
