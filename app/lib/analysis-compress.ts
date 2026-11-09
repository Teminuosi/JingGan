import { ALL_FORMATS, BlobSource, BufferTarget, canEncodeAudio, Conversion, Input, Mp4OutputFormat, Output, type ConversionAudioOptions } from 'mediabunny';

/**
 * 分析视频是整段 base64 塞进一个请求发出去的（inlineData），镜感服务器和中转站前面都是 Cloudflare，
 * 单个请求体上限 100MB（2026-11-08 不带 Key 发空包实测：95MB 过、110MB 回 413）。
 * base64 会胀约 1/3，所以原片超过这个值就先在浏览器里压小再发，留足余量。
 */
export const ANALYSIS_INLINE_MAX_BYTES = 45 * 1024 * 1024;
/** 压缩后的目标体积：比上限再低一点，给码率波动留空间。 */
const TARGET_BYTES = 40 * 1024 * 1024;
/** 按最贵的那档音频算预算（双声道 128k），实际用的码率只会更低。 */
const AUDIO_BITRATE = 128_000;
/** Gemini 看视频每秒只抽一两帧、低精度约 256px，480p 足够看清动作和画面字。 */
const MAX_SHORT_SIDE = 480;
const MAX_VIDEO_BITRATE = 1_000_000;
const MIN_VIDEO_BITRATE = 150_000;

export function needsAnalysisCompression(size: number) {
  return size > ANALYSIS_INLINE_MAX_BYTES;
}

/** 按时长算码率：短片用上限码率，长片压到能装进目标体积为止；低于下限说明片子太长，压了也看不清。 */
export function analysisVideoBitrate(durationSeconds: number) {
  const budget = (TARGET_BYTES * 8) / Math.max(1, durationSeconds) - AUDIO_BITRATE;
  return Math.min(MAX_VIDEO_BITRATE, Math.floor(budget));
}

export function tooLongForAnalysis(durationSeconds: number) {
  return analysisVideoBitrate(durationSeconds) < MIN_VIDEO_BITRATE;
}

/**
 * 选一档本机浏览器真能编的 AAC。Windows 版 Chrome 的系统 AAC 编码器不认单声道 64k，
 * 传了它 mediabunny 会把音轨直接丢掉（no_encodable_target_codec）——2026-11-08 实测栽过，压出来的片子没声音。
 * 一档都编不了就原样拷贝原音轨（不重编码，体积照原片音频算）。
 */
async function pickAudioOptions(): Promise<ConversionAudioOptions> {
  const tiers = [
    { numberOfChannels: 1, sampleRate: 48_000, bitrate: 64_000 },
    { numberOfChannels: 2, sampleRate: 48_000, bitrate: 96_000 },
    { numberOfChannels: 2, sampleRate: 48_000, bitrate: 128_000 },
  ];
  for (const tier of tiers) {
    if (await canEncodeAudio('aac', tier).catch(() => false)) return { codec: 'aac', ...tier };
  }
  return { codec: 'aac' };
}

/** 能装进一次分析请求的最长时长（秒）：低于下限码率就看不清了。 */
export const ANALYSIS_MAX_SECONDS = Math.floor((TARGET_BYTES * 8) / (MIN_VIDEO_BITRATE + AUDIO_BITRATE));

function scaledSize(width: number, height: number) {
  const short = Math.min(width, height);
  // 不缩放时也要凑偶数：强制 H.264 重编码，奇数宽高（如 853×480）编码器会拒。
  const k = short <= MAX_SHORT_SIDE ? 1 : MAX_SHORT_SIDE / short;
  // H.264 要偶数宽高
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** 只给「发去分析」用的压缩版，不落盘、不替换项目里的原片；时长不变，镜头时间码照样对得上。 */
export async function compressForAnalysis(file: File, onProgress?: (progress: number) => void): Promise<File> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    if (!(await input.canRead())) throw new Error('无法读取这个视频容器，请先转成标准 MP4 再分析。');
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('文件里没有可用的视频轨道。');
    const [duration, width, height] = await Promise.all([input.computeDuration([track]), track.getDisplayWidth(), track.getDisplayHeight()]);
    if (tooLongForAnalysis(duration)) {
      throw new Error(`视频有 ${Math.round(duration)} 秒，太长了，压缩后也装不进一次分析请求（上限约 100MB）。请先剪成 ${Math.floor(ANALYSIS_MAX_SECONDS / 60)} 分钟以内的片段再分析。`);
    }
    const size = scaledSize(width, height);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { ...size, fit: 'contain', codec: 'avc', bitrate: analysisVideoBitrate(duration), forceTranscode: true },
      // 声音要留：分析要听台词和音乐节奏。
      audio: await pickAudioOptions(),
      tags: {},
      showWarnings: false,
    });
    if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.isVideoTrack())) {
      throw new Error('这个视频在浏览器里压缩不了，请先用剪辑软件导出成 480p 的 MP4（40MB 以内）再分析。');
    }
    // 原片有声音、压完却没了，宁可报错也不悄悄交一份哑片去分析（台词、节奏全会丢）。
    const sourceHasAudio = (await input.getAudioTracks()).length > 0;
    if (sourceHasAudio && !conversion.utilizedTracks.some((t) => t.isAudioTrack())) {
      throw new Error('这个视频的声音在浏览器里压缩不了，为免分析丢掉台词已停止。请先用剪辑软件导出成 480p 的 MP4（40MB 以内）再分析。');
    }
    conversion.onProgress = (p) => onProgress?.(Math.max(0, Math.min(1, p)));
    await conversion.execute();
    const buffer = target.buffer;
    if (!buffer) throw new Error('压缩后的视频没有写出来，请重试。');
    // 45MB×1.4≈63MB，base64 后约 84MB，加上提示词仍在实测能过的 95MB 以内。
    if (buffer.byteLength > ANALYSIS_INLINE_MAX_BYTES * 1.4) {
      throw new Error(`压缩后仍有 ${(buffer.byteLength / 1024 / 1024).toFixed(0)}MB，超过一次分析请求的上限。请先剪短再分析。`);
    }
    onProgress?.(1);
    return new File([buffer], file.name.replace(/\.[^.]+$/, '') + '-分析用.mp4', { type: 'video/mp4', lastModified: file.lastModified });
  } finally {
    input.dispose();
  }
}
