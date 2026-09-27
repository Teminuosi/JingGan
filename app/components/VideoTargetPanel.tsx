'use client';
import { useEffect, useMemo, useState } from 'react';
import { zipSync } from 'fflate';
import Image from 'next/image';
import { compactCreativePrompt, CREATIVE_PROMPT_LIMIT, editedRun, matchingPrevisShot, voiceSpeakers, withPrevisBinding, withVoiceRoles, type OutputShot, type PromptEdit } from '../lib/output-runs';
import type { CreativePack, ReferenceAsset, SeedanceRun } from '../lib/types';
import { downloadText } from '../lib/export';
import { beatShotSegments } from '../lib/original-story';
import { confirmAction } from '../lib/confirm';
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

export function VideoTargetPanel({ pack, referenceAssets, projectId, videoModelId, onVideoModelChange, preserve = false }: { pack: CreativePack; referenceAssets: ReferenceAsset[]; projectId: string; videoModelId: string; onVideoModelChange: (id: string) => void; preserve?: boolean }) {
  const editKey = `mirror:output-prompts:${projectId}`;
  const [edits, setEdits] = useState<Record<string, PromptEdit>>(() => {
    try { return typeof window === 'undefined' ? {} : JSON.parse(localStorage.getItem(editKey) || '{}'); } catch { return {}; }
  });
  const changePrompt = (run: SeedanceRun, text: string) => {
    const next = { ...edits, [run.run_id]: { original: run.target_prompt, text } };
    setEdits(next);
    try { localStorage.setItem(editKey, JSON.stringify(next)); } catch { setError('提示词已编辑，但本机保存失败，请下载保留。'); }
  };
  const [previs, setPrevis] = useState<{ ticket: { id: string; token: string }; shots: OutputShot[] } | null>(null);
  const [previsNotice, setPrevisNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    if (!preserve) return;
    const restore = async () => {
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

  const buildRequest = async (run: SeedanceRun) => {
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
    const prompt = toApiPrompt(promptFor(run), cast.map(binding => binding.character_id ?? ''), model);
    if (!prompt.trim() || !editedRun(run, edits[run.run_id]).target_prompt.trim()) throw new Error('提示词不能为空。');
    if (prompt.length > CREATIVE_PROMPT_LIMIT) throw new Error('提示词超过 4,000 字符，请精简后提交。');
    return buildVideoRequest(model, {
      model: model.id,
      seconds: plan.seconds,
      resolution: resolution || undefined,
      prompt,
      referenceImages: images,
      shots: shotsFor(run)?.shots,
    }, params);
  };

  const [payloadKb, setPayloadKb] = useState<Record<string, number>>({});
  const withRequest = async (run: SeedanceRun, id: string, consume: (text: string) => void | Promise<void>) => {
    setBusy(id); setError('');
    try { await consume(JSON.stringify(await buildRequest(run), null, 2)); }
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
      if (state.status === 'completed' || state.status === 'failed') return;
    }
    setTask(id, { error: '轮询超过一小时仍未完成，任务可能仍在跑。稍后用「找回上次任务」接着查，不要重新提交。' });
  };

  const submit = async (run: SeedanceRun, id: string) => {
    if (busy) return;
    setBusy(id); setError('');
    try {
      const body = await buildRequest(run);
      const key = await videoCacheKey(projectId, id, body);
      const known = await recoverRelayVideoTask(key);
      const plan = model ? planFor(model, run.duration_seconds) : undefined;
      const credits = model && plan && !plan.blocked ? estimateCredits(model, plan.billedSeconds, resolution || undefined) : undefined;
      if (!known && !await confirmAction({
        title: `提交 ${id} 生成视频`,
        message: [
          `目标模型：${model?.label ?? model?.id}`,
          `本段时长：${run.duration_seconds} 秒`,
          `携带素材：${castOf(run).slice(0, model?.maxReferenceImages ?? 0).length} 张角色图＋当前编辑后的提示词。`,
          '不附带 3D 预演视频或原视频；需要 3D 参考时请下载素材，在平台手动绑定。',
          ...(manualSeconds !== undefined && model?.fixedSeconds === undefined
            ? [`⚠️ 你在参数表里把时长手动固定为 ${manualSeconds} 秒，本段会按 ${manualSeconds} 秒提交并计费，画面节奏和分镜对不上。`] : []),
          ...(credits !== undefined ? [`预计消耗：约 ${credits.toFixed(2)} 积分`] : []),
          '',
          '提交是唯一的扣费点，之后查进度、下载成片都不再计费。',
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

  // 页面关过、断过线时用这个把上次的 task_id 捞回来接着轮询，绝不会顺手再提交一次。
  const resume = async (run: SeedanceRun, id: string) => {
    if (busy) return;
    setBusy(id); setError('');
    try {
      const key = await videoCacheKey(projectId, id, await buildRequest(run));
      const taskId = await recoverRelayVideoTask(key);
      if (taskId) rememberTaskId(projectId, id, taskId);
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
      const key = await videoCacheKey(projectId, id, await buildRequest(run));
      const raw = await rawRelayVideoResult(key);
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
    <div className="grid gap-5 p-4 sm:p-5 2xl:grid-cols-2">
      {rows.map(({ run, id, label }) => {
        const cast = castOf(run);
        const plan = model ? planFor(model, run.duration_seconds) : undefined;
        const issues = model ? checkVideoPlan(model, { seconds: run.duration_seconds, referenceImages: cast.length, resolution: resolution || undefined }) : [];
        const edited = { ...editedRun(run, edits[id]), target_prompt: promptFor(run) };
        const blocked = !model || !edited.target_prompt.trim() || Boolean(plan?.blocked) || issues.some((issue) => issue.level === 'block') || (model ? toApiPrompt(edited.target_prompt, cast.map(binding => binding.character_id ?? ''), model).length > CREATIVE_PROMPT_LIMIT : false);
        const shot = matchingPrevisShot(run, previs?.shots ?? [], preserve);
        const clip = shot && previs ? `http://127.0.0.1:43128/jobs/${previs.ticket.id}/shot-${shot.index}?token=${encodeURIComponent(previs.ticket.token)}${Math.abs(run.source_start_seconds - shot.start) > .01 || Math.abs(run.source_end_seconds - shot.end) > .01 ? `&from=${+(run.source_start_seconds - shot.start).toFixed(3)}&to=${+(run.source_end_seconds - shot.start).toFixed(3)}` : ''}` : '';
        const prompt = clip && edited.target_prompt.trim() ? withPrevisBinding(edited.target_prompt) : edited.target_prompt;
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
                  <button className={chip} disabled={blocked || busy !== ''} onClick={() => void withRequest(run, id, async (text) => { await navigator.clipboard.writeText(text); setCopied(id); })}>{copied === id ? '已复制请求体' : '复制 API 请求体'}</button>
                  <button className={chip} disabled={blocked || busy !== ''} onClick={() => void withRequest(run, id, (text) => downloadText(`${id}-${model?.id ?? 'video'}-request.json`, text, 'application/json'))}>下载请求体</button>
                  <button className={chip} disabled={busy !== ''} onClick={() => void resume(run, id)}>找回上次任务</button>
                  <button className={chip} disabled={busy !== ''} onClick={() => trackManual(id)}>用任务 ID 继续查</button>
                  <button className={chip} disabled={busy !== ''} onClick={() => void dumpRaw(run, id)}>导出原始返回</button>
                </div>
              </details>
            </span>
          </div>
          <p className="mt-2 text-sm tabular-nums text-white/65">新片 {run.source_start_seconds}–{run.source_end_seconds} 秒</p>
          <div className="mt-4 flex flex-wrap gap-3">{cast.map(binding => {
            const asset = referenceAssets.find(item => item.asset_id === binding.asset_id && !item.retired);
            return <figure key={binding.character_id} className="w-20">{asset ? <Image unoptimized width={80} height={80} src={asset.uri} alt={`${binding.character_id}角色参考图`} className="h-20 w-20 rounded-lg object-cover" /> : <div className="flex h-20 items-center text-xs text-amber-100">角色图缺失</div>}<figcaption className="mt-1 text-xs text-white/65">{binding.character_id}</figcaption></figure>;
          })}</div>
          <p className="mt-3 text-sm leading-6 text-emerald-100/80">{model ? `API 携带：${Math.min(cast.length, model.maxReferenceImages, model.maxReferenceTotal ?? model.maxReferenceImages)} 张角色图＋当前提示词。3D 视频未附带。` : '尚未选择 API 模型，可先复制提示词或下载素材。'}</p>
          {clip ? <details className="mt-3"><summary className="cursor-pointer text-sm text-emerald-100">查看本段 3D 参考</summary><video controls preload="none" src={clip} className="mt-3 max-h-80 w-full rounded-lg bg-black" />{shot?.localChecksPassed === false && <p className="mt-2 text-sm text-amber-100">需复看：{shot.issues?.join('；')}</p>}</details> : <p className="mt-3 text-xs text-white/55">{preserve ? '暂无可匹配的本段 3D。完成预演后重新进入此页。' : '当前为改编故事，未将原片 3D 强行对应到新分镜。'}</p>}
          <label className="mt-4 block text-sm font-medium text-white/85">出片提示词 · 可编辑<textarea aria-label={`${id}出片提示词`} value={prompt} onChange={event => changePrompt(run, event.target.value)} className="mt-2 min-h-64 w-full resize-y rounded-lg border border-white/20 bg-black/20 p-4 text-sm leading-7 text-white/85" /></label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={chip} disabled={prompt.length > CREATIVE_PROMPT_LIMIT} onClick={() => void copyPrompt(`prompt:${id}`, prompt)}>{copied === `prompt:${id}` ? '已复制' : '复制提示词'}</button>
            <button className={chip} onClick={() => downloadText(`${id}-提示词.txt`, prompt, 'text/plain')}>下载提示词</button>
            <button className={chip} disabled={busy !== '' || cast.length === 0} onClick={() => void downloadRoles(run)}>下载本段角色图</button>
            {clip && <a className={chip} href={`${clip}&download=1`}>下载本段 3D</a>}
            {edited.target_prompt !== run.target_prompt && <button className={chip} onClick={() => changePrompt(run, run.target_prompt)}>恢复原提示词</button>}
          </div>
          <p className="mt-2 text-xs leading-5 text-white/55">编辑保存在本机，仅影响本段复制和提交，不改故事或重新渲染 3D。手动平台需先上传角色图，再通过 @ 菜单绑定。</p>
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
          {task?.error && <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-amber-200/85">{task.error}</p>}
          {task && !done && <p className="mt-1 text-[11px] text-white/30">每 15 秒查一次，不计费。进度不动属正常，别重复提交——重复提交会各自单独计费。</p>}
          {notes.length > 0 && <p className="mt-1.5 text-[11px] leading-5 text-white/40">{notes.join(' · ')}</p>}
          {/* 显示真正发出去的那份提示词（API 版：已去掉即梦的 @ 绑定段，换成按序对应说明） */}
          {model && (() => {
            const sent = toApiPrompt(edited.target_prompt, cast.map((binding) => binding.character_id ?? ''), model);
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
