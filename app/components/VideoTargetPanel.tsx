'use client';
import { useEffect, useMemo, useState } from 'react';
import { zipSync } from 'fflate';
import Image from 'next/image';
import { compactCreativePrompt, CREATIVE_PROMPT_LIMIT, editedRun, matchingPrevisShot, voiceSpeakers, withPrevisBinding, withVoiceRoles, type OutputShot, type PromptEdit } from '../lib/output-runs';
import type { CreativePack, ReferenceAsset, SeedanceRun, VideoDnaAnalysis } from '../lib/types';
import { downloadText } from '../lib/export';
import { beatShotSegments } from '../lib/original-story';
import { confirmAction, confirmChoice } from '../lib/confirm';
import { accountFetch, currentAccountId } from '../lib/account-client';
import { loadFilm, loadRun } from '../lib/previs/browser-run';
import type { Film } from '../lib/previs/film';
import { PrevisClip } from './PrevisViewer';
import { RoleLeakNotice } from './RoleLeakNotice';
import { loadPrevisAttach, resolvePrevisAttach, savePrevisAttach, type PrevisAttachState } from '../lib/previs-attach';
import { PostPanel } from './PostPanel';
import { fetchSegmentVideo, latestSegments, listSegments, measureBlob, saveSegment, SEGMENTS_CHANGED, type SegmentRecord } from '../lib/post/segment-store';
import { describeCallPlan, FRESHNESS_LABEL, isStale, planOutputCalls, requestFingerprint, segmentFreshness, stableJson, type CurrentFingerprint } from '../lib/post/segments';
import { loadConnection, pollRelayVideo, probeVideoParam, rawRelayVideoResult, recoverRelayVideoTask, relayUsage, submitRelayVideo, videoCacheKey, type VideoTaskState } from '../lib/relay-client';
import {
  applySecondsOverride, buildShots, buildVideoRequest, checkVideoPlan, estimateCredits, isParamEditable, isSubmittableImage, loadModelStatus, loadParamProbes, PARAM_SOURCE_HINT, PARAM_SOURCE_LABEL, probeFromError, probeVerdict, PROBE_BADGE, rememberModelStatus, rememberParamProbe, resolveSeconds, toApiPrompt, videoModel, videoParamSpecs,
  type ParamProbe,
  type ParamSource,
  type ParamValue,
  type VideoModelCapability,
  type VideoResolution,
} from '../lib/video-models';

/** 来源标记的配色：实测=绿、据文档=灰、未验证=琥珀。一眼看出哪几项是真的试过。 */
const SOURCE_DOT: Record<ParamSource, string> = {
  verified: 'bg-emerald-300',
  documented: 'bg-white/30',
  assumed: 'bg-amber-300',
};

/**
 * 探测用的越界值：每一个都远超任何一档的合理范围，上游只可能拒绝，不可能当成正常请求。
 * 配合空 prompt 一起发，双保险。
 */
const PROBE_VALUES: Array<{ key: string; body: Record<string, unknown>; why: string }> = [
  { key: 'seconds', body: { seconds: '9999' }, why: '没有任何一档能出 9999 秒（近三小时）的视频。' },
  { key: 'resolution', body: { resolution: '9999p' }, why: '9999p 不是任何一档的画质档位。' },
  { key: 'ratio', body: { ratio: '9999:1' }, why: '9999:1 不是任何一档的画幅。' },
  { key: 'seed', body: { seed: -999999999999 }, why: '超出任何一档的种子取值区间。' },
];

// 只在异步轮询回调里用，不参与渲染；放在模块作用域避免被当成渲染期副作用。
// 任务 ID 必须落盘：面板是按页签挂载的，切到「新故事」再回来组件就重挂了，
// 只存在组件 state 里的任务会连同已经付过钱的结果一起消失。
const taskStoreKey = (projectId: string) => `mirror:video-tasks:${projectId}`;
function loadTaskIds(projectId: string): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(taskStoreKey(projectId)) || '{}'); } catch { return {}; }
}
function rememberTaskId(projectId: string, runId: string, taskId: string) {
  const all = { ...loadTaskIds(projectId), [runId]: taskId };
  try { localStorage.setItem(taskStoreKey(projectId), JSON.stringify(all)); } catch { /* 存不下也不该挡住流程 */ }
}

// 提交时的指纹与时长方案也要落盘：任务跑完才存视频，那时提示词可能已经改过，得用提交那一刻的。
type TaskMeta = CurrentFingerprint & { taskId: string; model: string; seconds?: number; billedSeconds?: number; padded: number };
const taskMetaKey = (projectId: string) => `mirror:video-task-meta:${projectId}`;
function loadTaskMeta(projectId: string): Record<string, TaskMeta> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(taskMetaKey(projectId)) || '{}'); } catch { return {}; }
}
function rememberTaskMeta(projectId: string, runId: string, meta: TaskMeta) {
  try { localStorage.setItem(taskMetaKey(projectId), JSON.stringify({ ...loadTaskMeta(projectId), [runId]: meta })); } catch { /* 存不下也不该挡住流程 */ }
}

// 参数按模型分别记住：换档时上一档的设置不该跟过来（各档认的字段本来就不同）。
const paramStoreKey = 'mirror:video-params';
function loadParams(modelId: string): Record<string, ParamValue> {
  if (typeof window === 'undefined') return {};
  try { return (JSON.parse(localStorage.getItem(paramStoreKey) || '{}') as Record<string, Record<string, ParamValue>>)[modelId] ?? {}; } catch { return {}; }
}
function saveParams(modelId: string, values: Record<string, ParamValue>) {
  try {
    const all = JSON.parse(localStorage.getItem(paramStoreKey) || '{}');
    localStorage.setItem(paramStoreKey, JSON.stringify({ ...all, [modelId]: values }));
  } catch { /* 存不下不该挡住流程 */ }
}

const startClock = () => Date.now();
const secondsSince = (startedAt: number) => Math.round((Date.now() - startedAt) / 1000);

/**
 * 参考图长边档位。1280px 对锁形象够用，且请求体最小；上游对整体请求体有大小与超时限制，
 * 四个角色的图是叠加的，所以这不是「越高越好」——高清档要用户自己权衡。
 */
export const REFERENCE_SIZES = [
  { id: 'compact', label: '1280px · 推荐', maxSide: 1280, quality: 0.85, hint: '锁形象足够，请求体最小，最不容易超时' },
  { id: 'sharp', label: '1920px · 高清', maxSide: 1920, quality: 0.9, hint: '细节更清楚，请求体约翻倍，角色多时可能超时' },
  { id: 'original', label: '原图不压缩', maxSide: Infinity, quality: 1, hint: '原样上传。四张 1.8MB 的 PNG 编码后接近 10MB，实测会撞上游 100 秒上限拿到 524' },
] as const;
export type ReferenceSizeId = typeof REFERENCE_SIZES[number]['id'];
const REFERENCE_SIZE_KEY = 'mirror:reference-size';

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('角色图转 data URI 失败。'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 本机 /api/assets 链接上游访问不到，必须转 data URI；但原图是 1.8 MB 的 PNG，
 * base64 还要再涨三分之一，四个角色就接近 10 MB —— 这么大的请求体经中转再转发给上游，
 * 会直接撞上 Cloudflare 的 100 秒上限拿到 HTTP 524。所以先按长边缩放并转 JPEG 再编码。
 */
async function toDataUri(uri: string, sizeId: ReferenceSizeId = 'compact'): Promise<string> {
  if (uri.startsWith('data:')) return uri;
  if (isSubmittableImage(uri)) return uri;
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`读取角色图失败：${uri}`);
  const blob = await response.blob();
  const preset = REFERENCE_SIZES.find((item) => item.id === sizeId) ?? REFERENCE_SIZES[0];
  if (preset.maxSide === Infinity) return await blobToDataUri(blob);
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, preset.maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const shrunk = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', preset.quality));
    // 压完反而更大就用原图（小图或已经是 JPEG 时可能出现）。
    if (shrunk && shrunk.size < blob.size) return await blobToDataUri(shrunk);
  } catch { /* 浏览器不支持就退回原图，宁可慢也别丢图 */ }
  return await blobToDataUri(blob);
}

export function VideoTargetPanel({ pack, referenceAssets, projectId, videoModelId, onVideoModelChange, preserve = false, analysis, previsStale = false, onGoPrevis }: { pack: CreativePack; referenceAssets: ReferenceAsset[]; projectId: string; videoModelId: string; onVideoModelChange: (id: string) => void; preserve?: boolean; analysis?: VideoDnaAnalysis; previsStale?: boolean; onGoPrevis?: () => void }) {
  const editKey = `mirror:output-prompts:${projectId}`;
  const [edits, setEdits] = useState<Record<string, PromptEdit>>(() => {
    try { return typeof window === 'undefined' ? {} : JSON.parse(localStorage.getItem(editKey) || '{}'); } catch { return {}; }
  });
  const changePrompt = (run: SeedanceRun, text: string) => {
    const next = { ...edits, [run.run_id]: { original: run.target_prompt, text } };
    setEdits(next);
    try { localStorage.setItem(editKey, JSON.stringify(next)); } catch { setError('提示词已编辑，但本机保存失败，请下载保留。'); }
  };
  // 预演来源：浏览器版（本页渲染）优先；没有时再找本机 Blender 助手的旧任务。
  const [previs, setPrevis] = useState<{ ticket?: { id: string; token: string }; film?: Film; shots: OutputShot[]; version?: string } | null>(null);
  const [previsNotice, setPrevisNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    if (!preserve) return;
    const restore = async () => {
      const account = currentAccountId();
      const run = account ? await loadRun(account, projectId).catch(() => undefined) : undefined;
      if (run && (run.status === 'ready' || run.status === 'needs_review')) {
        const film = await loadFilm(run).catch(() => null);
        if (film) { if (!controller.signal.aborted) setPrevis({ film, shots: run.shots, version: `browser:${run.dnaHash}:${run.updatedAt}` }); return; }
      }
      try {
        const ticket = JSON.parse(localStorage.getItem(`mirror:auto-previs:${projectId}`) || 'null');
        if (!ticket?.id || !ticket?.token) return;
        const response = await fetch(`http://127.0.0.1:43128/jobs/${ticket.id}/shots`, { headers: { Authorization: `Bearer ${ticket.token}` }, signal: controller.signal });
        if (!response.ok) throw new Error('暂时无法读取分镜 3D，请确认预演已完成、本地服务已启动。');
        const result = await response.json() as { shots: OutputShot[] };
        if (!controller.signal.aborted) setPrevis({ ticket, shots: result.shots });
      } catch { if (!controller.signal.aborted) setPrevisNotice('暂时无法读取分镜 3D，请确认预演已完成、本地服务已启动。'); }
    };
    void restore();
    return () => controller.abort();
  }, [projectId, preserve]);
  // 本段对应的 3D 预演：浏览器版给 clipRange（本页现场导出），Blender 助手版给本机下载地址 clip。
  const previsMatch = (run: SeedanceRun) => {
    const shot = matchingPrevisShot(run, previs?.shots ?? [], preserve);
    const filmShot = shot && previs?.film ? previs.film.shots[shot.index] : undefined;
    const clipRange = filmShot ? (Math.abs(run.source_start_seconds - filmShot.start) > .01 || Math.abs(run.source_end_seconds - filmShot.end) > .01 ? { shot: filmShot, from: +(run.source_start_seconds - filmShot.start).toFixed(3), to: +(run.source_end_seconds - filmShot.start).toFixed(3) } : { shot: filmShot }) : undefined;
    const helperRange = shot && (Math.abs(run.source_start_seconds - shot.start) > .01 || Math.abs(run.source_end_seconds - shot.end) > .01) ? { from: +(run.source_start_seconds - shot.start).toFixed(3), to: +(run.source_end_seconds - shot.start).toFixed(3) } : undefined;
    const clip = shot && previs?.ticket ? `http://127.0.0.1:43128/jobs/${previs.ticket.id}/shot-${shot.index}?token=${encodeURIComponent(previs.ticket.token)}${helperRange ? `&from=${helperRange.from}&to=${helperRange.to}` : ''}` : '';
    return { shot, clipRange, clip, helperRange };
  };
  /**
   * 能当参考视频发出去的本段 3D 预演。只有全能档（seedance-2.5）收参考视频；绝不发原视频。
   * identity 只由预演版本 + 镜头 + 区间组成，进请求指纹和任务缓存键；临时链接每次上传都会变，不进。
   * 这里不管用户开关；真正要不要带看 previsSourceFor。
   */
  const previsClipSource = (run: SeedanceRun) => {
    if (model?.referenceStyle !== 'omni') return undefined;
    const { shot, clipRange, clip, helperRange } = previsMatch(run);
    if (!shot) return undefined;
    if (clipRange && previs?.film) {
      const film = previs.film;
      return {
        identity: `${previs.version ?? 'browser'}:shot-${shot.index}:${clipRange.from ?? ''}-${clipRange.to ?? ''}`,
        seconds: (clipRange.to ?? clipRange.shot.end - clipRange.shot.start) - (clipRange.from ?? 0),
        produce: async () => {
          const { exportFilm } = await import('../lib/previs/export');
          const result = await exportFilm(film, [clipRange]);
          if (result.extension !== 'mp4') throw new Error('这个浏览器只能导出 WebM，上游参考视频是否收 WebM 文档没写');
          return result.blob;
        },
      };
    }
    if (clip && previs?.ticket) {
      return {
        identity: `helper:${previs.ticket.id}:shot-${shot.index}:${helperRange?.from ?? ''}-${helperRange?.to ?? ''}`,
        seconds: (helperRange?.to ?? shot.end - shot.start) - (helperRange?.from ?? 0),
        produce: async () => {
          const response = await fetch(`${clip}&download=1`);
          if (!response.ok) throw new Error('本机预演助手没返回这一段 3D，请确认助手已启动');
          return new Blob([await response.arrayBuffer()], { type: 'video/mp4' });
        },
      };
    }
    return undefined;
  };
  // 这一段能不能带 3D、带不带：只有「能带且开着」才真的带；指纹、缓存键、提示词都跟着它走。
  const attachFor = (run: SeedanceRun): PrevisAttachState => resolvePrevisAttach({
    omni: model?.referenceStyle === 'omni', preserve, previsReady: Boolean(previs), stale: Boolean(previsStale && previs?.film),
    matched: Boolean(previsClipSource(run)), exportFormat: previs?.film ? exportFormat : undefined, choice: attachChoices[run.run_id],
  });
  const previsSourceFor = (run: SeedanceRun) => attachFor(run).on ? previsClipSource(run) : undefined;
  // 导出本段 3D → 上传成上游能抓取的签名临时链接。失败就如实返回原因，由确认框告诉用户这次没带 3D。
  const uploadPrevis = async (source: NonNullable<ReturnType<typeof previsSourceFor>>): Promise<{ identity: string; url: string } | { reason: string }> => {
    if (typeof location === 'undefined' || location.protocol !== 'https:') return { reason: '当前页面不是公网 https 地址（本机开发），上游抓不到临时链接' };
    try {
      const blob = await source.produce();
      const response = await accountFetch('/api/reference-media', { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: blob });
      const result = await response.json().catch(() => ({})) as { url?: string; error?: string };
      if (!response.ok || !result.url) return { reason: result.error ?? `上传失败（HTTP ${response.status}）` };
      return { identity: source.identity, url: result.url };
    } catch (cause) {
      return { reason: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  // 上传失败不静默丢掉 3D：三选一——重试 / 不带 3D 继续 / 取消（什么都不做）。返回 null = 取消。
  // 提交和复制/下载请求体都走这里，所以带 3D 时两边的请求体是同一份。
  const uploadPrevisOrAsk = async (source: NonNullable<ReturnType<typeof previsSourceFor>>, mode: 'submit' | 'copy' | 'download'): Promise<{ ref: { identity: string; url: string } } | { reason: string } | null> => {
    const verb = mode === 'submit' ? '继续' : mode === 'copy' ? '复制' : '下载';
    for (;;) {
      const uploaded = await uploadPrevis(source);
      if ('url' in uploaded) return { ref: uploaded };
      const picked = await confirmChoice({
        title: `3D 预演上传失败：${uploaded.reason}`,
        message: [
          '重试：再导出并上传一次本段 3D，这一步不扣费。',
          mode === 'submit'
            ? '不带 3D 继续：这一段只按文字分镜提交；下一步仍会显示费用让你确认。'
            : `不带 3D ${verb}：${verb}不含参考视频的请求体（和关掉开关时一样）。`,
          mode === 'submit' ? '取消提交：这次什么都不提交。' : `取消：这次不${verb}。`,
        ].join('\n'),
        actions: [
          { id: 'cancel', label: mode === 'submit' ? '取消提交' : '取消' },
          { id: 'skip', label: `不带 3D ${verb}` },
          { id: 'retry', label: '重试' },
        ],
        cancelId: 'cancel',
      });
      if (picked === 'skip') return { reason: uploaded.reason };
      if (picked !== 'retry') return null;
    }
  };
  const copyPrompt = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setError(''); } catch { setError('复制失败，请下载提示词。'); }
  };
  const downloadRoles = async (run: SeedanceRun) => {
    setBusy(`roles:${run.run_id}`); setError('');
    try {
      const files: Record<string, Uint8Array> = {};
      for (const binding of castOf(run)) {
        const asset = referenceAssets.find(item => item.asset_id === binding.asset_id && !item.retired);
        if (!asset) throw new Error(`找不到 ${binding.character_id} 的角色图。`);
        const response = await fetch(asset.uri);
        if (!response.ok) throw new Error(`读取 ${binding.character_id} 的角色图失败。`);
        const ext = asset.mime_type === 'image/jpeg' ? 'jpg' : asset.mime_type === 'image/webp' ? 'webp' : 'png';
        files[`${binding.character_id}.${ext}`] = new Uint8Array(await response.arrayBuffer());
      }
      const url = URL.createObjectURL(new Blob([new Uint8Array(zipSync(files, { level: 0 }))], { type: 'application/zip' }));
      const link = document.createElement('a'); link.href = url; link.download = `${run.run_id}-角色图.zip`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  // 参考图清晰度记在本机：它是设备/线路相关的偏好（会不会超时看你的网络），不该跟着项目走。
  const [referenceSize, setReferenceSize] = useState<ReferenceSizeId>(() => {
    if (typeof window === 'undefined') return 'compact';
    const stored = localStorage.getItem(REFERENCE_SIZE_KEY);
    return REFERENCE_SIZES.some((item) => item.id === stored) ? stored as ReferenceSizeId : 'compact';
  });
  const changeReferenceSize = (id: ReferenceSizeId) => { setReferenceSize(id); try { localStorage.setItem(REFERENCE_SIZE_KEY, id); } catch { /* 无痕模式下存不了，本次仍然生效 */ } };
  // 由 StudioApp 下发：面板自己读 localStorage 只会读到挂载那一刻的值，改了设置不会更新。
  const modelId = videoModelId;
  const [paramsByModel, setParamsByModel] = useState<Record<string, Record<string, ParamValue>>>(() => ({ [videoModelId]: loadParams(videoModelId) }));
  const params = paramsByModel[videoModelId] ?? loadParams(videoModelId);
  const setParam = (key: string, value: ParamValue) => {
    const next = { ...params, [key]: value };
    setParamsByModel((old) => ({ ...old, [videoModelId]: next }));
    saveParams(videoModelId, next);
  };
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [tasks, setTasks] = useState<Record<string, VideoTaskState & { taskId: string; elapsed?: number }>>(
    // 重挂时先把落盘的任务读回来，别让人以为钱白花了。
    () => Object.fromEntries(Object.entries(loadTaskIds(projectId)).map(([runId, taskId]) => [runId, { taskId, status: 'in_progress' }])),
  );
  const [resumed, setResumed] = useState(false);

  const model = useMemo(() => (modelId ? videoModel(modelId) : null), [modelId]);
  // 分辨率现在只是参数表里的一项；没设过就用这一档的默认值。
  const chosen = params.resolution as VideoResolution | undefined;
  const resolution: VideoResolution | '' = chosen && model?.resolutions.includes(chosen) ? chosen : model?.defaultResolution ?? '';

  // 本机探测出来的参数事实：把能力表里"据文档"的项升级成"实测"，并带上上游原话。
  // 和参数一样按模型分别记，换档时不能把上一档的结论带过来。
  const [probesByModel, setProbesByModel] = useState<Record<string, Record<string, ParamProbe>>>(
    () => ({ [videoModelId]: loadParamProbes(videoModelId) as Record<string, ParamProbe> }),
  );
  const probes = probesByModel[videoModelId] ?? (loadParamProbes(videoModelId) as Record<string, ParamProbe>);
  const [probeLog, setProbeLog] = useState('');
  const specs = model ? videoParamSpecs(model, probes) : [];

  // 手填时长对所有段一视同仁；留空就还是按每段分镜自己的时长推导（默认行为）。
  const manualSeconds = (() => {
    const raw = params.seconds;
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  })();
  const planFor = (activeModel: VideoModelCapability, wanted: number) =>
    applySecondsOverride(activeModel, resolveSeconds(activeModel, wanted), manualSeconds, wanted);

  const map = pack.seedance_asset_map;
  const runs: SeedanceRun[] = map?.runs ?? [];
  const bindings = (map?.bindings ?? []).filter((binding) => binding.kind === 'character_reference');

  // 这一段出场的角色，顺序就是参考图数组的顺序。
  const castOf = (run: SeedanceRun) => {
    const inRun = new Set(run.beat_ids);
    const used = new Set(pack.beats.filter((beat) => inRun.has(beat.beat_id)).flatMap((beat) => [...beat.character_ids, ...(beat.dialogue_speaker_ids ?? [])]));
    return bindings.filter((binding) => binding.character_id && used.has(binding.character_id));
  };
  const promptFor = (run: SeedanceRun) => {
    const castIds = new Set(castOf(run).map(binding => binding.character_id));
    return withVoiceRoles(compactCreativePrompt(editedRun(run, edits[run.run_id]).target_prompt), (pack.character_bible ?? []).filter(character => castIds.has(character.character_id)), voiceSpeakers(pack.beats.filter(beat => run.beat_ids.includes(beat.beat_id))));
  };

  // 只有 seedance-2.0 两档认 shots：把本段的镜头逐条写成分镜表，模型就不用自己猜在哪切、每镜停多久。
  // 有逐拍动作时按拍切而不是按镜切——一个 15 秒固定机位里往往有四五个回合，按镜切等于把它们压成一句。
  const shotsFor = (run: SeedanceRun) => {
    if (edits[run.run_id]?.original === run.target_prompt && edits[run.run_id].text !== run.target_prompt) return undefined;
    if (!model?.supportsShots || model.fixedSeconds === undefined) return undefined;
    const inRun = new Set(run.beat_ids);
    const { segments, byActionBeat } = beatShotSegments(pack.beats.filter((beat) => inRun.has(beat.beat_id)));
    if (segments.length < 2) return undefined;
    const shots = buildShots(segments, model.fixedSeconds);
    return shots && { ...shots, byActionBeat };
  };

  // previsRef 有值 = 这次带本段 3D 预演：提示词改说"参考视频管走位运镜"；url 有值才真的放进 videos。
  // 只给 identity 不给 url 用于算缓存键（找回上次带 3D 提交的任务），不会上传任何东西。
  const buildRequest = async (run: SeedanceRun, previsRef?: { identity: string; url?: string }) => {
    if (!model) throw new Error('请先在「中转 API 设置」的④视频生成里选一个模型。');
    const cast = castOf(run);
    const images: string[] = [];
    for (const binding of cast.slice(0, model.maxReferenceImages)) {
      const asset = referenceAssets.find((item) => item.asset_id === binding.asset_id && !item.retired);
      if (!asset) throw new Error(`找不到 ${binding.character_id} 的参考图，无法提交。`);
      images.push(await toDataUri(asset.uri, referenceSize));
    }
    const plan = planFor(model, run.duration_seconds);
    if (plan.blocked) throw new Error(plan.blocked);
    const prompt = toApiPrompt(promptFor(run), cast.map(binding => binding.character_id ?? ''), model, { referenceVideo: Boolean(previsRef) });
    if (!prompt.trim() || !editedRun(run, edits[run.run_id]).target_prompt.trim()) throw new Error('提示词不能为空。');
    if (prompt.length > CREATIVE_PROMPT_LIMIT) throw new Error('提示词超过 4,000 字符，请精简后提交。');
    return buildVideoRequest(model, {
      model: model.id,
      seconds: plan.seconds,
      resolution: resolution || undefined,
      prompt,
      referenceImages: images,
      referenceVideos: previsRef?.url ? [previsRef.url] : undefined,
      shots: shotsFor(run)?.shots,
    }, params);
  };

  const [payloadKb, setPayloadKb] = useState<Record<string, number>>({});

  // ---- 生成段落存到本机 + 是否过期（后期包装与"只重算改动层"用）----
  const [stored, setStored] = useState<Record<string, SegmentRecord>>({});
  const [keeping, setKeeping] = useState<Record<string, string>>({});
  const [fingerprints, setFingerprints] = useState<Record<string, CurrentFingerprint>>({});
  // 每段「附带 3D 预演参考」开关（按项目记在本机），以及这台浏览器导出预演的格式（只能出 WebM 时不带）。
  const [attachChoices, setAttachChoices] = useState<Record<string, boolean>>(() => loadPrevisAttach(projectId));
  const [exportFormat, setExportFormat] = useState<'mp4' | 'webm' | undefined>(undefined);
  const setAttach = (runIds: string[], on: boolean) => {
    const next = { ...attachChoices, ...Object.fromEntries(runIds.map(runId => [runId, on])) };
    setAttachChoices(next); savePrevisAttach(projectId, next);
  };
  // 不含角色图内容的请求体：角色图用 asset ID 代表。和 buildRequest 同一套拼法，只是不读图。
  // previsIdentity 不传 = 按"能带 3D 就带"估算；传空串 = 这次确定没带 3D。
  const requestShape = (run: SeedanceRun, previsIdentity: string = previsSourceFor(run)?.identity ?? '') => {
    if (!model) return undefined;
    const cast = castOf(run);
    const plan = planFor(model, run.duration_seconds);
    if (plan.blocked) return undefined;
    const prompt = toApiPrompt(promptFor(run), cast.map(binding => binding.character_id ?? ''), model, { referenceVideo: Boolean(previsIdentity) });
    if (!prompt.trim()) return undefined;
    const body = buildVideoRequest(model, { model: model.id, seconds: plan.seconds, resolution: resolution || undefined, prompt, referenceImages: [], shots: shotsFor(run)?.shots }, params);
    const promptBasis = toApiPrompt(promptFor(run), cast.map(binding => binding.character_id ?? ''), model);
    return { body, assets: cast.slice(0, model.maxReferenceImages).map(binding => binding.asset_id ?? ''), plan, previs: previsIdentity || undefined, promptBasis };
  };
  const fingerprintSource = stableJson(runs.map(run => { const shape = requestShape(run); return shape ? { runId: run.run_id, body: shape.body, assets: shape.assets, previs: shape.previs, promptBasis: shape.promptBasis } : { runId: run.run_id }; }));
  useEffect(() => {
    let cancelled = false;
    const items = JSON.parse(fingerprintSource) as Array<{ runId: string; body?: Record<string, unknown>; assets?: string[]; previs?: string; promptBasis?: string }>;
    void Promise.all(items.map(async item => [item.runId, item.body ? await requestFingerprint(item.body, item.assets ?? [], item.previs, item.promptBasis) : undefined] as const))
      .then(pairs => { if (!cancelled) setFingerprints(Object.fromEntries(pairs.filter(([, value]) => value)) as Record<string, CurrentFingerprint>); });
    return () => { cancelled = true; };
  }, [fingerprintSource]);
  useEffect(() => {
    let cancelled = false;
    const reload = () => { void latestSegments(projectId).then(found => { if (!cancelled) setStored(found); }).catch(() => {}); };
    reload();
    const onChange = (event: Event) => { if ((event as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) reload(); };
    window.addEventListener(SEGMENTS_CHANGED, onChange);
    return () => { cancelled = true; window.removeEventListener(SEGMENTS_CHANGED, onChange); };
  }, [projectId]);
  // 提前探一下这台浏览器导出预演会是 MP4 还是 WebM：只能出 WebM 就别默认带，免得提交时才失败。
  const filmSize = previs?.film ? `${previs.film.width}x${previs.film.height}` : '';
  useEffect(() => {
    if (!filmSize) return;
    let cancelled = false;
    const [width, height] = filmSize.split('x').map(Number);
    void import('../lib/previs/export').then(({ exportExtension }) => exportExtension(width, height)).then(format => { if (!cancelled) setExportFormat(format); }).catch(() => {});
    return () => { cancelled = true; };
  }, [filmSize]);
  // 复制/下载请求体后在本段旁边说一句：带没带 3D、链接多久失效。新 hook 只能往后加（测试按顺序取状态）。
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});

  // 任务出片后把视频取回存到本机。取回不计费；同一个任务存过就不再取。
  const keepSegment = async (runId: string, taskId: string, videoUrl: string) => {
    const run = runs.find(item => item.run_id === runId);
    if (!run) return;
    try {
      if ((await listSegments(projectId)).some(record => record.runId === runId && record.taskId === taskId)) return;
      setKeeping(old => ({ ...old, [runId]: 'saving' }));
      const blob = await fetchSegmentVideo(videoUrl);
      const durationSeconds = await measureBlob(blob);
      const meta = loadTaskMeta(projectId)[runId];
      const known = meta?.taskId === taskId ? meta : undefined;
      await saveSegment(projectId, {
        runId, beatIds: run.beat_ids, sourceStart: run.source_start_seconds, sourceEnd: run.source_end_seconds, plannedSeconds: run.duration_seconds,
        requestHash: known?.requestHash ?? '', promptHash: known?.promptHash ?? '', model: known?.model ?? '',
        seconds: known?.seconds, billedSeconds: known?.billedSeconds, padded: known?.padded ?? 0,
        taskId, origin: 'relay', durationSeconds, createdAt: Date.now(),
      }, blob);
      setKeeping(old => ({ ...old, [runId]: 'saved' }));
    } catch (cause) {
      setKeeping(old => ({ ...old, [runId]: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const rememberSubmitMeta = (run: SeedanceRun, taskId: string, previsIdentity: string) => {
    const shape = requestShape(run, previsIdentity);
    if (!shape || !model) return;
    void requestFingerprint(shape.body, shape.assets, shape.previs, shape.promptBasis).then(fp => rememberTaskMeta(projectId, run.run_id, { ...fp, taskId, model: model.id, seconds: shape.plan.seconds, billedSeconds: shape.plan.billedSeconds, padded: shape.plan.padded }));
  };
  // 干跑计数：只读本机存档、不发请求。确认框里的数字只从这里来。
  const callPlan = () => planOutputCalls({
    runs: runs.map(run => ({ runId: run.run_id, plannedSeconds: run.duration_seconds, plan: model ? planFor(model, run.duration_seconds) : undefined, current: fingerprints[run.run_id] })),
    segments: stored,
    pending: Object.entries(tasks).filter(([runId, task]) => task.status !== 'failed' && (task.status !== 'completed' || !stored[runId])).map(([runId]) => runId),
    model,
    resolution: resolution || undefined,
  });
  // 复制/下载请求体跟着本段开关走：开着且能带时，和提交一样现场导出上传（只上传，不调模型），请求体与提交时同一份。
  const withRequest = async (run: SeedanceRun, id: string, mode: 'copy' | 'download', consume: (text: string) => void | Promise<void>) => {
    setBusy(id); setError('');
    try {
      const source = previsSourceFor(run);
      let previsRef: { identity: string; url: string } | undefined;
      let note = '';
      if (source) {
        const result = await uploadPrevisOrAsk(source, mode);
        if (!result) return;
        if ('ref' in result) { previsRef = result.ref; note = '已带本段 3D 预演 · 3D 链接 6 小时内有效'; }
        else note = `这份没带 3D（上传失败：${result.reason}）`;
      }
      await consume(JSON.stringify(await buildRequest(run, previsRef), null, 2));
      setRequestNotes(old => ({ ...old, [id]: note }));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };

  const setTask = (id: string, patch: Partial<VideoTaskState & { taskId: string; elapsed?: number }>) =>
    setTasks((old) => {
      const base = old[id] ?? { taskId: '', status: 'queued' };
      return { ...old, [id]: { ...base, ...patch } };
    });

  // 轮询不计费，可以放心重试；只要 task_id 还在就一直跟到出结果。
  // 提交后立刻查一次，别让人对着一个没有任何反馈的界面干等 15 秒。
  const track = async (id: string, taskId: string) => {
    const startedAt = startClock();
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 15000));
      let state: VideoTaskState;
      try { state = await pollRelayVideo(taskId); }
      catch (cause) {
        setTask(id, { error: cause instanceof Error ? cause.message : String(cause), elapsed: secondsSince(startedAt) });
        continue;
      }
      setTask(id, { ...state, taskId, error: undefined, elapsed: secondsSince(startedAt) });
      if (state.status === 'completed' && state.videoUrl) void keepSegment(id, taskId, state.videoUrl);
      if (state.status === 'completed' || state.status === 'failed') return;
    }
    setTask(id, { error: '轮询超过一小时仍未完成，任务可能仍在跑。稍后用「找回上次任务」接着查，不要重新提交。' });
  };

  const submit = async (run: SeedanceRun, id: string) => {
    if (busy) return;
    setBusy(id); setError('');
    try {
      // 本段 3D 预演：先看带 3D 的这份是不是已经提交过（只算键，不上传）；没有才导出并上传成临时链接。
      // 导出或上传失败不静默丢掉——确认框里明说"这次没带 3D"和原因，让人自己决定还提不提。
      const attach = attachFor(run);
      const source = previsSourceFor(run);
      let previsRef: { identity: string; url?: string } | undefined;
      let previsLine = attach.attachable ? '未附带 3D 预演（你已关闭）。' : `未附带 3D 预演（${attach.reason}）。`;
      if (source) {
        const tentative = { identity: source.identity };
        const tentativeKey = await videoCacheKey(projectId, id, await buildRequest(run, tentative), source.identity);
        if (await recoverRelayVideoTask(tentativeKey)) previsRef = tentative;
        else {
          // 开着却没传上去：不静默改成不带。重试 / 不带 3D 继续（仍要过下面的付费确认）/ 取消提交（什么都不提交）。
          const result = await uploadPrevisOrAsk(source, 'submit');
          if (!result) return;
          if ('ref' in result) previsRef = result.ref;
          else previsLine = `未附带 3D 预演（上传失败：${result.reason}）。`;
        }
        if (previsRef) previsLine = `3D 预演只管走位、构图与运镜，角色外观仍以角色图为准${source.seconds < 4 ? '；这段短于文档建议的 4 秒' : ''}；临时链接 6 小时后失效。`;
      }
      const body = await buildRequest(run, previsRef);
      const key = await videoCacheKey(projectId, id, body, previsRef?.identity);
      const known = await recoverRelayVideoTask(key);
      const plan = model ? planFor(model, run.duration_seconds) : undefined;
      const credits = model && plan && !plan.blocked ? estimateCredits(model, plan.billedSeconds, resolution || undefined) : undefined;
      const overall = callPlan();
      const mine = overall.runs.find(item => item.runId === id);
      const labelOf = (runId: string) => { const index = runs.findIndex(item => item.run_id === runId); return index < 0 ? runId : `分镜 ${String(index + 1).padStart(2, '0')}（${runId}）`; };
      if (!known && !await confirmAction({
        title: mine?.status === 'reuse' ? `${id} 已有同样提示词的视频，确定再生成一次？` : `提交 ${id} 生成视频`,
        message: [
          `目标模型：${model?.label ?? model?.id}`,
          `本段时长：${run.duration_seconds} 秒`,
          `携带素材：${castOf(run).slice(0, model?.maxReferenceImages ?? 0).length} 张角色图${previsRef ? ` + 1 段 3D 预演（${source?.seconds.toFixed(1)} 秒）` : ''}＋当前编辑后的提示词。`,
          previsLine,
          '不附带原视频。',
          ...(manualSeconds !== undefined && model?.fixedSeconds === undefined
            ? [`⚠️ 你在参数表里把时长手动固定为 ${manualSeconds} 秒，本段会按 ${manualSeconds} 秒提交并计费，画面节奏和分镜对不上。`] : []),
          ...(credits !== undefined ? [`预计消耗：约 ${credits.toFixed(2)} 积分`] : ['预计消耗：这一档价格未知']),
          ...(mine?.status === 'reuse' ? ['⚠️ 本机已存着这一段、提示词和参数都没变的视频。再提交会重复扣费，包装导出用现有的就行。'] : []),
          ...(mine?.status === 'stale' ? [`这一段本机已有旧视频，但${mine.freshness === 'stale-params' ? '模型或参数' : '提示词'}变了；重新生成会再扣一次费。旧视频保留，在新视频出来前仍可用于包装。`] : []),
          '',
          ...describeCallPlan(overall, labelOf),
          '',
          '提交是唯一的扣费点，之后查进度、下载成片、包装导出都不再计费。',
        ].join('\n'),
        confirmLabel: '确认提交',
        cancelLabel: '再看看',
        danger: true,
      })) return;
      // 请求体大小要让人看得见：角色图是随请求一起上传的，过大就会撞上游超时。
      setPayloadKb((old) => ({ ...old, [id]: Math.round(new Blob([JSON.stringify(body)]).size / 1024) }));
      const taskId = await submitRelayVideo(body, key);
      rememberModelStatus(model!.id, 'ok', '这一档提交成功过。', startClock());
      rememberTaskId(projectId, id, taskId);
      rememberSubmitMeta(run, taskId, previsRef?.identity ?? '');
      setTask(id, { taskId, status: known ? 'in_progress' : 'queued', error: known ? '这份内容之前已经提交过，直接接着上次的任务，没有重复扣费。' : undefined });
      void track(id, taskId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // 把这一档的实测结论记在本机：/v1/models 会列出分组里根本跑不了的模型，试过才知道。
      const probe = model ? probeFromError(message) : undefined;
      if (probe && model) rememberModelStatus(model.id, probe.state, probe.note, startClock());
      setError(message);
    }
    finally { setBusy(''); }
  };

  /**
   * 探测这一档的真实限制。
   *
   * 起因是能力表里绝大多数数字都是照中转文档抄的，没有一条是本机试出来的——
   * 界面上它们和实测过的项长得一模一样，用户没法分辨哪些靠谱。这个按钮就是把它们逐条试真。
   * 手法：prompt 传空串（没有内容就不可能生成，任何上游都会先拦下），再搭一个越界值换一句带范围的报错。
   * 报错里提到了那个字段，才算证实；只提到 prompt 说明根本没走到那一步，就老实保持「据文档」。
   */
  const probeLimits = async () => {
    if (busy) return;
    if (!model) return;
    const before = await relayUsage().catch(() => null);
    if (!await confirmAction({
      title: `探测 ${model.id} 的真实参数限制`,
      message: [
        `会连发 ${PROBE_VALUES.length} 个请求，每个都是 prompt 为空 + 一个越界值：`,
        ...PROBE_VALUES.map((item) => `· ${item.key} = ${JSON.stringify(Object.values(item.body)[0])} —— ${item.why}`),
        '',
        '空提示词没有可生成的内容，上游只会拒绝，不会建任务，也就不会扣费。',
        before?.totalUsage != null ? `探测前中转累计用量：${before.totalUsage}（结束后会再读一次给你对账）` : '读不到中转累计用量，无法给出扣费对账，请自行到使用日志核对。',
      ].join('\n'),
      confirmLabel: '开始探测',
      cancelLabel: '算了',
    })) return;

    setBusy('probe'); setError('');
    const lines: string[] = [`模型 ${model.id} · 探测开始`];
    setProbeLog(lines.join('\n'));
    const found: Record<string, ParamProbe> = { ...probes };
    for (const item of PROBE_VALUES) {
      const outcome = await probeVideoParam(item.body);
      if (!outcome.rejected) {
        // 没被拒是意外：宁可把话说重，也不能让人以为"探测一定免费"。
        lines.push(`[${item.key}] ⚠️ 上游没有拒绝，返回了内容。任务可能已建立并计费，请立刻到中转使用日志核对：${outcome.message}`);
        setProbeLog(lines.join('\n'));
        break;
      }
      const verdict = probeVerdict(item.key, outcome.message, startClock());
      if (verdict) {
        found[item.key] = verdict;
        rememberParamProbe(outcome.model, item.key, verdict);
        lines.push(`[${item.key}] ✅ 上游提到了这个字段，已记为实测：${verdict.note}`);
      } else {
        lines.push(`[${item.key}] ➖ 上游的报错没提这个字段（多半先拦了 prompt），探不到，保持「据文档」：${outcome.message.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      setProbeLog(lines.join('\n'));
    }
    setProbesByModel((old) => ({ ...old, [videoModelId]: found }));
    const after = await relayUsage().catch(() => null);
    if (before?.totalUsage != null && after?.totalUsage != null) {
      const delta = after.totalUsage - before.totalUsage;
      lines.push(delta === 0
        ? `对账：中转累计用量 ${before.totalUsage} → ${after.totalUsage}，这次探测没有扣费。`
        : `⚠️ 对账：中转累计用量 ${before.totalUsage} → ${after.totalUsage}，涨了 ${delta}。请到使用日志确认是不是这次探测造成的。`);
    } else {
      lines.push('对账：读不到中转累计用量，无法证明扣没扣费，请自行到使用日志核对。');
    }
    setProbeLog(lines.join('\n'));
    setBusy('');
  };

  // 同一段可能带 3D 提交过，也可能当时没带上：两种缓存键都查一遍（只算键，不上传、不提交）。
  const recoverEitherKey = async (run: SeedanceRun, id: string) => {
    const source = previsClipSource(run);
    const candidates = source ? [source.identity, ''] : [''];
    for (const identity of candidates) {
      const key = await videoCacheKey(projectId, id, await buildRequest(run, identity ? { identity } : undefined), identity || undefined);
      const taskId = await recoverRelayVideoTask(key);
      if (taskId) return { key, taskId, previs: identity };
    }
    return undefined;
  };

  // 页面关过、断过线时用这个把上次的 task_id 捞回来接着轮询，绝不会顺手再提交一次。
  const resume = async (run: SeedanceRun, id: string) => {
    if (busy) return;
    setBusy(id); setError('');
    try {
      const found = await recoverEitherKey(run, id);
      const taskId = found?.taskId;
      if (found?.taskId) { rememberTaskId(projectId, id, found.taskId); rememberSubmitMeta(run, found.taskId, found.previs); }
      if (!taskId) { setError(`${id} 在本机没有已提交的任务记录。如果你确实提交过，请到中转使用日志查任务，不要盲目重提。`); return; }
      setTask(id, { taskId, status: 'in_progress' });
      void track(id, taskId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };

  // 重挂后把落盘的任务重新接上轮询；只做一次，避免重复起循环。
  const resumeStored = () => {
    if (resumed) return;
    setResumed(true);
    for (const [runId, taskId] of Object.entries(loadTaskIds(projectId))) void track(runId, taskId);
  };
  if (!resumed && Object.keys(tasks).length > 0) queueMicrotask(resumeStored);

  // 万一返回结构没解析出任务 ID（钱已经花了），让人把 ID 手填进来继续查，别让结果彻底丢掉。
  const trackManual = (id: string) => {
    const taskId = window.prompt(`输入 ${id} 的任务 ID（可从上面的原始返回里找，或去中转站使用日志复制）：`, '')?.trim();
    if (!taskId) return;
    rememberTaskId(projectId, id, taskId);
    setTask(id, { taskId, status: 'in_progress', error: undefined });
    void track(id, taskId);
  };

  // 提交过但没解析出 ID 时，把中转当时的原始返回原样倒出来。
  const dumpRaw = async (run: SeedanceRun, id: string) => {
    setBusy(id); setError('');
    try {
      const found = await recoverEitherKey(run, id);
      const raw = found ? await rawRelayVideoResult(found.key) : undefined;
      if (raw === undefined) { setError(`${id} 本机没有已完成的提交记录。`); return; }
      downloadText(`${id}-relay-response.json`, JSON.stringify(raw, null, 2), 'application/json');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };

  const rows = runs.map((run, index) => ({ run, id: run.run_id, label: `分镜 ${String(index + 1).padStart(2, '0')}` }));
  // 只统计真能提交的段，且按实际计费秒数算（3.7 秒会按下限 4 秒收费）。
  // 之前把跑不了的段也算进合计、还用原始时长，报出来的数字既偏高又不可能发生。
  const runnable = model ? runs.map((run) => ({ run, plan: planFor(model, run.duration_seconds) })).filter((item) => !item.plan.blocked) : [];
  const totalSegments = model ? runnable.reduce((sum, item) => sum + (estimateCredits(model, item.plan.billedSeconds, resolution || undefined) ?? 0), 0) : 0;
  const blockedCount = runs.length - runnable.length;

  const statuses = loadModelStatus();
  const chip = 'rounded-lg border border-white/12 px-2.5 py-1 text-left text-[11px] text-white/55 transition hover:border-white/25 hover:text-white/80 disabled:opacity-30';

  return <section className="overflow-hidden rounded-2xl border border-emerald-200/20 bg-emerald-300/[0.03]">
    {/* 头部一行说清最重要的三件事：用哪一档、出多大、这一单大概多少积分 */}
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/8 bg-black/20 px-5 py-3.5">
      <span className="text-xs uppercase tracking-wider text-emerald-200/60">视频生成</span>
      <select
        className="min-w-[15rem] rounded-lg border border-white/15 bg-[#07120f] px-2.5 py-1.5 text-sm text-white"
        value={modelId}
        onChange={(event) => onVideoModelChange(event.target.value)}
      >
        {!modelId && <option value="">请在设置中选择视频模型</option>}
        {[...new Set([modelId, ...loadConnection('video').models])].filter(Boolean).map((id) => {
          const badge = PROBE_BADGE[statuses[id]?.state ?? 'unknown'];
          return <option key={id} value={id}>{videoModel(id).label}{badge ? ` ${badge}` : ''}</option>;
        })}
      </select>

      {model && (
        <span className="ml-auto text-sm text-white/70">
          <b className="text-emerald-100">{runnable.length}</b>/{runs.length} 段时长符合
          {blockedCount > 0 && <span className="text-rose-200/80"> · {blockedCount} 段装不下</span>}
          <span className="mx-2 text-white/20">|</span>
          合计约 <b className="text-emerald-100">{totalSegments.toFixed(2)}</b> 积分
          {(() => { const plan = callPlan(); return <span className="text-white/45"> · 还需生成 {plan.toGenerate.length} 段 · 可复用 {plan.reusable} 段</span>; })()}
        </span>
      )}
    </header>

    {/* 参数表单完全由能力表推导：这一档认什么就显示什么，不认的也列出来并说明原因 */}
    {model && (() => {
      const effective = specs
        .filter((spec) => isParamEditable(spec))
        .map((spec) => {
          const value = params[spec.key] ?? spec.fallback;
          if (value === undefined || value === '') return null;
          return `${spec.label} ${spec.kind === 'bool' ? (value ? '开' : '关') : value}`;
        })
        .filter(Boolean);
      const unverified = specs.filter((spec) => spec.source !== 'verified').length;
      return <details className="border-b border-white/8">
        <summary className="cursor-pointer px-5 py-2.5 text-xs text-white/45 hover:text-white/75">
          请求参数（{specs.filter(isParamEditable).length} 项可配置）：{effective.join(' · ') || '全部使用这一档的默认值'}
          {unverified > 0 && <span className="ml-2 text-white/30">· {unverified} 项未实测</span>}
        </summary>
        <div className="grid gap-3 px-5 pb-4 pt-1 sm:grid-cols-2 lg:grid-cols-3">
          {/* 参考图清晰度不是模型参数，是我们自己在提交前做的处理，但它同样影响成片和会不会超时，所以摆在一起。 */}
          <label className="text-xs text-white/65">
            <span className="block">参考图清晰度<span className="ml-1 font-mono text-[10px] text-white/25">本地处理</span></span>
            <select className="mt-1 w-full rounded-lg border border-white/12 bg-[#07120f] px-2 py-1.5 text-xs text-white"
              value={referenceSize} onChange={(event) => changeReferenceSize(event.target.value as ReferenceSizeId)}>
              {REFERENCE_SIZES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <span className="mt-1 block text-[10px] leading-4 text-white/30">{REFERENCE_SIZES.find((item) => item.id === referenceSize)?.hint}</span>
          </label>
          {specs.map((spec) => {
            const editable = isParamEditable(spec);
            const value = params[spec.key] ?? spec.fallback ?? '';
            return <label key={spec.key} className={`text-xs ${editable ? 'text-white/65' : 'text-white/30'}`}>
              <span className="flex items-center gap-1.5">
                <span>{spec.label}</span>
                <span className="font-mono text-[10px] text-white/25">{spec.key}</span>
                {/* 来源标记：这一条到底是试出来的、文档抄的，还是我们推断的 */}
                <span className="ml-auto flex items-center gap-1 text-[10px] text-white/30" title={PARAM_SOURCE_HINT[spec.source]}>
                  <span className={`h-1.5 w-1.5 rounded-full ${SOURCE_DOT[spec.source]}`} />
                  {PARAM_SOURCE_LABEL[spec.source]}
                </span>
              </span>
              {spec.kind === 'enum' && (
                <select className="mt-1 w-full rounded-lg border border-white/12 bg-[#07120f] px-2 py-1.5 text-xs text-white disabled:opacity-40"
                  disabled={!editable} value={String(value)} onChange={(event) => setParam(spec.key, event.target.value)}>
                  {editable && <option value="">不指定（用这一档的默认值）</option>}
                  {(spec.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                  {!editable && <option value="">这一档不认</option>}
                </select>
              )}
              {spec.kind === 'bool' && (
                <span className="mt-1 flex items-center gap-2">
                  <input type="checkbox" disabled={!editable} checked={Boolean(value)} onChange={(event) => setParam(spec.key, event.target.checked)} />
                  <span className="text-[11px] text-white/45">{editable ? (value ? '发送 true' : '发送 false') : '这一档不认，不发送'}</span>
                </span>
              )}
              {(spec.kind === 'int' || spec.kind === 'text') && (
                <input
                  type={spec.kind === 'int' ? 'number' : 'text'}
                  min={spec.min} max={spec.max}
                  className="mt-1 w-full rounded-lg border border-white/12 bg-[#07120f] px-2 py-1.5 text-xs text-white disabled:opacity-40"
                  disabled={!editable}
                  placeholder={editable ? spec.placeholder : '这一档不可填'}
                  value={value === undefined ? '' : String(value)}
                  onChange={(event) => setParam(spec.key, event.target.value)}
                />
              )}
              {spec.hint && <span className="mt-1 block text-[10px] leading-4 text-white/30">{spec.hint}</span>}
              {spec.evidence && <span className="mt-1 block rounded-md border border-emerald-300/20 bg-emerald-300/[0.04] px-2 py-1 text-[10px] leading-4 text-emerald-100/60">上游原话：{spec.evidence}</span>}
            </label>;
          })}
          <div className="flex flex-col justify-end gap-1.5">
            <button
              type="button"
              className="rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white/50 hover:text-white/80"
              onClick={() => { setParamsByModel((old) => ({ ...old, [videoModelId]: {} })); saveParams(videoModelId, {}); }}
            >恢复这一档的默认值</button>
            <button
              type="button"
              className="rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white/50 hover:text-white/80 disabled:opacity-30"
              disabled={busy !== ''}
              onClick={() => void probeLimits()}
            >{busy === 'probe' ? '探测中…' : '探测这一档的真实限制'}</button>
            <span className="text-[10px] leading-4 text-white/30">
              发几个上游必然拒绝的请求（prompt 为空 + 越界值），把报错原话记下来，
              把「据文档」的项升级成「实测」。被拒的请求不建任务、不计费，探测前后会各读一次中转累计用量当凭据。
            </span>
          </div>
        </div>
        {probeLog && <pre className="mx-5 mb-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-black/25 p-3 text-[11px] leading-5 text-white/55">{probeLog}</pre>}
      </details>;
    })()}

    {error && <p role="alert" className="whitespace-pre-wrap border-b border-rose-300/15 bg-rose-400/[0.06] px-5 py-2.5 text-xs leading-5 text-rose-100">{error}</p>}

    {/* 每段一行：左边身份与状态，右边操作。只有「提交生成」是实心的，其余收进「更多」 */}
    {!model && <p className="px-5 py-4 text-sm text-amber-100">可先编辑、复制提示词或下载素材。使用 API 生成前，请在设置中选择视频模型。</p>}
    {previsNotice && <p role="status" className="px-5 py-3 text-sm text-amber-100">{previsNotice}</p>}
    <RoleLeakNotice leaks={pack.role_leaks} className="mx-5 mt-4 rounded-lg" />
    {model && runs.length > 0 && (() => {
      // 全部段落一键开关：只动能带 3D 的段；一段都带不了时说清为什么，能补的给「去做预演」。
      const states = runs.map(run => ({ run, attach: attachFor(run) }));
      const togglable = states.filter(item => item.attach.attachable);
      const onCount = togglable.filter(item => item.attach.on).length;
      const noPrevis = model.referenceStyle === 'omni' && preserve && !previs;
      const firstOff = states.find(item => !item.attach.attachable)?.attach;
      return <div className="mx-5 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/65">
        <span>附带 3D 预演参考 · 全部段落：</span>
        <button type="button" className={chip} disabled={togglable.length === 0} onClick={() => setAttach(togglable.map(item => item.run.run_id), true)}>开</button>
        <button type="button" className={chip} disabled={togglable.length === 0} onClick={() => setAttach(togglable.map(item => item.run.run_id), false)}>关</button>
        <span className="text-white/45">{togglable.length > 0
          ? `${onCount}/${togglable.length} 段开着${togglable.length < runs.length ? ` · ${runs.length - togglable.length} 段带不了` : ''}`
          : noPrevis ? '没做预演' : firstOff?.reason}</span>
        {togglable.length === 0 && firstOff?.action === 'go-previs' && onGoPrevis && <button type="button" className={chip} onClick={onGoPrevis}>{noPrevis ? '去做预演' : '去生成预演'}</button>}
      </div>;
    })()}
    <div className="grid gap-5 p-4 sm:p-5 2xl:grid-cols-2">
      {rows.map(({ run, id, label }) => {
        const cast = castOf(run);
        const plan = model ? planFor(model, run.duration_seconds) : undefined;
        const issues = model ? checkVideoPlan(model, { seconds: run.duration_seconds, referenceImages: cast.length, resolution: resolution || undefined }) : [];
        const edited = { ...editedRun(run, edits[id]), target_prompt: promptFor(run) };
        const attach = attachFor(run);
        const blocked = !model || !edited.target_prompt.trim() || Boolean(plan?.blocked) || issues.some((issue) => issue.level === 'block') || (model ? toApiPrompt(edited.target_prompt, cast.map(binding => binding.character_id ?? ''), model, { referenceVideo: attach.on }).length > CREATIVE_PROMPT_LIMIT : false);
        const { shot, clipRange, clip } = previsMatch(run);
        const prompt = (clip || clipRange) && edited.target_prompt.trim() ? withPrevisBinding(edited.target_prompt) : edited.target_prompt;
        // 装不下的段不报价：按一个提交不了的秒数算出来的积分既不会发生，又会让人以为很贵。
        const credits = model && plan && !plan.blocked ? estimateCredits(model, plan.billedSeconds, resolution || undefined) : undefined;
        const task = tasks[id];
        const pct = typeof task?.progress === 'number' ? Math.max(0, Math.min(100, task.progress)) : undefined;
        const done = task?.status === 'completed' || task?.status === 'failed';
        const stateLabel = task ? ({ queued: '排队中', in_progress: '生成中', completed: '已完成', failed: '失败' }[task.status] ?? task.status) : '';
        const shots = shotsFor(run);
        const notes = [
          // 被拦下的段必须当场说清为什么，否则用户只看到一行灰掉的按钮，不知道是哪儿出了问题。
          // checkVideoPlan 已经就同一件事给出 block 时不再重复一遍——同一句话说两遍只会让人以为是两个问题。
          ...(plan?.blocked && !issues.some((issue) => issue.level === 'block') ? [`⛔ ${plan.blocked}`] : []),
          ...(plan && !plan.blocked && plan.padded > 0.001
            ? [`提交 ${plan.seconds ?? model?.fixedSeconds}s（多出 ${plan.padded}s，拼接时裁掉），按 ${plan.billedSeconds}s 计费`] : []),
          // 手填时长比这一段短时，后半段的内容根本演不完——这必须说在提交之前。
          ...(plan && !plan.blocked && (plan.short ?? 0) > 0.001
            ? [`⚠️ 手填 ${plan.seconds}s 比这一段短 ${plan.short}s，本段后 ${plan.short}s 的内容不会被演出来`] : []),
          ...(shots ? [`已生成 ${shots.shots.length} 段 shots 分镜表${shots.byActionBeat ? '（按镜头内部动作拍点切）' : ''}${shots.stretched ? '（时长按比例摊开，节奏会变）' : ''}`] : []),
          ...issues.map((issue) => issue.message),
        ];
        return <article key={id} className="min-w-0 rounded-xl border border-white/15 bg-[#091712] p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h3 className="font-semibold text-white/95">{label} <span className="ml-2 font-mono text-xs font-normal text-white/55">{id}</span></h3>
            <span className="text-xs text-white/45">
              {run.duration_seconds}s · {cast.length} 角色
              {credits !== undefined && <> · <span className="text-emerald-100/80">{credits.toFixed(2)} 积分</span></>}
              {payloadKb[id] ? ` · ${payloadKb[id] >= 1024 ? `${(payloadKb[id] / 1024).toFixed(1)} MB` : `${payloadKb[id]} KB`}` : ''}
            </span>
            {task && (
              <span className={`rounded-md px-2 py-0.5 text-[11px] ${task.status === 'completed' ? 'bg-emerald-300/15 text-emerald-100' : task.status === 'failed' ? 'bg-rose-400/15 text-rose-100' : 'bg-white/8 text-white/70'}`}>
                {stateLabel}{pct !== undefined ? ` ${pct}%` : ''}
                {typeof task.elapsed === 'number' ? ` · ${task.elapsed < 60 ? `${task.elapsed}s` : `${Math.floor(task.elapsed / 60)}分${task.elapsed % 60}秒`}` : ''}
              </span>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              <button
                className="rounded-lg bg-emerald-300 px-3 py-1.5 text-xs font-semibold text-[#082018] transition hover:bg-emerald-200 disabled:bg-white/10 disabled:text-white/30"
                disabled={blocked || busy !== ''}
                onClick={() => void submit(run, id)}
              >{busy === id ? '处理中…' : '提交生成'}</button>
              <details className="relative">
                <summary className="cursor-pointer list-none rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/50 hover:text-white/80">更多</summary>
                <div className="absolute right-0 z-10 mt-1.5 flex w-52 flex-col gap-1 rounded-xl border border-white/12 bg-[#0b1714] p-1.5 shadow-xl">
                  <button className={chip} disabled={blocked || busy !== ''} onClick={() => void withRequest(run, id, 'copy', async (text) => { await navigator.clipboard.writeText(text); setCopied(id); })}>{copied === id ? '已复制请求体' : '复制 API 请求体'}</button>
                  <button className={chip} disabled={blocked || busy !== ''} onClick={() => void withRequest(run, id, 'download', (text) => downloadText(`${id}-${model?.id ?? 'video'}-request.json`, text, 'application/json'))}>下载请求体</button>
                  <button className={chip} disabled={busy !== ''} onClick={() => void resume(run, id)}>找回上次任务</button>
                  <button className={chip} disabled={busy !== ''} onClick={() => trackManual(id)}>用任务 ID 继续查</button>
                  <button className={chip} disabled={busy !== ''} onClick={() => void dumpRaw(run, id)}>导出原始返回</button>
                </div>
              </details>
            </span>
          </div>
          {model && <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <label className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 ${attach.attachable ? 'border-emerald-300/30 text-emerald-100/90' : 'cursor-not-allowed border-white/10 text-white/35'}`}>
              <input type="checkbox" aria-label={`${id}附带 3D 预演参考`} disabled={!attach.attachable} checked={attach.on} onChange={event => setAttach([id], event.target.checked)} />
              附带 3D 预演参考
            </label>
            {attach.attachable
              ? <>{(clipRange && previs?.film) || clip ? <button type="button" className="text-emerald-100/75 underline underline-offset-2 hover:text-emerald-100" onClick={() => { const box = document.getElementById(`previs-${id}`) as HTMLDetailsElement | null; if (box) { box.open = true; box.scrollIntoView({ block: 'nearest' }); } }}>预览本段 3D</button> : null}
                <span className="text-white/40">{attach.on ? '开：提交时导出本段 3D 一起发' : '关：只按文字分镜提交'}</span></>
              : <span className="text-white/45">{attach.reason}</span>}
            {!attach.attachable && attach.action === 'go-previs' && onGoPrevis && <button type="button" className="rounded-md border border-white/15 px-2 py-0.5 text-white/60 hover:text-white/85" onClick={onGoPrevis}>去生成预演</button>}
            {requestNotes[id] && <span role="status" className="text-amber-100/80">{requestNotes[id]}</span>}
          </div>}
          <p className="mt-2 text-sm tabular-nums text-white/65">新片 {run.source_start_seconds}–{run.source_end_seconds} 秒</p>
          <div className="mt-4 flex flex-wrap gap-3">{cast.map(binding => {
            const asset = referenceAssets.find(item => item.asset_id === binding.asset_id && !item.retired);
            return <figure key={binding.character_id} className="w-20">{asset ? <Image unoptimized width={80} height={80} src={asset.uri} alt={`${binding.character_id}角色参考图`} className="h-20 w-20 rounded-lg object-cover" /> : <div className="flex h-20 items-center text-xs text-amber-100">角色图缺失</div>}<figcaption className="mt-1 text-xs text-white/65">{binding.character_id}</figcaption></figure>;
          })}</div>
          <p className="mt-3 text-sm leading-6 text-emerald-100/80">{model ? `API 携带：${Math.min(cast.length, model.maxReferenceImages, model.maxReferenceTotal ?? model.maxReferenceImages)} 张角色图＋当前提示词${attach.on ? '＋本段 3D 预演（提交时现场导出上传）' : '。3D 视频未附带'}。` : '尚未选择 API 模型，可先复制提示词或下载素材。'}</p>
          {clipRange && previs?.film ? <details id={`previs-${id}`} className="mt-3"><summary className="cursor-pointer text-sm text-emerald-100">查看本段 3D 参考</summary><div className="mt-3"><PrevisClip film={previs.film} range={clipRange} name={`${id}-3D预演`} buttonClass={chip} /></div>{shot?.localChecksPassed === false && <p className="mt-2 text-sm text-amber-100">需复看：{shot.issues?.join('；')}</p>}</details> : clip ? <details id={`previs-${id}`} className="mt-3"><summary className="cursor-pointer text-sm text-emerald-100">查看本段 3D 参考</summary><video controls preload="none" src={clip} className="mt-3 max-h-80 w-full rounded-lg bg-black" />{shot?.localChecksPassed === false && <p className="mt-2 text-sm text-amber-100">需复看：{shot.issues?.join('；')}</p>}</details> : <p className="mt-3 text-xs text-white/55">{preserve ? '暂无可匹配的本段 3D。完成预演后重新进入此页。' : '当前为改编故事，未将原片 3D 强行对应到新分镜。'}</p>}
          <label className="mt-4 block text-sm font-medium text-white/85">出片提示词 · 可编辑<textarea aria-label={`${id}出片提示词`} value={prompt} onChange={event => changePrompt(run, event.target.value)} className="mt-2 min-h-64 w-full resize-y rounded-lg border border-white/20 bg-black/20 p-4 text-sm leading-7 text-white/85" /></label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={chip} disabled={prompt.length > CREATIVE_PROMPT_LIMIT} onClick={() => void copyPrompt(`prompt:${id}`, prompt)}>{copied === `prompt:${id}` ? '已复制' : '复制提示词'}</button>
            <button className={chip} onClick={() => downloadText(`${id}-提示词.txt`, prompt, 'text/plain')}>下载提示词</button>
            <button className={chip} disabled={busy !== '' || cast.length === 0} onClick={() => void downloadRoles(run)}>下载本段角色图</button>
            {clip && <a className={chip} href={`${clip}&download=1`}>下载本段 3D</a>}
            {edited.target_prompt !== run.target_prompt && <button className={chip} onClick={() => changePrompt(run, run.target_prompt)}>恢复原提示词</button>}
          </div>
          <p className="mt-2 text-xs leading-5 text-white/55">编辑保存在本机，仅影响本段复制和提交，不改故事或重新渲染 3D。手动平台需先上传角色图，再通过 @ 菜单绑定。</p>
          {model && <p className="mt-1 text-xs leading-5 text-emerald-100/60">API 提交时：{attach.on ? '带本段 3D 预演，提示词里的 3D 绑定句会换成「走位、构图与运镜跟随参考视频」' : '不带 3D，提示词里的 3D 绑定句会换成「只用角色图和文字分镜，不需要参考视频」'}（下方「查看 API 实际提示词」是最终发送版）。</p>}
          {!edited.target_prompt.trim() && <p className="mt-2 text-sm text-amber-100">提示词不能为空。</p>}
          <p className={`mt-2 text-xs ${prompt.length > CREATIVE_PROMPT_LIMIT ? 'text-amber-100' : 'text-white/55'}`}>{prompt.length.toLocaleString()} / 4,000 字符{prompt.length > CREATIVE_PROMPT_LIMIT ? ' · 超过即梦上限，请精简后复制；动作和对白未被截断。' : ''}</p>

          {task && !done && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/8">
              {pct !== undefined
                ? <div className="h-full rounded-full bg-emerald-300 transition-all" style={{ width: `${pct}%` }} />
                : <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-300/50" />}
            </div>
          )}
          {task?.videoUrl && (
            <div className="mt-3 space-y-2">
              {/* 签名链接不需要请求头，可以直接给 video 标签用，不必跳出去看 */}
              <video className="max-h-[22rem] w-full rounded-xl border border-white/10 bg-black" src={task.videoUrl} controls preload="metadata" playsInline />
              <p className="text-xs text-white/45">
                <a className="text-emerald-100/85 underline" href={task.videoUrl} target="_blank" rel="noreferrer">新窗口打开</a>
                {' · '}
                <a className="text-emerald-100/85 underline" href={task.videoUrl} download={`${id}.mp4`}>下载 MP4</a>
                {' · 签名链接 7 天有效，拿到的人都能看，别贴公开群'}
              </p>
            </div>
          )}
          {(() => {
            // 本机存档状态：拼接包装用的是这份，不是上面的签名链接。
            const record = stored[id];
            const saving = keeping[id];
            const fresh = record ? segmentFreshness(record, fingerprints[id]) : undefined;
            if (saving === 'saving') return <p className="mt-2 text-xs text-white/50">正在把视频存到本机（不计费）…</p>;
            if (saving && saving !== 'saved' && !record) return <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-amber-200/85">存到本机失败：{saving}{task?.videoUrl && <> <button type="button" className="underline" onClick={() => void keepSegment(id, task.taskId, task.videoUrl!)}>再试一次</button></>}</p>;
            if (!record) return null;
            return <p className="mt-2 text-xs leading-5 text-white/55">
              <span className="text-emerald-100/80">{record.origin === 'local' ? '已用本机文件补上' : '已存到本机'}</span>（{record.durationSeconds.toFixed(2)}s，拼接包装用这份）
              {fresh && isStale(fresh) && <span className="ml-2 rounded-md bg-amber-300/15 px-1.5 py-0.5 text-amber-100">{FRESHNESS_LABEL[fresh]}</span>}
              {fresh && isStale(fresh) && <span className="ml-1 text-white/40">旧视频仍可用于包装；要新的就手动点「提交生成」。</span>}
            </p>;
          })()}
          {task?.error && <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-amber-200/85">{task.error}</p>}
          {task && !done && <p className="mt-1 text-[11px] text-white/30">每 15 秒查一次，不计费。进度不动属正常，别重复提交——重复提交会各自单独计费。</p>}
          {notes.length > 0 && <p className="mt-1.5 text-[11px] leading-5 text-white/40">{notes.join(' · ')}</p>}
          {/* 显示真正发出去的那份提示词（API 版：已去掉即梦的 @ 绑定段，换成按序对应说明） */}
          {model && (() => {
            const sent = toApiPrompt(edited.target_prompt, cast.map((binding) => binding.character_id ?? ''), model, { referenceVideo: attach.on });
            return <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-white/35 hover:text-white/65">
                查看 API 实际提示词（{sent.length.toLocaleString()} 字符{shots ? ` + ${shots.shots.length} 段 shots` : ''}）
              </summary>
              <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-black/25 p-3 text-[11px] leading-5 text-white/55">{sent}</pre>
              <button className={`${chip} mt-2`} disabled={sent.length > CREATIVE_PROMPT_LIMIT} onClick={() => void copyPrompt(`api:${id}`, sent)}>{copied === `api:${id}` ? '已复制' : '复制 API 提示词'}</button>
              {shots && <pre className="mt-1.5 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-black/25 p-3 text-[11px] leading-5 text-white/45">{shots.shots.map((shot, index) => `[${index + 1}] ${shot.duration}s  ${shot.prompt}`).join('\n')}</pre>}
            </details>;
          })()}
        </article>;
      })}
    </div>

    <PostPanel
      projectId={projectId}
      title={pack.title}
      runs={runs}
      labels={Object.fromEntries(rows.map(row => [row.id, row.label]))}
      beats={pack.beats}
      analysis={preserve ? analysis : undefined}
      preserve={preserve}
      segments={stored}
      freshness={Object.fromEntries(Object.entries(stored).map(([runId, record]) => [runId, segmentFreshness(record, fingerprints[runId])]))}
    />

    {/* 只在选档时看一次的东西收进折叠，别一直占半屏 */}
    {model && (
      <details className="border-t border-white/8 px-5 py-2.5">
        <summary className="cursor-pointer text-xs text-white/40 hover:text-white/70">
          这一档的能力与限制：时长 {model.fixedSeconds ? `固定 ${model.fixedSeconds}s` : model.allowedSeconds ? `${model.allowedSeconds.join('/')}s` : `${model.minSeconds ?? 1}–${model.maxSeconds}s`}
          {' · 参考图 '}{model.maxReferenceImages} 张
          {' · '}{model.supportsEditExtend ? '支持全能模式' : '不支持编辑延长'}
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] leading-5 text-white/40">
          {model.notes.map((note) => <li key={note}>{note}</li>)}
          <li>请求体里的角色图已按长边 1280px 压缩后转 data URI（本机 /api/assets 链接上游访问不到）。</li>
          <li>提交到 POST {loadConnection('video').baseUrl}/videos 拿 task_id，再轮询 GET /videos/&#123;task_id&#125;；本页不替你自动提交付费任务。</li>
          <li>积分不是人民币，实际扣费按你的充值比例，以控制台「模型价格」页为准。</li>
        </ul>
      </details>
    )}
  </section>;
}
