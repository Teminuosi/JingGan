// 预演导出：逐帧离屏渲染，用浏览器 WebCodecs（mediabunny）编码。
// 不边播边录——每一帧都按确定时间渲出来，机器慢也不会丢帧。
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat, canEncodeVideo } from 'mediabunny';
import { FPS, type Film, type FilmShot } from './film';
import { createPrevisScene, createRenderer } from './scene';

export interface ExportRange { shot: FilmShot; from?: number; to?: number }
export interface ExportResult { blob: Blob; extension: 'mp4' | 'webm'; frames: number; seconds: number }

async function pickFormat(width: number, height: number) {
  if (await canEncodeVideo('avc', { width, height })) return { codec: 'avc' as const, format: new Mp4OutputFormat({ fastStart: 'in-memory' }), extension: 'mp4' as const, mime: 'video/mp4' };
  if (await canEncodeVideo('vp9', { width, height })) return { codec: 'vp9' as const, format: new WebMOutputFormat(), extension: 'webm' as const, mime: 'video/webm' };
  throw new Error('这个浏览器不支持视频编码，无法导出预演视频。请换用最新版 Chrome 或 Edge。');
}

/** 镜内 [from, to) 秒对应的帧号（从 1 起，与 Blender 一致）。不给范围就是整镜。 */
export function frameRange(shot: FilmShot, from?: number, to?: number) {
  // 第 k 帧的时间是 (k-1)/24；与 FFmpeg -ss from -t (to-from) 一样取 from ≤ 时间 < to 的帧。
  const first = from === undefined ? 1 : Math.min(shot.frames, Math.max(1, Math.ceil(from * FPS - 1e-6) + 1));
  const last = to === undefined ? shot.frames : Math.max(first, Math.min(shot.frames, Math.ceil(to * FPS - 1e-6)));
  return { first, last };
}

/**
 * 把若干段（整片就是全部镜头）按顺序渲成一个视频文件。
 * onProgress(0..1)；signal 可中途取消。
 */
export async function exportFilm(film: Film, ranges: ExportRange[], { onProgress, signal }: { onProgress?: (value: number) => void; signal?: AbortSignal } = {}): Promise<ExportResult> {
  const { width, height } = film;
  const chosen = await pickFormat(width, height);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const renderer = createRenderer(canvas, width, height);
  const stage = createPrevisScene();
  const output = new Output({ format: chosen.format, target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: chosen.codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: FPS });
  const spans = ranges.map(range => ({ ...range, ...frameRange(range.shot, range.from, range.to) }));
  const total = spans.reduce((sum, span) => sum + span.last - span.first + 1, 0);
  let written = 0;
  try {
    await output.start();
    for (const span of spans) {
      for (let frame = span.first; frame <= span.last; frame++) {
        signal?.throwIfAborted();
        stage.pose(span.shot.plan, (frame - 1) / FPS, { width, height });
        renderer.render(stage.scene, stage.camera);
        await source.add(written / FPS, 1 / FPS);
        written += 1;
        if (written % 12 === 0) onProgress?.(written / total);
      }
    }
    source.close();
    await output.finalize();
  } catch (cause) {
    await output.cancel().catch(() => {});
    throw cause;
  } finally {
    stage.dispose();
    renderer.dispose();
  }
  onProgress?.(1);
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('视频编码没有产出文件');
  return { blob: new Blob([buffer], { type: chosen.mime }), extension: chosen.extension, frames: written, seconds: written / FPS };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
