// 后期包装层：在浏览器里把生成段拼成整片，叠字幕/闪白/弹字，混原声与可选背景音乐，编码成 mp4。
// 全程本地：mediabunny 解码 → 画布逐帧绘制 → WebCodecs 编码；音频用 OfflineAudioContext 离线混音。
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import { frameCount, type PlacedCaption, type PlacedOverlay, type PlacedPop, type Timeline } from './timeline';

export interface ComposeAudio {
  /** 用户自己上传的背景音乐（默认不叠）。 */
  blob: Blob;
  /** 0..1，默认 0.25。 */
  gain?: number;
  /** 片尾淡出秒数，默认 1。 */
  fadeOutSeconds?: number;
}

export interface ComposeOptions {
  /** 与 timeline.segments 一一对应、同样顺序。 */
  segments: Blob[];
  timeline: Timeline;
  /** 不给就用 timeline.overlays。 */
  overlays?: PlacedOverlay[];
  /** 输出尺寸；不给就取第一段的显示尺寸（取偶数）。 */
  width?: number;
  height?: number;
  /** 不给就用 timeline.fps。 */
  fps?: number;
  audio?: ComposeAudio;
  /** 段落原声音量，默认 1。 */
  segmentGain?: number;
  onProgress?: (value: number, stage: 'audio' | 'video') => void;
  signal?: AbortSignal;
}

export interface ComposeResult {
  blob: Blob;
  extension: 'mp4' | 'webm';
  width: number;
  height: number;
  frames: number;
  seconds: number;
  hasAudio: boolean;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif';
const BRAND = '#10b981';

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** 读出每段实测时长（秒）。给 buildTimeline 用。 */
export async function measureSegments(blobs: Blob[]): Promise<number[]> {
  const result: number[] = [];
  for (const blob of blobs) {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error('这段文件里没有视频画面');
      // 以视频轨为准：音频轨常比画面略长，按它拼会多出黑帧。
      result.push(await video.computeDuration());
    } finally {
      input.dispose();
    }
  }
  return result;
}

async function pickFormat(width: number, height: number) {
  if (await canEncodeVideo('avc', { width, height })) return { codec: 'avc' as const, format: new Mp4OutputFormat({ fastStart: 'in-memory' }), extension: 'mp4' as const, mime: 'video/mp4' };
  if (await canEncodeVideo('vp9', { width, height })) return { codec: 'vp9' as const, format: new WebMOutputFormat(), extension: 'webm' as const, mime: 'video/webm' };
  throw new Error('这个浏览器不支持视频编码，无法导出成片。请换用最新版 Chrome 或 Edge。');
}

interface OpenedSegment { input: Input; video: InputVideoTrack; audio: InputAudioTrack | null; videoStart: number; audioStart: number }

async function openSegment(blob: Blob, index: number): Promise<OpenedSegment> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) { input.dispose(); throw new Error(`第 ${index + 1} 段没有视频画面`); }
  const audio = await input.getPrimaryAudioTrack();
  const videoStart = await video.getFirstTimestamp();
  const audioStart = audio ? await audio.getFirstTimestamp() : 0;
  return { input, video, audio, videoStart, audioStart };
}

// ---------------- 音频 ----------------

/** 一段的原声 → 一个 AudioBuffer（按段内时间放好、裁到保留长度）。没有音轨返回 null。 */
async function decodeSegmentAudio(segment: OpenedSegment, keepSeconds: number, signal?: AbortSignal): Promise<AudioBuffer | null> {
  if (!segment.audio) return null;
  if (!(await segment.audio.canDecode())) return null;
  const sampleRate = segment.audio.sampleRate;
  const channels = Math.max(1, segment.audio.numberOfChannels);
  const length = Math.max(1, Math.round(keepSeconds * sampleRate));
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  // 以视频首帧为段落零点，保持该段内的音画相对位置。
  const origin = segment.videoStart;
  const sink = new AudioBufferSink(segment.audio);
  for await (const wrapped of sink.buffers(origin, origin + keepSeconds)) {
    signal?.throwIfAborted();
    const offset = Math.round((wrapped.timestamp - origin) * sampleRate);
    const { buffer } = wrapped;
    for (let c = 0; c < channels; c++) {
      const source = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      const from = Math.max(0, -offset);
      const to = Math.min(source.length, length - offset);
      if (to > from) data[c].set(source.subarray(from, to), offset + from);
    }
  }
  const result = new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
  data.forEach((channel, c) => result.copyToChannel(channel, c));
  return result;
}

async function mixAudio(opened: OpenedSegment[], timeline: Timeline, options: ComposeOptions): Promise<AudioBuffer | null> {
  const { audio, signal } = options;
  const segmentGain = options.segmentGain ?? 1;
  const buffers: (AudioBuffer | null)[] = [];
  for (let i = 0; i < opened.length; i++) {
    signal?.throwIfAborted();
    buffers.push(await decodeSegmentAudio(opened[i], timeline.segments[i].keepSeconds, signal));
    options.onProgress?.((i + 1) / (opened.length + 1) * 0.5, 'audio');
  }
  if (!buffers.some(Boolean) && !audio) return null;
  const length = Math.max(1, Math.round(timeline.duration * SAMPLE_RATE));
  const context = new OfflineAudioContext({ numberOfChannels: CHANNELS, length, sampleRate: SAMPLE_RATE });
  const voice = context.createGain();
  voice.gain.value = segmentGain;
  voice.connect(context.destination);
  buffers.forEach((buffer, i) => {
    if (!buffer) return;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(voice);
    node.start(timeline.segments[i].outputStart, 0, timeline.segments[i].keepSeconds);
  });
  if (audio) {
    const decoded = await context.decodeAudioData(await audio.blob.arrayBuffer());
    const node = context.createBufferSource();
    node.buffer = decoded;
    node.loop = true;
    const gain = context.createGain();
    const level = Math.min(1, Math.max(0, audio.gain ?? 0.25));
    const fade = Math.min(timeline.duration, Math.max(0, audio.fadeOutSeconds ?? 1));
    gain.gain.setValueAtTime(level, 0);
    if (fade > 0) {
      gain.gain.setValueAtTime(level, timeline.duration - fade);
      gain.gain.linearRampToValueAtTime(0, timeline.duration);
    }
    node.connect(gain).connect(context.destination);
    node.start(0);
  }
  signal?.throwIfAborted();
  return context.startRendering();
}

/** 把整段混音切成 1 秒一块，边编码画面边交给音频轨，保持交错写入。 */
function sliceAudio(buffer: AudioBuffer, seconds = 1) {
  const step = Math.round(buffer.sampleRate * seconds);
  const slices: AudioBuffer[] = [];
  for (let start = 0; start < buffer.length; start += step) {
    const length = Math.min(step, buffer.length - start);
    const slice = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
    for (let c = 0; c < buffer.numberOfChannels; c++) slice.copyToChannel(buffer.getChannelData(c).subarray(start, start + length), c);
    slices.push(slice);
  }
  return slices;
}

// ---------------- 包装轨绘制 ----------------

function roundedRect(ctx: Canvas2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 字幕：白色粗体 + 深色描边，放在底部安全区上沿（竖屏避开平台底部按钮与文案区）。 */
export function drawCaption(ctx: Canvas2D, overlay: PlacedCaption, width: number, height: number) {
  const portrait = height > width;
  const size = Math.round(Math.min(height * (portrait ? 0.036 : 0.06), (width * 0.86) / 14));
  const lineHeight = size * 1.32;
  // 竖屏：底边留 22%（抖音/视频号底部标题、进度条、评论入口）；横屏留 10%。
  const bottom = height * (portrait ? 0.78 : 0.9);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  const lines = overlay.lines;
  lines.forEach((line, i) => {
    const y = bottom - (lines.length - 1 - i) * lineHeight;
    ctx.lineWidth = size * 0.18;
    ctx.strokeStyle = 'rgba(0,0,0,0.88)';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = size * 0.25;
    ctx.strokeText(line, width / 2, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, width / 2, y);
  });
  if (overlay.speaker) {
    const tagSize = Math.round(size * 0.55);
    ctx.font = `700 ${tagSize}px ${FONT_STACK}`;
    const y = bottom - (lines.length - 1) * lineHeight - size - tagSize * 0.6;
    ctx.lineWidth = tagSize * 0.2;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(overlay.speaker, width / 2, y);
    ctx.fillStyle = '#6ee7b7';
    ctx.fillText(overlay.speaker, width / 2, y);
  }
  ctx.restore();
}

/** 闪白：第一帧接近全白，随后线性淡出。 */
export function drawFlash(ctx: Canvas2D, t: number, start: number, end: number, width: number, height: number) {
  const p = (t - start) / Math.max(1e-6, end - start);
  const alpha = 0.92 * (1 - Math.min(1, Math.max(0, p)));
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

/** 弹字：画面中上部的圆角标签，0.18 秒弹入、最后 0.15 秒淡出。深色底 + 翠绿描边，沿用镜感风格。 */
export function drawPop(ctx: Canvas2D, overlay: PlacedPop, t: number, width: number, height: number) {
  const local = t - overlay.start;
  const remain = overlay.end - t;
  const scale = local < 0.18 ? Math.max(0.01, easeOutBack(local / 0.18)) : 1;
  const alpha = Math.min(1, local / 0.06, remain / 0.15);
  if (alpha <= 0) return;
  const size = Math.round(Math.min(width, height) * 0.075);
  ctx.save();
  ctx.font = `900 ${size}px ${FONT_STACK}`;
  const textW = Math.min(ctx.measureText(overlay.text).width, width * 0.8);
  const padX = size * 0.6;
  const padY = size * 0.38;
  const boxW = textW + padX * 2;
  const boxH = size + padY * 2;
  const cx = width / 2;
  const cy = height * 0.36;
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = size * 0.4;
  roundedRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, boxH * 0.32);
  ctx.fillStyle = 'rgba(8,20,16,0.88)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.strokeStyle = BRAND;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(overlay.text, 0, size * 0.04, width * 0.8);
  ctx.restore();
}

export function drawOverlays(ctx: Canvas2D, overlays: PlacedOverlay[], t: number, width: number, height: number) {
  // 先画字幕/弹字，最后盖闪白，让闪白真的"白一下"。
  for (const overlay of overlays) {
    if (t < overlay.start || t >= overlay.end) continue;
    if (overlay.type === 'caption') drawCaption(ctx, overlay, width, height);
    else if (overlay.type === 'pop') drawPop(ctx, overlay, t, width, height);
  }
  for (const overlay of overlays) {
    if (overlay.type === 'flash' && t >= overlay.start && t < overlay.end) drawFlash(ctx, t, overlay.start, overlay.end, width, height);
  }
}

// ---------------- 合成 ----------------

/**
 * 按 timeline 把各段拼成整片并编码。onProgress(0..1, 阶段)；signal 可中途取消。
 */
export async function composeFilm(options: ComposeOptions): Promise<ComposeResult> {
  const { segments, timeline, signal, onProgress } = options;
  if (segments.length !== timeline.segments.length) throw new Error(`段落文件数（${segments.length}）与时间轴段数（${timeline.segments.length}）不一致`);
  if (!segments.length) throw new Error('没有可合成的段落');
  const fps = options.fps ?? timeline.fps;
  const overlays = options.overlays ?? timeline.overlays;
  const opened: OpenedSegment[] = [];
  let output: Output | null = null;
  try {
    for (let i = 0; i < segments.length; i++) opened.push(await openSegment(segments[i], i));
    const first = opened[0].video;
    const rotated = first.rotation === 90 || first.rotation === 270;
    const width = even(options.width ?? (rotated ? first.squarePixelHeight : first.squarePixelWidth));
    const height = even(options.height ?? (rotated ? first.squarePixelWidth : first.squarePixelHeight));
    const chosen = await pickFormat(width, height);

    const mixed = await mixAudio(opened, { ...timeline, fps }, options);
    const audioCodec: AudioCodec | null = mixed
      ? await getFirstEncodableAudioCodec(chosen.format.getSupportedAudioCodecs().filter(codec => codec === 'aac' || codec === 'opus'), { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE })
      : null;

    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d') as Canvas2D | null;
    if (!ctx) throw new Error('无法创建画布');
    output = new Output({ format: chosen.format, target: new BufferTarget() });
    const videoSource = new CanvasSource(canvas, { codec: chosen.codec, bitrate: QUALITY_HIGH });
    output.addVideoTrack(videoSource, { frameRate: fps });
    const audioSource = audioCodec ? new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    const slices = mixed && audioSource ? sliceAudio(mixed) : [];
    let sliceIndex = 0;
    let audioQueued = 0;
    const feedAudio = async (untilSeconds: number) => {
      while (audioSource && sliceIndex < slices.length && audioQueued <= untilSeconds) {
        await audioSource.add(slices[sliceIndex]);
        audioQueued += slices[sliceIndex].duration;
        sliceIndex += 1;
      }
    };

    const total = frameCount({ ...timeline, fps });
    let written = 0;
    for (let s = 0; s < opened.length; s++) {
      const placed = timeline.segments[s];
      const segment = opened[s];
      // 本段负责的成片帧：outputStart ≤ t < outputEnd（最后一段到片尾）。
      const firstFrame = Math.ceil(placed.outputStart * fps - 1e-6);
      const endFrame = s === opened.length - 1 ? total : Math.min(total, Math.ceil(placed.outputEnd * fps - 1e-6));
      if (endFrame <= firstFrame) continue;
      const times = function* () { for (let f = firstFrame; f < endFrame; f++) yield segment.videoStart + Math.min(placed.keepSeconds - 1e-3, Math.max(0, f / fps - placed.outputStart)); };
      const sink = new VideoSampleSink(segment.video);
      let frame = firstFrame;
      for await (const sample of sink.samplesAtTimestamps(times())) {
        signal?.throwIfAborted();
        const t = frame / fps;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        if (sample) {
          sample.drawWithFit(ctx, { fit: 'contain' });
          sample.close();
        }
        drawOverlays(ctx, overlays, t, width, height);
        await feedAudio(t + 1);
        await videoSource.add(t, 1 / fps);
        frame += 1;
        written += 1;
        if (written % 15 === 0) onProgress?.(0.5 + 0.5 * (written / Math.max(1, total)), 'video');
      }
    }
    await feedAudio(Infinity);
    videoSource.close();
    audioSource?.close();
    await output.finalize();
    onProgress?.(1, 'video');
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('视频编码没有产出文件');
    return { blob: new Blob([buffer], { type: chosen.mime }), extension: chosen.extension, width, height, frames: written, seconds: written / fps, hasAudio: Boolean(audioSource) };
  } catch (cause) {
    if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
    throw cause;
  } finally {
    for (const segment of opened) segment.input.dispose();
  }
}
