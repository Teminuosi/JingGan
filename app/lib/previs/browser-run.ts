// 浏览器预演：直接从浏览器调用户的中转编排动作，结果存在本机 IndexedDB，渲染在页面里完成。
// 编排逻辑（提示词、校验、续跑）与本机助手共用 worker/previs/plan.mjs，不另写一套。
import { createGemini, validateConnection } from '../../../worker/previs/gemini.mjs';
import { countModelCalls, planPerShot, segmentsFor } from '../../../worker/previs/plan.mjs';
import { validateInput } from '../../../worker/previs/contract.mjs';
import { normalizeMinuteSecondTimeline } from '../timeline-normalization.mjs';
import type { VideoDnaAnalysis } from '../types';
import { relayHeaders, type RelayConnection } from '../relay-client';
import { checkShot, renderSize, shotFrames, type Film, type MotionPlan } from './film';

export type Transport = 'direct' | 'proxy';
export type RunStatus = 'planning' | 'ready' | 'needs_review' | 'failed' | 'canceled';
export interface ShotRecord { index: number; shotIndex: number; beatId: string; start: number; end: number; frames: number; localChecksPassed: boolean; issues: string[] }
export interface PrevisRun {
  version: 'browser-previs.v1'; projectId: string; accountId: string; dnaHash: string;
  status: RunStatus; message: string; transport?: Transport; model?: string;
  createdAt: number; updatedAt: number; index?: number; total: number;
  plannedModelCalls: number; newModelCalls: number; reusedModelCalls: number; schemaRejected?: boolean;
  width: number; height: number; shots: ShotRecord[];
}

// ---------- IndexedDB：模型原始返回（续跑用）与最终计划 ----------
const DB = 'mirror-browser-previs';
const open = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('files'); request.result.createObjectStore('runs'); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function tx<T>(store: 'files' | 'runs', mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const request = work(t.objectStore(store));
      const fail = () => reject(request?.error ?? t.error ?? new Error('本机存储（IndexedDB）读写失败'));
      t.oncomplete = () => resolve(request ? request.result : undefined);
      t.onerror = fail;
      t.onabort = fail;
    });
  } finally { db.close(); }
}
const runKey = (accountId: string, projectId: string) => `${accountId}|${projectId}`;
const fileKey = (accountId: string, projectId: string, dnaHash: string, name: string) => `${accountId}|${projectId}|${dnaHash}|${name}`;

export const loadRun = (accountId: string, projectId: string) => tx<PrevisRun>('runs', 'readonly', s => s.get(runKey(accountId, projectId)));
const saveRun = (run: PrevisRun) => tx('runs', 'readwrite', s => { s.put({ ...run, updatedAt: Date.now() }, runKey(run.accountId, run.projectId)); });
const savePlans = (run: PrevisRun, plans: MotionPlan[]) => tx('files', 'readwrite', s => { s.put(plans, fileKey(run.accountId, run.projectId, run.dnaHash, 'plans')); });
export const loadPlans = (run: PrevisRun) => tx<MotionPlan[]>('files', 'readonly', s => s.get(fileKey(run.accountId, run.projectId, run.dnaHash, 'plans')));

/** 某次运行的完整片子（计划 + 镜头时间），播放和导出都用它。 */
export async function loadFilm(run: PrevisRun): Promise<Film | null> {
  const plans = await loadPlans(run);
  if (!plans || plans.length !== run.shots.length) return null;
  return { width: run.width, height: run.height, shots: run.shots.map((shot, i) => ({ index: shot.index, shotIndex: shot.shotIndex, beatId: shot.beatId, start: shot.start, end: shot.end, frames: shot.frames, plan: plans[i] })) };
}

/** 清掉某次 DNA 下保存的全部编排结果（「清空重做」用）。只删这个账号这个项目这份 DNA 的。 */
export async function clearSaved(accountId: string, projectId: string, dnaHash: string) {
  const prefix = `${accountId}|${projectId}|${dnaHash}|`;
  await tx('files', 'readwrite', s => { s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)); });
}

const idbStore = (accountId: string, projectId: string, dnaHash: string) => ({
  read: (name: string) => tx<unknown>('files', 'readonly', s => s.get(fileKey(accountId, projectId, dnaHash, name))).catch(() => undefined),
  write: (name: string, value: unknown) => tx('files', 'readwrite', s => { s.put(value, fileKey(accountId, projectId, dnaHash, name)); }),
  reject: async (name: string) => {
    const value = await tx<unknown>('files', 'readonly', s => s.get(fileKey(accountId, projectId, dnaHash, name)));
    await tx('files', 'readwrite', s => {
      if (value !== undefined) s.put(value, fileKey(accountId, projectId, dnaHash, name.replace(/\.json$/, `.rejected-${Date.now()}.json`)));
      s.delete(fileKey(accountId, projectId, dnaHash, name));
    });
  },
});

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 连接方式：先免费探测能不能从浏览器直连 ----------
const KEY_ERROR = '中转拒绝了这个 Key（无效、过期或余额不足）。请到“AI 服务设置”检查视频分析 Key；本次未调用模型、未计费。';

/** 免费请求一次模型列表：能拿到响应就说明中转允许浏览器直连；跨域被拦时请求在拿到响应前就失败。 */
export async function probeTransport(connection: RelayConnection, signal?: AbortSignal): Promise<Transport> {
  const c = validateConnection(connection);
  let response: Response;
  try {
    // 头要和真正的编排请求一致（含 Content-Type），跨域预检才会对同一组头做判断。
    response = await fetch(`${c.baseUrl}/v1beta/models`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}`, 'x-goog-api-key': c.apiKey }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20000)]) });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return 'proxy';
  }
  await response.body?.cancel().catch(() => {});
  // 403 不算：有的中转只是不开放模型列表，生成接口照常可用。
  if ([401, 402].includes(response.status)) throw new Error(KEY_ERROR);
  return 'direct';
}

function fetchFor(transport: Transport, connection: RelayConnection): typeof fetch {
  const origin = new URL(connection.baseUrl).origin;
  if (transport === 'direct') return (input, init) => fetch(input, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
  // 兜底：经镜感服务器转发（与视频分析同一个白名单接口）。Key 放在转发专用头里，不进 URL。
  return async (input, init) => {
    const url = String(input).replace(origin, `${window.location.origin}/api/relay/native`);
    const headers = new Headers(init?.headers);
    headers.delete('Authorization'); headers.delete('x-goog-api-key');
    for (const [name, value] of Object.entries(relayHeaders(connection))) headers.set(name, value);
    const response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
    if (response.ok) return response;
    // 镜感服务器自己拦下的（站点没开放这个中转、登录过期、接口不在白名单）根本没发到中转：
    // 直接说清楚「未提交」，不能交给编排客户端的 400 回退去重试，更不能说「可能已计费」。
    const body = await response.clone().json().catch(() => null) as { error?: string } | null;
    if (response.headers.get('x-mirror-submission') === 'not-submitted' || body?.error === 'Gemini 原生请求无效。') {
      throw Object.assign(new Error(`镜感服务器没有转发这次请求（未提交、未计费）：${(body?.error || `HTTP ${response.status}`).replace(/。$/, '')}。这个中转不支持浏览器直连，本站也没有开放经服务器转发它；请换用支持直连的中转（如 HeyRoute），或用「高级：本机 Blender 渲染」`), { notSubmitted: true });
    }
    return response;
  };
}

const scrub = (text: string, key: string) => key ? text.split(key).join('***') : text;

export interface StartOptions {
  projectId: string; analysis: VideoDnaAnalysis; source: { duration: number; width: number; height: number };
  connection: RelayConnection; accountId: string; allowModelCalls: boolean;
  /** 用户在确认框里同意的调用次数上限；超过就停，宁可停也不多花钱。 */
  maxNewCalls: number;
  signal?: AbortSignal; onUpdate: (run: PrevisRun) => void;
}

/** 当前分析对应的 DNA 哈希（判断已保存的预演是否过期）。 */
export async function analysisHash(analysis: VideoDnaAnalysis, duration: number) {
  return sha256(JSON.stringify(normalizeMinuteSecondTimeline(analysis, duration)));
}

/**
 * 这次真正要调用模型几次：与编排同一顺序、同一校验（存档有数据但校验不过的，也要重调）。
 * exact=false 表示共享库要重做，后面能复用几镜要看新的库，按上限算。
 */
export async function plannedCalls(accountId: string, projectId: string, analysis: VideoDnaAnalysis, duration: number) {
  const normalized = normalizeMinuteSecondTimeline(analysis, duration);
  validateInput(normalized, duration);
  const dnaHash = await sha256(JSON.stringify(normalized));
  const segments = segmentsFor(normalized, 600);
  const result = await countModelCalls({ segments, store: idbStore(accountId, projectId, dnaHash) }) as { total: number; toCall: number; exact: boolean };
  return { ...result, saved: result.total - result.toCall, dnaHash };
}

export async function runBrowserPrevis({ projectId, analysis: raw, source, connection, accountId, allowModelCalls, maxNewCalls, signal, onUpdate }: StartOptions): Promise<PrevisRun> {
  const analysis = normalizeMinuteSecondTimeline(raw, source.duration);
  validateInput(analysis, source.duration);
  const dnaHash = await sha256(JSON.stringify(analysis));
  const segments = segmentsFor(analysis, 600) as { shotIndex: number; start: number; end: number; beat: { beat_id: string } }[];
  const size = renderSize(source.width, source.height);
  const run: PrevisRun = {
    version: 'browser-previs.v1', projectId, accountId, dnaHash, status: 'planning', message: '准备编排', model: connection.model,
    createdAt: Date.now(), updatedAt: Date.now(), total: segments.length, plannedModelCalls: segments.length + 1, newModelCalls: 0, reusedModelCalls: 0,
    width: size.width, height: size.height, shots: [],
  };
  const publish = async (patch: Partial<PrevisRun>) => { Object.assign(run, patch); await saveRun(run).catch(() => {}); onUpdate({ ...run }); };
  await publish({});
  // 放在 try 外：失败时也要如实记下已经尝试过几次调用（524/断线也可能已计费）。
  const manifest = { newModelCalls: 0, reusedModelCalls: 0, schemaRejected: false };
  try {
    const transport = allowModelCalls && maxNewCalls > 0 ? await probeTransport(connection, signal) : undefined;
    await publish({ transport });
    const gemini = transport ? createGemini(connection, { fetchImpl: fetchFor(transport, connection) }) : undefined;
    let used = 0;
    // 硬上限：实际要调的次数超过用户确认的数字就停（未提交），不在确认之外多花一分钱。
    const model = async (request: Parameters<NonNullable<typeof gemini>>[0]) => {
      if (!gemini || used >= maxNewCalls) throw Object.assign(new Error(`这一步需要比确认时更多的模型调用（已确认 ${maxNewCalls} 次）。已停止，这一次没有提交、没有计费；请重新点开始，按新的次数确认`), { notSubmitted: true });
      used += 1;
      return gemini(request);
    };
    const plans = await planPerShot({
      analysis, segments, store: idbStore(accountId, projectId, dnaHash), model, signal, allowModelCalls: allowModelCalls && maxNewCalls > 0, manifest,
      onProgress: async ({ index, message }: { index?: number; message: string }) => publish({ index, message, newModelCalls: manifest.newModelCalls, reusedModelCalls: manifest.reusedModelCalls }),
    }) as MotionPlan[];
    const shots: ShotRecord[] = segments.map((segment, index) => {
      const frames = shotFrames(segment.start, segment.end);
      const { issues } = checkShot(plans[index], frames);
      return { index, shotIndex: segment.shotIndex, beatId: segment.beat.beat_id, start: segment.start, end: segment.end, frames, localChecksPassed: issues.length === 0, issues };
    });
    await savePlans(run, plans);
    await publish({
      shots, status: shots.every(s => s.localChecksPassed) ? 'ready' : 'needs_review', index: undefined,
      message: '编排完成，预演在本页实时渲染', newModelCalls: manifest.newModelCalls, reusedModelCalls: manifest.reusedModelCalls, schemaRejected: manifest.schemaRejected,
    });
    return run;
  } catch (cause) {
    const aborted = signal?.aborted;
    const message = scrub(cause instanceof Error ? cause.message : String(cause), connection.apiKey);
    await publish({ status: aborted ? 'canceled' : 'failed', newModelCalls: manifest.newModelCalls, reusedModelCalls: manifest.reusedModelCalls, message: aborted ? '已停止。已经拿到的镜头结果保留，继续时不重复计费。' : message });
    return run;
  }
}
