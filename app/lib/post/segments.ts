// 后期包装层：生成段落的"指纹 / 是否过期 / 裁剪秒数 / 还要花几次钱"。纯函数，node 里可直接单测。
// 段落文件本身存在浏览器 IndexedDB（segment-store.ts），这里只管判断。
import { estimateCredits, type SecondsPlan, type VideoModelCapability, type VideoResolution } from '../video-models';

/** 本机存着的一段视频的元数据（不含文件本体）。 */
export interface SegmentMeta {
  runId: string;
  beatIds: string[];
  /** 这一段在新片时间轴上的起止（秒），与 SeedanceRun.source_start/end_seconds 同义。 */
  sourceStart: number;
  sourceEnd: number;
  /** 分镜设计的时长（秒），即 run.duration_seconds。 */
  plannedSeconds: number;
  /** 生成时整份请求（提示词 + 模型 + 参数 + 角色图 ID）的指纹；本机文件或来源不明时为空串。 */
  requestHash: string;
  /** 生成时提示词（含 shots 分镜表）的指纹；用来说清"是提示词变了还是参数变了"。 */
  promptHash: string;
  model: string;
  /** 实际提交的秒数（固定时长档为空）。 */
  seconds?: number;
  billedSeconds?: number;
  /** 模型多出的秒数（提交时长 − 设计时长），拼接时裁掉。 */
  padded: number;
  taskId?: string;
  /** relay = 生成后自动存下；local = 用户从本机文件补的。 */
  origin: 'relay' | 'local';
  fileName?: string;
  /** mediabunny 实测的画面时长（秒）。 */
  durationSeconds: number;
  createdAt: number;
}

export type SegmentFreshness = 'fresh' | 'stale-prompt' | 'stale-params' | 'unknown';

export const FRESHNESS_LABEL: Record<SegmentFreshness, string> = {
  fresh: '提示词没变',
  'stale-prompt': '已过期（提示词变了）',
  'stale-params': '已过期（模型或参数变了）',
  unknown: '来源不明，无法判断是否过期',
};

export interface CurrentFingerprint { requestHash: string; promptHash: string }

/** 存着的段落和当前编译出来的提示词比：没变 / 提示词变了 / 参数变了 / 判断不了。 */
export function segmentFreshness(segment: Pick<SegmentMeta, 'requestHash' | 'promptHash' | 'origin'>, current?: CurrentFingerprint): SegmentFreshness {
  if (segment.origin === 'local' || !segment.requestHash || !current?.requestHash) return 'unknown';
  if (segment.requestHash === current.requestHash) return 'fresh';
  return segment.promptHash && segment.promptHash === current.promptHash ? 'stale-params' : 'stale-prompt';
}

export const isStale = (freshness: SegmentFreshness) => freshness === 'stale-prompt' || freshness === 'stale-params';

/**
 * 拼接时这一段保留前几秒。用户手填优先；否则模型多交了秒数（padded > 0）就裁回设计时长；
 * 其余整段保留（返回 undefined）。永远不超过实测时长。
 */
export function segmentKeepSeconds(segment: Pick<SegmentMeta, 'padded' | 'plannedSeconds' | 'durationSeconds'>, manual?: number): number | undefined {
  if (manual !== undefined && Number.isFinite(manual) && manual > 0) return Math.min(manual, segment.durationSeconds);
  if (segment.padded > 0.001 && segment.plannedSeconds > 0 && segment.plannedSeconds < segment.durationSeconds - 0.001) return segment.plannedSeconds;
  return undefined;
}

/** 同一段存了多份时取最新的一份。 */
export function latestByRun<T extends Pick<SegmentMeta, 'runId' | 'createdAt'>>(records: T[]): Record<string, T> {
  const result: Record<string, T> = {};
  for (const record of records) if (!result[record.runId] || result[record.runId].createdAt < record.createdAt) result[record.runId] = record;
  return result;
}

/** 稳定的 JSON：对象键排序，保证同一份内容算出同一个指纹。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** 内容指纹（SHA-256 前 16 位十六进制）。浏览器与 node 都有 crypto.subtle。 */
export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 一段请求的两个指纹。body 是不含角色图内容的请求体（角色图用 asset ID 代表，
 * 图片压缩档位变了不算"内容变了"）；promptHash 只看提示词与 shots 分镜表。
 */
export async function requestFingerprint(body: Record<string, unknown>, assetIds: string[]): Promise<CurrentFingerprint> {
  const rest = { ...body };
  for (const key of ['reference_images', 'images', 'input_reference']) delete rest[key];
  return {
    requestHash: await fingerprint({ ...rest, assets: assetIds }),
    promptHash: await fingerprint({ prompt: body.prompt ?? '', shots: body.shots ?? null }),
  };
}

// ---------------- 干跑计数：还要花几次钱 ----------------

export type RunCallStatus = 'reuse' | 'pending' | 'missing' | 'stale' | 'blocked';

export interface PlanRunInput {
  runId: string;
  plannedSeconds: number;
  /** 按当前模型算出的时长方案；没选模型时不给。 */
  plan?: SecondsPlan;
  /** 当前提示词的指纹；算不出（没选模型、提示词为空）时不给。 */
  current?: CurrentFingerprint;
}

export interface PlannedRun {
  runId: string;
  status: RunCallStatus;
  /** 要生成时提交几秒（固定时长档为空）。 */
  submitSeconds?: number;
  billedSeconds?: number;
  /** 预计积分；价格未知时为空，绝不编数。 */
  credits?: number;
  /** 已有段落但过期时，说明为什么。 */
  freshness?: SegmentFreshness;
}

export interface OutputCallPlan {
  runs: PlannedRun[];
  /** 需要重新生成（缺失或过期）的段。 */
  toGenerate: PlannedRun[];
  /** 已完成且没过期（或无法判断）的段，直接复用。 */
  reusable: number;
  /** 已经提交、还在跑或已出片还没存到本机的段：钱已经花过，不再计数。 */
  pending: number;
  blocked: number;
  /** toGenerate 里价格已知部分的积分合计。 */
  knownCredits: number;
  /** toGenerate 里价格未知的段数。 */
  unknownPrice: number;
}

/**
 * 和 worker/previs/plan.mjs 的 countModelCalls 同一个口径：只读本机存档、不发请求，
 * 算出"这次要真正调用几次模型"。确认框里的数字只从这里来。
 * - 有段落且指纹没变（或判断不了，例如本机文件）→ 复用；
 * - 已提交在跑 → 不计；
 * - 有段落但指纹变了 → 过期，要重生成；
 * - 没有段落 → 缺失，要生成；时长装不下的 → 拦下，不计价。
 */
export function planOutputCalls({ runs, segments, pending, model, resolution }: {
  runs: PlanRunInput[];
  segments: Record<string, Pick<SegmentMeta, 'requestHash' | 'promptHash' | 'origin'> | undefined>;
  pending: Iterable<string>;
  model?: VideoModelCapability | null;
  resolution?: VideoResolution;
}): OutputCallPlan {
  const running = new Set(pending);
  const planned: PlannedRun[] = runs.map(run => {
    const segment = segments[run.runId];
    const freshness = segment ? segmentFreshness(segment, run.current) : undefined;
    if (segment && freshness && !isStale(freshness)) return { runId: run.runId, status: 'reuse', freshness };
    if (running.has(run.runId)) return { runId: run.runId, status: 'pending', freshness };
    if (!model || !run.plan || run.plan.blocked) return { runId: run.runId, status: 'blocked', freshness };
    const credits = estimateCredits(model, run.plan.billedSeconds, resolution);
    return {
      runId: run.runId,
      status: segment ? 'stale' : 'missing',
      submitSeconds: run.plan.seconds ?? model.fixedSeconds,
      billedSeconds: run.plan.billedSeconds,
      ...(credits !== undefined ? { credits } : {}),
      freshness,
    };
  });
  const toGenerate = planned.filter(run => run.status === 'missing' || run.status === 'stale');
  return {
    runs: planned,
    toGenerate,
    reusable: planned.filter(run => run.status === 'reuse').length,
    pending: planned.filter(run => run.status === 'pending').length,
    blocked: planned.filter(run => run.status === 'blocked').length,
    knownCredits: Number(toGenerate.reduce((sum, run) => sum + (run.credits ?? 0), 0).toFixed(2)),
    unknownPrice: toGenerate.filter(run => run.credits === undefined).length,
  };
}

/** 确认框里"要生成什么"的一行行文字。 */
export function describeCallPlan(plan: OutputCallPlan, labelOf: (runId: string) => string = id => id): string[] {
  const unknown = plan.runs.filter(run => run.status === 'reuse' && run.freshness === 'unknown').length;
  const lines = plan.toGenerate.map(run => {
    const why = run.status === 'stale' ? (run.freshness === 'stale-params' ? '已过期，模型或参数变了' : '已过期，提示词变了') : '还没有视频';
    const seconds = run.submitSeconds !== undefined ? `${run.submitSeconds} 秒` : '固定时长';
    const price = run.credits !== undefined ? `约 ${run.credits.toFixed(2)} 积分` : '价格未知';
    return `· ${labelOf(run.runId)}：${why}，${seconds}，${price}`;
  });
  const total = plan.toGenerate.length
    ? `全片还需生成 ${plan.toGenerate.length} 段${plan.unknownPrice ? `，其中 ${plan.unknownPrice} 段价格未知` : ''}${plan.knownCredits > 0 ? `，已知部分合计约 ${plan.knownCredits.toFixed(2)} 积分` : ''}（每段单独提交、单独确认）：`
    : '全片没有需要生成的段落了。';
  return [
    total,
    ...lines,
    ...(plan.pending ? [`已提交还在跑的 ${plan.pending} 段不再计数，等它出结果。`] : []),
    `已完成且提示词没变的 ${plan.reusable - unknown} 段直接复用，不重复扣费。`,
    ...(unknown ? [`另有 ${unknown} 段是本机文件或来源不明，判断不了是否过期，也直接用，不重新生成。`] : []),
  ];
}
