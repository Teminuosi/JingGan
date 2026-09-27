// 进度页的数据源。
//
// 一次查全：镜头、任务、质检、费用。不让前端发五个请求再自己拼——
// 那样每次刷新都会出现「镜头已经更新了但费用还是旧的」这种半截状态，
// 用户看到的数字对不上，就再也不信这个页面了。
//
// 全部只读。写入是 worker 的事，页面不碰。

import { MIGRATIONS } from '../../../db/migrations';
import { requireDatabase } from './bindings';

export interface ShotView {
  shotId: string;
  idx: number;
  startTime: number;
  endTime: number;
  seconds: number;
  summary: string;
  characters: string[];
  /** 复杂度评分与是否走 3D 预演。用户要看得见系统凭什么多花这笔钱。 */
  complexityScore: number;
  needsBlender: boolean;
  blenderReasons: string[];
  /** 3D 预演算出的空间关系与机位描述。 */
  previsBlocking: string;
  previsCameraPath: string;
  /** 这一镜当前状态，由它自己的任务推出来。 */
  status: ShotStatus;
  /** 当前正在做什么。 */
  activity: string;
  attempts: number;
  /** 质检历史，最新在前。 */
  qa: Array<{
    outcome: 'pass' | 'warn' | 'fail';
    score: number;
    primaryFailure: string;
    /** 判废后系统决定怎么打。空表示还没处置。 */
    decision: string;
    decisionNote: string;
    findings: Array<{ message: string; verdict: string }>;
    createdAt: number;
  }>;
  estimateCents: number;
  chargedCents: number;
  hasClip: boolean;
}

export type ShotStatus =
  | 'queued'        // 排队中
  | 'keyframe'      // 生成关键帧
  | 'blender'       // 3D 预演
  | 'rendering'     // 出片中
  | 'checking'      // 质检中
  | 'retrying'      // 重试中
  | 'done'          // 已完成
  | 'needs_human';  // 自动手段用尽，等人

export interface PipelineView {
  projectId: string;
  title: string;
  status: string;
  /** 源片总时长，时间轴条按它分段。 */
  totalSeconds: number;
  shots: ShotView[];
  tasks: { total: number; succeeded: number; running: number; pending: number; dead: number };
  /** 一句话说清现在在干嘛。 */
  stage: string;
  cost: { estimateCents: number; chargedCents: number };
  finalVideo?: { assetId: string; key: string; seconds: number };
  /** 3D 预演产物。全片模式一条 MP4 + 一张布局图；逐镜模式每镜一份。 */
  previs: {
    mode: 'full' | 'per_shot' | 'none';
    video?: { key: string; seconds: number };
    layout?: string;
    /** 逐镜模式下每一镜的预演视频，键是 shotId。 */
    perShot: Record<string, string>;
    blocking: string;
    cameraPath: string;
  };
  /** 需要人工处理的镜头，单独拎出来——它们是唯一需要用户动手的地方。 */
  blocked: Array<{ shotId: string; idx: number; reason: string }>;
  updatedAt: number;
}

let schemaReady = false;

async function dbReady(): Promise<D1Database> {
  const db = requireDatabase();
  if (!schemaReady) {
    await db.batch(MIGRATIONS.map((s) => db.prepare(s)));
    schemaReady = true;
  }
  return db;
}

interface TaskRow {
  id: string; shot_id: string; type: string; status: string;
  attempt: number; output_json: string; error_text: string; failure_class: string;
}

/** 任务类型 → 这一镜正在做什么。给用户看的是动作，不是任务名。 */
/** 任务类型的人话名字。给用户看的是「全片 3D 预演」，不是「blender」。 */
const TASK_LABEL: Record<string, string> = {
  preprocess: '源视频处理', analyze: '镜头分析', keyframe: '关键帧',
  blender: '全片 3D 预演', video: '出片', qa: '质检', merge: '拼接',
};

const ACTIVITY: Record<string, { status: ShotStatus; label: string }> = {
  keyframe: { status: 'keyframe', label: '正在生成关键帧' },
  blender: { status: 'blender', label: '正在做 3D 预演' },
  video: { status: 'rendering', label: '正在生成画面' },
  qa: { status: 'checking', label: '正在质检' },
};

export async function loadPipeline(projectId: string, ownerId: string): Promise<PipelineView | null> {
  const db = await dbReady();

  const project = await db.prepare('SELECT id, title, status, updated_at FROM projects WHERE id = ? AND owner_id = ?')
    .bind(projectId, ownerId).first<{ id: string; title: string; status: string; updated_at: number }>();
  if (!project) return null;

  const shotRows = await db.prepare(
    `SELECT s.id, s.idx, s.start_time, s.end_time,
            d.summary, d.actors_json, d.complexity_json
     FROM shots s LEFT JOIN shot_dna d ON d.shot_id = s.id
     WHERE s.project_id = ? ORDER BY s.idx ASC`,
  ).bind(projectId).all<{
    id: string; idx: number; start_time: number; end_time: number;
    summary: string | null; actors_json: string | null; complexity_json: string | null;
  }>();

  const taskRows = await db.prepare(
    `SELECT id, shot_id, type, status, attempt, output_json, error_text, failure_class
     FROM tasks WHERE project_id = ? ORDER BY created_at ASC`,
  ).bind(projectId).all<TaskRow>();
  const tasks = taskRows.results ?? [];

  const qaRows = await db.prepare(
    `SELECT q.shot_id, q.outcome, q.score, q.primary_failure, q.decision, q.decision_note,
            q.findings_json, q.created_at
     FROM quality_reports q JOIN shots s ON s.id = q.shot_id
     WHERE s.project_id = ? ORDER BY q.created_at DESC`,
  ).bind(projectId).all<{
    shot_id: string; outcome: 'pass' | 'warn' | 'fail'; score: number;
    primary_failure: string; decision: string; decision_note: string;
    findings_json: string; created_at: number;
  }>();

  const clipRows = await db.prepare(
    "SELECT meta_json, object_key FROM assets WHERE project_id = ? AND kind = 'video_result'",
  ).bind(projectId).all<{ meta_json: string; object_key: string }>();
  const clipShots = new Set((clipRows.results ?? [])
    .map((r) => { try { return JSON.parse(r.meta_json).shotId as string; } catch { return ''; } })
    .filter(Boolean));

  const previsRows = await db.prepare(
    "SELECT object_key, meta_json FROM assets WHERE project_id = ? AND kind = 'blender_preview' ORDER BY created_at ASC",
  ).bind(projectId).all<{ object_key: string; meta_json: string }>();

  const finalRow = await db.prepare(
    "SELECT id, object_key, duration FROM assets WHERE project_id = ? AND kind = 'final_video' ORDER BY created_at DESC LIMIT 1",
  ).bind(projectId).first<{ id: string; object_key: string; duration: number }>();

  // ---- 逐镜汇总 ----
  const shots: ShotView[] = (shotRows.results ?? []).map((row) => {
    const mine = tasks.filter((t) => t.shot_id === row.id);
    const complexity = safeParse(row.complexity_json, {
      score: 0, needs_blender: false, reasons: [] as string[],
      previs: undefined as undefined | { blocking: string; camera_path: string },
    });
    const qa = (qaRows.results ?? []).filter((q) => q.shot_id === row.id).map((q) => ({
      outcome: q.outcome,
      score: q.score,
      primaryFailure: q.primary_failure,
      decision: q.decision,
      decisionNote: q.decision_note,
      findings: safeParse<Array<{ message: string; verdict: string }>>(q.findings_json, []),
      createdAt: q.created_at,
    }));

    // 费用：出片任务的 output 里记着预估与实扣，累加所有尝试。
    let estimateCents = 0; let chargedCents = 0;
    for (const t of mine.filter((x) => x.type === 'video' && x.status === 'succeeded')) {
      const out = safeParse<{ estimateCents?: number; chargedCents?: number }>(t.output_json, {});
      estimateCents += out.estimateCents ?? 0;
      chargedCents += out.chargedCents ?? 0;
    }

    const active = mine.find((t) => t.status === 'running' || t.status === 'leased');
    const dead = mine.find((t) => t.status === 'dead');
    const latestQa = qa[0];

    let status: ShotStatus;
    let activity: string;
    if (active) {
      const a = ACTIVITY[active.type];
      status = a?.status ?? 'rendering';
      activity = a?.label ?? '处理中';
      if ((active.attempt ?? 0) > 1) { status = 'retrying'; activity = `第 ${active.attempt} 次尝试：${activity}`; }
    } else if (dead) {
      status = 'needs_human';
      activity = dead.error_text || '任务失败';
    } else if (latestQa?.outcome === 'fail' && latestQa.decision === 'manual') {
      status = 'needs_human';
      activity = latestQa.decisionNote || '自动重试已用尽';
    } else if (latestQa && latestQa.outcome !== 'fail' && mine.every((t) => t.status === 'succeeded')) {
      status = 'done';
      activity = latestQa.outcome === 'warn' ? '已完成，有提醒' : '已完成';
    } else if (latestQa?.outcome === 'fail') {
      status = 'retrying';
      activity = latestQa.decisionNote || '准备重试';
    } else if (mine.some((t) => t.status === 'canceled')) {
      // 上游失败导致本镜被取消。绝不能显示成「排队中」——
      // 那看着像还在正常推进，用户会一直等一个永远不会来的结果。
      status = 'needs_human';
      activity = '上游任务失败，这一镜没有开始';
    } else {
      status = 'queued';
      activity = mine.length ? '排队中' : '还没排任务';
    }

    return {
      shotId: row.id,
      idx: row.idx,
      startTime: row.start_time,
      endTime: row.end_time,
      seconds: +(row.end_time - row.start_time).toFixed(2),
      summary: row.summary ?? '',
      characters: safeParse<Array<{ character_id: string }>>(row.actors_json, []).map((a) => a.character_id),
      complexityScore: complexity.score ?? 0,
      needsBlender: Boolean(complexity.needs_blender),
      blenderReasons: complexity.reasons ?? [],
      previsBlocking: complexity.previs?.blocking ?? '',
      previsCameraPath: complexity.previs?.camera_path ?? '',
      status,
      activity,
      attempts: mine.filter((t) => t.type === 'video').length,
      qa,
      estimateCents,
      chargedCents,
      hasClip: clipShots.has(row.id),
    };
  });

  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const succeeded = count('succeeded');
  const activeTask = tasks.find((t) => t.status === 'running') ?? tasks.find((t) => t.status === 'leased');

  return {
    projectId: project.id,
    title: project.title || '未命名项目',
    status: project.status,
    totalSeconds: shots.length ? Math.max(...shots.map((s) => s.endTime)) : 0,
    shots,
    tasks: {
      total: tasks.length,
      succeeded,
      running: count('running') + count('leased'),
      pending: count('pending'),
      dead: count('dead'),
    },
    stage: describeStage(shots, tasks, activeTask, succeeded),
    cost: {
      estimateCents: shots.reduce((n, s) => n + s.estimateCents, 0),
      chargedCents: shots.reduce((n, s) => n + s.chargedCents, 0),
    },
    previs: buildPrevisView(previsRows.results ?? [], shots),
    finalVideo: finalRow
      ? { assetId: finalRow.id, key: finalRow.object_key, seconds: finalRow.duration }
      : undefined,
    blocked: [
      // 项目级失败排在最前：它是根因，逐镜的「上游失败」都是它的后果
      ...tasks.filter((t) => t.status === 'dead' && !t.shot_id).map((t) => ({
        shotId: t.id,
        idx: -1,
        reason: `${TASK_LABEL[t.type] ?? t.type}失败：${t.error_text || '未知原因'}`,
      })),
      ...shots.filter((s) => s.status === 'needs_human')
        .map((s) => ({ shotId: s.shotId, idx: s.idx, reason: s.activity })),
    ],
    updatedAt: project.updated_at,
  };
}

/**
 * 一句话状态。
 * 说的是「现在在干嘛」而不是「有几个任务处于 running」——
 * 用户不关心任务表，他关心还要等多久、有没有出事。
 */
function describeStage(
  shots: ShotView[], tasks: TaskRow[], active: TaskRow | undefined, succeeded: number,
): string {
  if (!tasks.length) return '还没开始';

  // 项目级任务（全片预演、拼接）不属于任何镜头，逐镜统计漏掉它们。
  // 之前正是因为这个漏洞，一次「全片预演崩了」被显示成「排队中」——
  // 看着像还在跑，实际上后面 9 个任务全都永远等不到了。
  const deadProjectTasks = tasks.filter((t) => t.status === 'dead' && !t.shot_id);
  if (deadProjectTasks.length) {
    const what = deadProjectTasks.map((t) => TASK_LABEL[t.type] ?? t.type).join('、');
    return `${what}失败，后续任务无法继续`;
  }

  const blocked = shots.filter((s) => s.status === 'needs_human').length;
  if (blocked) return `${blocked} 个镜头需要你处理`;
  if (succeeded === tasks.length) return '全部完成';
  // 全都终态了但没全成功 = 卡住了，不是还在排队
  const moving = tasks.some((t) => ['pending', 'leased', 'running', 'failed'].includes(t.status));
  if (!moving) {
    const canceled = tasks.filter((t) => t.status === 'canceled').length;
    return canceled ? `已停止，${canceled} 个任务被取消` : '已停止';
  }
  if (active) {
    const shot = shots.find((s) => s.shotId === active.shot_id);
    const label = ACTIVITY[active.type]?.label ?? '处理中';
    return shot ? `第 ${shot.idx + 1} 镜：${label}` : label;
  }
  return '排队中';
}

/** 把 blender_preview 资产整理成页面要的形状。 */
function buildPrevisView(
  rows: Array<{ object_key: string; meta_json: string }>,
  shots: ShotView[],
): PipelineView['previs'] {
  const perShot: Record<string, string> = {};
  let video: { key: string; seconds: number } | undefined;
  let layout: string | undefined;
  let mode: 'full' | 'per_shot' | 'none' = 'none';

  for (const row of rows) {
    const meta = safeParse<{ shotId?: string; mode?: string; durationSeconds?: number }>(row.meta_json, {});
    const isVideo = row.object_key.endsWith('.mp4');
    if (meta.mode === 'full' || !meta.shotId) {
      mode = mode === 'none' ? 'full' : mode;
      if (isVideo) video = { key: row.object_key, seconds: meta.durationSeconds ?? 0 };
      else if (row.object_key.includes('layout')) layout = row.object_key;
    } else if (meta.shotId) {
      mode = mode === 'full' ? 'full' : 'per_shot';
      if (isVideo) perShot[meta.shotId] = row.object_key;
      else if (!layout && row.object_key.includes('layout')) layout = row.object_key;
    }
  }

  // 空间描述存在 Shot DNA 的 complexity.previs 里，取第一个有值的
  const withPrevis = shots.find((s) => s.blenderReasons.length || s.needsBlender);
  return {
    mode, video, layout, perShot,
    blocking: withPrevis?.previsBlocking ?? '',
    cameraPath: withPrevis?.previsCameraPath ?? '',
  };
}

function safeParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/** 项目列表。只取有管线任务的那些。 */
export async function listPipelineProjects(ownerId: string): Promise<Array<{
  id: string; title: string; status: string; shots: number; tasks: number; succeeded: number; updatedAt: number;
}>> {
  const db = await dbReady();
  const res = await db.prepare(
    `SELECT p.id, p.title, p.status, p.updated_at,
            (SELECT COUNT(*) FROM shots WHERE project_id = p.id) AS shots,
            (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS tasks,
            (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'succeeded') AS succeeded
     FROM projects p WHERE p.owner_id = ? ORDER BY p.updated_at DESC LIMIT 50`,
  ).bind(ownerId).all<{ id: string; title: string; status: string; updated_at: number; shots: number; tasks: number; succeeded: number }>();
  return (res.results ?? []).map((r) => ({
    id: r.id, title: r.title || '未命名项目', status: r.status,
    shots: r.shots, tasks: r.tasks, succeeded: r.succeeded, updatedAt: r.updated_at,
  }));
}
