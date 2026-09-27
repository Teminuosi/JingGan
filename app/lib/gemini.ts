'use client';

import {
  FileState,
  GoogleGenAI,
  MediaResolution,
  createPartFromUri,
  createUserContent,
} from '@google/genai';
import { ensureAccount } from './account-client';
import { CREATIVE_DRAFT_SCHEMA, VIDEO_DNA_SCHEMA, toResponseSchema } from './schemas';
import { compileCreativePrompts } from './compiler';
import {
  ANALYSIS_SYSTEM_INSTRUCTION,
  REMIX_SYSTEM_INSTRUCTION,
  buildAnalysisInstruction,
  buildRemixInstruction,
} from './prompts';
import type {
  AnalysisSettings,
  CharacterCandidate,
  CreativePack,
  GeminiResult,
  LocalVideoMetadata,
  ProgressStage,
  ReferenceAsset,
  RemixBrief,
  UsageStats,
  VideoDnaAnalysis,
} from './types';
import {
  parseCreativeDraft,
  parseVideoDna,
  parseReferenceDna,
  validateCompiledCreativePack,
  validateVideoDna,
} from './validation';
import { requireConnection, runRelayTask } from './relay-client';
import { redactRelayError } from './relay-protocol';
import { resolveRemixMode } from './remix-policy';

const MAX_FILE_BYTES = 1.9 * 1024 * 1024 * 1024;
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const CREATIVE_REQUEST_TIMEOUT_MS = 60 * 1000;
const TRANSIENT_RETRY_DELAYS_MS = [1500, 3500, 7000];
const CREATIVE_RETRY_DELAYS_MS = [2000, 6000];

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  webm: 'video/webm',
  wmv: 'video/wmv',
  '3gp': 'video/3gpp',
  '3gpp': 'video/3gpp',
};

export function supportedVideoMimeType(file: Pick<File, 'name' | 'type'>): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const byExtension = VIDEO_MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  return Object.values(VIDEO_MIME_BY_EXTENSION).includes(file.type.toLowerCase()) ? file.type.toLowerCase() : null;
}

function validateContextBudget(metadata: LocalVideoMetadata, settings: AnalysisSettings) {
  if (!metadata.durationSeconds) return;
  const visualTokensPerFrame = settings.mediaResolution === 'high' ? 258 : 70;
  const estimatedInputTokens = metadata.durationSeconds * (settings.fps * visualTokensPerFrame + 32);
  if (estimatedInputTokens > 800_000) {
    throw new Error('当前设置超过本应用估算的 80 万输入 token 预算（不是所选中转模型的官方上限）。请降低 FPS/画面精度，或先截取需要分析的片段。');
  }
}

/** 视频每帧折算的输入 token：低解析约 66，高解析约 258。用来在花钱之前把量级说清楚。 */
const TOKENS_PER_FRAME = { default: 66, high: 258 } as const;

/**
 * 花钱之前先把「这次会用什么设置、看多少画面、大概多少输入 token」算出来。
 * 不给预览，用户只能点下去之后从账单倒推——这正是上一轮静默降级五倍没人发现的原因。
 */
export function analysisPreview(
  connection: { model: string; advancedVideo: boolean },
  settings: AnalysisSettings,
  metadata: LocalVideoMetadata,
): { model: string; fps: number; resolution: 'default' | 'high'; effective: boolean; frames: number; promptTokens: number } {
  const seconds = metadata.durationSeconds ?? 0;
  // 不发参数时仅按 1 FPS、低解析估算，不能据此确认中转实际行为。
  const effective = connection.advancedVideo;
  const fps = effective ? settings.fps : 1;
  const resolution = effective && settings.mediaResolution === 'high' ? 'high' : 'default';
  const frames = Math.max(0, Math.round(seconds * fps));
  // 指令与 DNA 模板本身约 2,500 token，量级估算里不能漏。
  return { model: connection.model, fps, resolution, effective, frames, promptTokens: Math.round(frames * TOKENS_PER_FRAME[resolution] + seconds * 32 + 2500) };
}

/** 记录请求参数与估算的不确定性，不将 token 用量等同于采样证据。 */
function samplingCaveats(
  connection: { advancedVideo: boolean },
  settings: AnalysisSettings,
  usage: { promptTokenCount?: number } | undefined,
  metadata: LocalVideoMetadata,
): string[] {
  const notes: string[] = [];
  if (!connection.advancedVideo) {
    notes.push('本次未发送采样与解析精度参数，实际使用中转与模型的默认值；无法确认采样帧数，瞬时动作、视线和后景细节需要复核。');
  } else if (settings.mediaResolution !== 'high') {
    notes.push('本次未请求 High 解析精度，小道具、字幕与后景细节需要复核；提高解析精度也不能保证完整取证。');
  }
  // 事前预览用的是同一套估算，这里直接复用：两处口径必须一致，否则预览说 34,000、事后判定又按别的数走。
  const seconds = metadata.durationSeconds ?? 0;
  const promptTokens = usage?.promptTokenCount ?? 0;
  if (connection.advancedVideo && seconds > 5 && promptTokens > 0) {
    const expected = analysisPreview({ model: '', advancedVideo: true }, settings, metadata).promptTokens;
    if (promptTokens < expected * 0.5) {
      notes.push(`本次中转报告输入 ${promptTokens.toLocaleString()} token，低于按 ${settings.fps} FPS × ${settings.mediaResolution === 'high' ? 'High' : '默认'}解析估算的约 ${Math.round(expected).toLocaleString()}。估算方式、模型和中转处理都可能影响差异；不能仅据 token 反推采样是否生效，逐拍动作需要复核。`);
    }
  }
  return notes;
}

function usageFrom(response: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}): UsageStats {
  const usage = response.usageMetadata;
  return {
    promptTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    thinkingTokens: usage?.thoughtsTokenCount ?? 0,
    totalTokens: usage?.totalTokenCount ?? 0,
  };
}

function extractText(response: { text?: string | null }): string {
  if (!response.text) throw new Error('Gemini 没有返回分析内容，请重试。');
  return response.text.trim();
}

function isTransientGeminiError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return /Retryable HTTP Error|\b(?:500|502|503|504)\b|UNAVAILABLE|high demand|overload|temporar(?:y|ily) unavailable|ECONNRESET|ETIMEDOUT|timeout|timed out|AbortError|aborted/i.test(raw);
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  retryDelays: readonly number[] = TRANSIENT_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientGeminiError(error) || attempt >= retryDelays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

function friendlyError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  // SDK 的重试包装在读 body 之前就抛这句，上游真实原因已经被丢掉。我们已不再启用它，
  // 但万一别的路径再冒出来，至少要告诉用户「这不是你操作的问题、可能已扣费、去哪查」。
  if (/Non-retryable exception .* sending request/i.test(raw)) {
    return new Error('中转返回了一个未成功的响应，但具体原因在传输层被丢弃了。请先到中转站的使用日志确认这次调用是否已扣费，再决定要不要重试。');
  }
  if (/IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT/i.test(raw)) {
    return new Error('角色图被安全策略拦截。请移除真人姓名、品牌仿制或可能被理解为未成年人的描述后重试。');
  }
  if (/IMAGE_RECITATION/i.test(raw)) {
    return new Error('角色图与现有图片过于相似。请加强原创外形锚点后重试。');
  }
  if (/NO_IMAGE/i.test(raw)) {
    return new Error('模型没有生成图片，请收窄角色描述后重试。角色方案和项目记录不会丢失。');
  }
  if (isTransientGeminiError(error)) {
    return new Error('Gemini 当前请求量过高，已自动重试 3 次仍未恢复。请等待 1–2 分钟后再试，或在设置中切换到 Gemini 3.5 Flash。');
  }
  if (/429|quota|rate.?limit/i.test(raw)) {
    return new Error('Gemini 当前限流或额度不足，请稍后重试，或切换到预算模型。');
  }
  if (/api.?key|permission|403|401/i.test(raw)) {
    return new Error('Gemini API Key 无效或没有该模型权限，请检查设置。');
  }
  if (/fetch|network|failed to fetch/i.test(raw)) {
    return new Error('无法连接 Gemini，请检查网络、代理或 API 可用性。');
  }
  return error instanceof Error ? error : new Error(raw);
}

async function pollUntilActive(
  ai: GoogleGenAI,
  name: string,
  onProgress?: (stage: ProgressStage) => void,
) {
  const started = Date.now();
  while (Date.now() - started < PROCESSING_TIMEOUT_MS) {
    const file = await ai.files.get({ name });
    if (file.state === FileState.ACTIVE) return file;
    if (file.state === FileState.FAILED) throw new Error('Gemini 处理视频失败，请换一个编码后重试。');
    onProgress?.('processing');
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error('Gemini 处理视频超时。建议先压缩或截短视频再试。');
}

function applyLocalMetadata(analysis: VideoDnaAnalysis, metadata: LocalVideoMetadata) {
  if (metadata.durationSeconds && metadata.durationSeconds > 0) {
    analysis.source.duration_seconds = Number(metadata.durationSeconds.toFixed(3));
    analysis.beats[analysis.beats.length - 1].end_seconds = analysis.source.duration_seconds;
  }
  if (metadata.width && metadata.height) {
    const ratio = metadata.width / metadata.height;
    const known = [
      [16 / 9, '16:9'],
      [9 / 16, '9:16'],
      [4 / 3, '4:3'],
      [3 / 4, '3:4'],
      [1, '1:1'],
    ] as const;
    const nearest = known.reduce((best, current) =>
      Math.abs(current[0] - ratio) < Math.abs(best[0] - ratio) ? current : best,
    );
    analysis.source.aspect_ratio = Math.abs(nearest[0] - ratio) < 0.04
      ? nearest[1]
      : `${metadata.width}:${metadata.height}`;
  }
}

export async function analyzeRelayVideo(options: {
  file: File; settings: AnalysisSettings; metadata: LocalVideoMetadata;
  onProgress?: (stage: ProgressStage) => void;
}): Promise<GeminiResult<VideoDnaAnalysis>> {
  const { file, metadata, onProgress } = options;
  const connection = requireConnection('analysis');
  const session = await ensureAccount(connection.accountId);
  if (!session.ok) { const result = await session.json() as { error?: string }; throw new Error(result.error || '请先登录后分析视频。'); }
  const settings = { ...options.settings, model: connection.model };
  const mimeType = supportedVideoMimeType(file);
  if (!mimeType) throw new Error('视频格式不支持，请使用 MP4。');
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过本应用本地读取上限 1.9 GiB；这不是中转上传上限。');
  if (connection.advancedVideo) validateContextBudget(metadata, settings);
  const ai = new GoogleGenAI({ apiKey: connection.apiKey, httpOptions: {
    baseUrl: `${window.location.origin}/api/relay/native`, apiVersion: 'v1beta',
    headers: { 'x-relay-base': connection.baseUrl, 'x-relay-key': connection.apiKey, 'x-mirror-account-id': connection.accountId || '' },
    // 不传 retryOptions：SDK 一旦启用重试包装，非 2xx 会在读 body 之前就抛
    // `Non-retryable exception <statusText> sending request`，把我们中转层辛苦拼好的
    // {error, requestId} 整个丢掉，用户只看到一句没有任何信息量的英文。不传它时走
    // throwErrorIfNotOK，错误里带的是上游真实原因。attempts:1 本来也不重试，白亏。
    timeout: 20 * 60 * 1000,
  } });
  let remoteName = '';
  let completed: GeminiResult<VideoDnaAnalysis> | undefined;
  try {
    const key = `analysis:${file.name}:${file.size}:${file.lastModified}`;
    sessionStorage.setItem('mirror:relay:last-analysis', key);
    const result = await runRelayTask(key, async () => {
      onProgress?.('uploading');
      let videoPart;
      if (connection.videoTransport === 'files') {
        const uploaded = await ai.files.upload({ file, config: { mimeType, displayName: 'video-dna-source' } });
        if (!uploaded.name) throw new Error('中转上传没有返回文件标识。');
        remoteName = uploaded.name;
        onProgress?.('processing');
        const ready = uploaded.state === FileState.ACTIVE ? uploaded : await pollUntilActive(ai, remoteName, onProgress);
        if (!ready.uri) throw new Error('上传没有返回可分析的文件 URI。');
        videoPart = createPartFromUri(ready.uri, mimeType);
      } else {
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        videoPart = { inlineData: { mimeType, data }, videoMetadata: undefined as { fps: number } | undefined };
      }
      if (connection.advancedVideo) videoPart.videoMetadata = { fps: settings.fps };
      const prompt = connection.advancedVideo ? buildAnalysisInstruction(settings, metadata) : buildAnalysisInstruction(settings, metadata).replace(/The analysis sampling request is[^\n]+/, 'Use the service default sampling. Do not claim sub-frame timing precision.');
      onProgress?.('analyzing');
      // 必须用流式。非流式时整个分析期间连接上一个字节都不走，
      // 中转前面的 Cloudflare 等满 100 秒就掐断，返回 HTTP 524——
      // 而那时上游任务往往已经建好并在计费。长片（80k token 以上）必中。
      // 流式下分片持续到达，连接一直有数据，就不会被判定为超时。
      const stream = await ai.models.generateContentStream({ model: connection.model, contents: createUserContent([videoPart, prompt]), config: {
        systemInstruction: ANALYSIS_SYSTEM_INSTRUCTION, responseMimeType: 'application/json', responseSchema: toResponseSchema(VIDEO_DNA_SCHEMA), maxOutputTokens: 32768,
        ...(connection.advancedVideo && settings.mediaResolution === 'high' ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH } : {}),
      } });
      let text = '';
      let usageMetadata: { totalTokenCount?: number; promptTokenCount?: number } | undefined;
      let modelVersion: string | undefined;
      let chunks = 0;
      for await (const chunk of stream) {
        if (chunk.text) { text += chunk.text; chunks += 1; }
        // 用量和模型版本只在末尾的分片里带，后到的覆盖先到的。
        if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
        if (chunk.modelVersion) modelVersion = chunk.modelVersion;
      }
      // 流中途断掉会得到一段不完整的 JSON，解析会报一句看不懂的语法错。
      // 这里提前说清是「断在半路」，并且**不自动改回非流式重试**——
      // 上游多半已经算过钱了，闷头再来一次就是再扣一次。
      if (!text.trim()) throw new Error('中转没有返回任何内容。这一次可能已经计费，请先查中转日志，不要立刻重试。');
      if (chunks > 1 && !text.trimEnd().endsWith('}')) {
        throw new Error(`分析结果在传输途中断了（已收到 ${chunks} 个分片、${text.length} 字符，JSON 不完整）。这一次可能已经计费，请先在上传页展开「已经有分析结果？」试试恢复，不要直接重试。`);
      }
      return { text, usageMetadata, modelVersion };
    }) as { text: string; usageMetadata?: { totalTokenCount?: number; promptTokenCount?: number }; modelVersion?: string };
    const analysis = parseReferenceDna(result.text);
    if (metadata.durationSeconds && Math.abs(metadata.durationSeconds - analysis.source.duration_seconds) > 0.1) {
      analysis.uncertainties.push(`分析标注时长 ${analysis.source.duration_seconds} 秒与本地视频 ${metadata.durationSeconds.toFixed(3)} 秒不一致；使用实际视频时长，参考镜头时间保留供复核，不强行拉伸。`);
      analysis.source.duration_seconds = Number(metadata.durationSeconds.toFixed(3));
    }
    // 降级采样必须跟着数据走，不能只停在界面上：这份 DNA 会被保存、被投影成分镜、被拿去生成，
    // 中间任何一步看到它都该知道「这次只看了一部分画面」。
    analysis.uncertainties.push(...samplingCaveats(connection, settings, result.usageMetadata, metadata));
    completed = { data: analysis, usage: usageFrom(result), modelVersion: result.modelVersion || connection.model, remoteFileDeleted: true };
    return completed;
  } catch (error) {
    // 分析是最贵、也是用户第一个碰到的一步，之前这里只做脱敏、不做翻译，
    // 于是 SDK 的英文原文直接糊到界面上（栽过 Non-retryable exception unknown sending request）。
    // 先翻译成人话再脱敏，两件事都要做。
    throw new Error(redactRelayError(friendlyError(error).message, connection.apiKey));
  }
  finally {
    if (remoteName) { onProgress?.('cleaning'); try { await ai.files.delete({ name: remoteName }); } catch { if (completed) completed.remoteFileDeleted = false; } }
    onProgress?.('done');
  }
}

export async function analyzeVideo(options: {
  file: File;
  apiKey: string;
  settings: AnalysisSettings;
  metadata: LocalVideoMetadata;
  onProgress?: (stage: ProgressStage) => void;
}): Promise<GeminiResult<VideoDnaAnalysis>> {
  const { file, apiKey, settings, metadata, onProgress } = options;
  if (!apiKey.trim()) throw new Error('请先填写 Gemini API Key。');
  if (file.size > MAX_FILE_BYTES) throw new Error('视频超过本应用本地读取上限 1.9 GiB。');
  const mimeType = supportedVideoMimeType(file);
  if (!mimeType) throw new Error('Gemini 不支持这个视频格式，请先转换为 MP4、MOV、WebM、AVI、WMV、FLV、MPEG 或 3GP。');
  validateContextBudget(metadata, settings);

  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  let remoteName = '';
  let remoteFileDeleted = true;
  let completed: Omit<GeminiResult<VideoDnaAnalysis>, 'remoteFileDeleted'> | null = null;
  let caughtError: Error | null = null;

  try {
    onProgress?.('uploading');
    const uploaded = await ai.files.upload({
      file,
      config: {
        mimeType,
        displayName: 'video-dna-source',
      },
    });
    if (!uploaded.name) throw new Error('Gemini 上传没有返回文件标识。');
    remoteName = uploaded.name;

    onProgress?.('processing');
    const ready = uploaded.state === FileState.ACTIVE ? uploaded : await pollUntilActive(ai, remoteName, onProgress);
    if (!ready.uri || !ready.mimeType) throw new Error('Gemini 文件缺少可分析 URI。');

    const videoPart = createPartFromUri(ready.uri, ready.mimeType);
    videoPart.videoMetadata = { fps: settings.fps };

    onProgress?.('analyzing');
    const response = await withTransientRetry(() => ai.models.generateContent({
      model: settings.model,
      contents: createUserContent([videoPart, buildAnalysisInstruction(settings, metadata)]),
      config: {
        systemInstruction: ANALYSIS_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: toResponseSchema(VIDEO_DNA_SCHEMA),
        ...(settings.model.startsWith('gemini-2.5-') ? { temperature: 0.2 } : {}),
        maxOutputTokens: 32768,
        mediaResolution:
          settings.mediaResolution === 'high'
            ? MediaResolution.MEDIA_RESOLUTION_HIGH
            : undefined,
      },
    }));

    const analysis = parseVideoDna(extractText(response));
    applyLocalMetadata(analysis, metadata);
    validateVideoDna(analysis);
    completed = {
      data: analysis,
      usage: usageFrom(response),
      modelVersion: response.modelVersion ?? settings.model,
    };
  } catch (error) {
    caughtError = friendlyError(error);
  } finally {
    if (remoteName) {
      onProgress?.('cleaning');
      try {
        await ai.files.delete({ name: remoteName });
      } catch {
        remoteFileDeleted = false;
      }
    }
  }

  if (caughtError) {
    if (!remoteFileDeleted) {
      throw new Error(`${caughtError.message} 临时文件删除也未成功，Gemini 会在 48 小时后自动清理。`);
    }
    throw caughtError;
  }
  if (!completed) throw new Error('Gemini 分析没有完成，请重试。');
  onProgress?.('done');
  return { ...completed, remoteFileDeleted };
}

export async function compileCreativePack(options: {
  analysis: VideoDnaAnalysis;
  brief: RemixBrief;
  selectedCharacters: CharacterCandidate[];
  referenceAssets: ReferenceAsset[];
  apiKey: string;
  model: string;
  onProgress?: (stage: ProgressStage) => void;
}): Promise<GeminiResult<CreativePack>> {
  const { analysis, brief, selectedCharacters, referenceAssets, apiKey, model, onProgress } = options;
  if (!apiKey.trim()) throw new Error('请先填写 Gemini API Key。');
  if (selectedCharacters.length !== analysis.source_roles.length) throw new Error('请先为每个角色选择一个方案。');
  if (brief.sourceRightsScope === 'unselected') throw new Error('请先明确选择参考素材范围。');
  const effectiveMode = resolveRemixMode(brief);
  const selectedAssets = referenceAssets.filter((asset) =>
    !asset.retired &&
    asset.approved &&
    selectedCharacters.some((candidate) =>
      candidate.character_id === asset.character_id &&
      candidate.candidate_id === asset.candidate_id &&
      candidate.reference_image_prompt === asset.prompt,
    ),
  );
  if (selectedAssets.length !== selectedCharacters.length) throw new Error('请先保存并确认每个已选角色的参考图。');
  const ai = new GoogleGenAI({
    apiKey: apiKey.trim(),
    // 同上：重试包装会吞掉错误 body，这里由 withTransientRetry 自己处理重试。
    httpOptions: { timeout: CREATIVE_REQUEST_TIMEOUT_MS },
  });
  try {
    onProgress?.('remixing');
    const response = await withTransientRetry(() => ai.models.generateContent({
      model,
      contents: buildRemixInstruction(analysis, brief, selectedCharacters, selectedAssets),
      config: {
        systemInstruction: REMIX_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: toResponseSchema(CREATIVE_DRAFT_SCHEMA),
        ...(model.startsWith('gemini-2.5-') ? { temperature: 0.55 } : {}),
        maxOutputTokens: 32768,
      },
    }), CREATIVE_RETRY_DELAYS_MS);
    const allowSourceDialogue = false;
    const parsedDraft = parseCreativeDraft(extractText(response), { analysis, allowSourceDialogue, remixMode: effectiveMode, selectedCharacters });
    const pack = compileCreativePrompts(parsedDraft, { ...brief, analysis, selectedCharacters, referenceAssets: selectedAssets });
    validateCompiledCreativePack(pack, analysis, allowSourceDialogue, selectedCharacters);
    onProgress?.('done');
    return {
      data: pack,
      usage: usageFrom(response),
      modelVersion: response.modelVersion ?? model,
      remoteFileDeleted: true,
    };
  } catch (error) {
    if (isTransientGeminiError(error)) {
      const raw = error instanceof Error ? error.message.trim() : String(error).trim();
      const detail = raw && !/^Retryable HTTP Error:\s*$/i.test(raw) ? `（${raw}）` : '';
      throw new Error(`Gemini 返回了可重试的网络或服务错误${detail}，已自动重试 2 次仍未恢复。角色图和当前项目进度均已保留，请稍后再次点击生成。`);
    }
    throw friendlyError(error);
  }
}
