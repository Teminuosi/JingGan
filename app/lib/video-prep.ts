import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';

const MAX_BUFFER_BYTES = 100 * 1024 * 1024;

interface SavePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

type SaveFilePicker = (options?: SavePickerOptions) => Promise<FileSystemFileHandle>;

export interface SilentVideoResult {
  file: File;
  filename: string;
  savedToDisk: boolean;
  sourceAudioTracks: number;
  outputAudioTracks: number;
  durationSeconds: number;
  width: number;
  height: number;
}

export interface SilentVideoOptions {
  onProgress?: (progress: number) => void;
}

function outputSettings(file: File) {
  const lowerName = file.name.toLowerCase();
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'video';
  if (lowerName.endsWith('.webm') || file.type === 'video/webm') {
    return {
      filename: `${baseName}-无音轨.webm`,
      mimeType: 'video/webm',
      extension: '.webm',
      format: new WebMOutputFormat(),
    };
  }
  if (lowerName.endsWith('.mov') || file.type === 'video/quicktime') {
    return {
      filename: `${baseName}-无音轨.mov`,
      mimeType: 'video/quicktime',
      extension: '.mov',
      format: new MovOutputFormat(),
    };
  }
  return {
    filename: `${baseName}-无音轨.mp4`,
    mimeType: 'video/mp4',
    extension: '.mp4',
    format: new Mp4OutputFormat(),
  };
}

function createInput(file: Blob) {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

async function inspectVideo(file: Blob) {
  const input = createInput(file);
  try {
    if (!(await input.canRead())) throw new Error('无法读取这个视频容器，请先转成 MP4、MOV 或 WebM。');
    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    const primaryVideo = await input.getPrimaryVideoTrack();
    if (!primaryVideo || videoTracks.length === 0) throw new Error('文件里没有可用的视频轨道。');
    const [durationSeconds, width, height] = await Promise.all([
      input.computeDuration([primaryVideo]),
      primaryVideo.getDisplayWidth(),
      primaryVideo.getDisplayHeight(),
    ]);
    return { videoTracks, audioTracks, primaryVideo, durationSeconds, width, height };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

export async function createSilentVideo(file: File, options: SilentVideoOptions = {}): Promise<SilentVideoResult> {
  const settings = outputSettings(file);
  const savePicker = (globalThis as typeof globalThis & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  let fileHandle: FileSystemFileHandle | null = null;
  let writable: FileSystemWritableFileStream | null = null;
  let target: BufferTarget | StreamTarget;

  if (savePicker) {
    fileHandle = await savePicker({
      suggestedName: settings.filename,
      types: [{ description: '无音轨参考视频', accept: { [settings.mimeType]: [settings.extension] } }],
    });
    writable = await fileHandle.createWritable();
    target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true });
  } else {
    if (file.size > MAX_BUFFER_BYTES) {
      throw new Error('当前浏览器无法流式保存大文件。请用最新版 Chrome 或 Edge 打开，再处理超过 100MB 的视频。');
    }
    target = new BufferTarget();
  }

  const sourceInput = createInput(file);
  let output: Output | null = null;
  let outputFile: File;
  let sourceInfo: Awaited<ReturnType<typeof inspectVideo>> | null = null;
  try {
    sourceInfo = await inspectVideo(file);
    output = new Output({ format: settings.format, target });
    const conversion = await Conversion.init({
      input: sourceInput,
      output,
      tracks: 'primary',
      audio: { discard: true },
      tags: {},
      showWarnings: false,
    });
    if (!conversion.isValid || !conversion.utilizedTracks.some((track) => track.isVideoTrack())) {
      const reasons = conversion.discardedTracks.map((entry) => entry.reason).join('、');
      throw new Error(`这个视频暂时不能无损移除音轨${reasons ? `（${reasons}）` : ''}，请先转成标准 MP4 后重试。`);
    }
    const wronglyDiscardedAudio = conversion.discardedTracks.some((entry) => entry.track.isAudioTrack() && entry.reason !== 'discarded_by_user');
    if (wronglyDiscardedAudio) throw new Error('音轨移除计划未按预期建立，请先转成标准 MP4 后重试。');
    conversion.onProgress = (progress) => options.onProgress?.(Math.max(0, Math.min(1, progress)));
    await conversion.execute();
    options.onProgress?.(1);

    if (fileHandle) {
      outputFile = await fileHandle.getFile();
    } else {
      const buffer = (target as BufferTarget).buffer;
      if (!buffer) throw new Error('无音轨视频没有正确写入。');
      outputFile = new File([buffer], settings.filename, { type: settings.mimeType });
    }
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    else if (writable) await writable.abort().catch(() => undefined);
    throw error;
  } finally {
    sourceInput.dispose();
    sourceInfo?.primaryVideo.input.dispose();
  }

  const outputInfo = await inspectVideo(outputFile);
  try {
    if (outputInfo.audioTracks.length !== 0) throw new Error('输出校验失败：文件仍包含音轨，不能交给即梦。');
    if (outputInfo.videoTracks.length < 1) throw new Error('输出校验失败：视频轨道丢失。');
    const durationTolerance = Math.max(0.1, sourceInfo!.durationSeconds * 0.001);
    if (Math.abs(outputInfo.durationSeconds - sourceInfo!.durationSeconds) > durationTolerance) {
      throw new Error('输出校验失败：移除音轨后视频时长发生了变化。');
    }
    if (outputInfo.width !== sourceInfo!.width || outputInfo.height !== sourceInfo!.height) {
      throw new Error('输出校验失败：移除音轨后画面尺寸发生了变化。');
    }
    return {
      file: outputFile,
      filename: settings.filename,
      savedToDisk: Boolean(fileHandle),
      sourceAudioTracks: sourceInfo!.audioTracks.length,
      outputAudioTracks: outputInfo.audioTracks.length,
      durationSeconds: outputInfo.durationSeconds,
      width: outputInfo.width,
      height: outputInfo.height,
    };
  } finally {
    outputInfo.primaryVideo.input.dispose();
  }
}
