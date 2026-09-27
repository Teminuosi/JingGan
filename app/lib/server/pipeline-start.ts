// 「开始复刻」：把一个已有的分析项目变成一张任务图。
//
// 这是用户在界面上点的那一下背后发生的全部事情：
//   读老项目的 video-dna → 投影成 Shot DNA → 连续性检查并自动修 →
//   复杂度路由 → 排任务图 → 入队
//
// 之后就没人需要再做决定了：worker 自己取活，督导自己处理失败。
//
// 刻意不在这里调用任何 AI：这一步必须是免费且瞬时的，
// 用户点「开始」应该立刻看到镜头列表和费用预估，而不是先等三十秒。

import { MIGRATIONS } from '../../../db/migrations';
import { autoFixContinuity, checkContinuity } from '../continuity/engine';
import { routeShots } from '../complexity/engine';
import { planProject, submitPlan } from '../orchestrator/plan';
import { buildShotDnaList } from '../shot-dna/build';
import type { ShotDna } from '../shot-dna/types';
import { TaskQueue } from '../task/queue';
import type { SavedVideoProject } from '../types';
import { requireDatabase } from './bindings';

let schemaReady = false;
async function dbReady(): Promise<D1Database> {
  const db = requireDatabase();
  if (!schemaReady) {
    await db.batch(MIGRATIONS.map((s) => db.prepare(s)));
    schemaReady = true;
  }
  return db;
}

export interface StartInput {
  ownerId: string;
  /** 老项目 id（video_projects 表）。 */
  legacyProjectId: string;
  project: SavedVideoProject;
  videoModel: string;
  /** hosted 模式传用户 id，走钱包；byok 留空。 */
  userId?: string;
  /** 3D 预演模式。全片 / 逐镜 / 关。 */
  previsMode?: 'full' | 'per_shot' | 'off';
}

export interface StartResult {
  projectId: string;
  shotCount: number;
  taskCount: number;
  blenderShots: number;
  keyframeShots: number;
  previsMode: 'full' | 'per_shot' | 'off';
  /** 要渲多少条预演。全片模式恒为 1。 */
  previsClips: number;
  estimateCents: number;
  /** 连续性引擎自动修了哪些。要告诉用户，不能悄悄改。 */
  autoFixed: Array<{ shotId: string; message: string }>;
  /** 需要人看一眼的连续性问题。 */
  continuityIssues: Array<{ shotId: string; severity: string; message: string }>;
}

/** 每秒单价，用于预估。真实扣费以 Provider 返回为准，这里只给用户一个数量级。 */
const CENTS_PER_SECOND: Record<string, number> = {
  'bytedance/seedance-2.5': 1028,   // 实测 $0.1028/秒 @480p，单位是百分之一分
  'minimax/hailuo-3': 490,
  'mock/video': 100,
};

export async function startPipeline(input: StartInput): Promise<StartResult> {
  const db = await dbReady();
  const now = Date.now();
  const projectId = `pl_${input.legacyProjectId}`;

  // ---- 项目行 ----
  // owner 也要有一行：shots → projects → users 是一条外键链，缺一环整条排不进去。
  await db.prepare(
    `INSERT OR IGNORE INTO users (id,email,display_name,role,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(input.ownerId, '', input.ownerId, 'user', 'active', now, now).run();

  await db.prepare(
    `INSERT INTO projects (id,owner_id,title,status,source_duration,aspect_ratio,legacy_project_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`,
  ).bind(
    projectId, input.ownerId, input.project.title, 'analyzing',
    input.project.analysis.source.duration_seconds, input.project.analysis.source.aspect_ratio,
    input.legacyProjectId, now, now,
  ).run();

  // ---- 角色表：提示词编译要靠它把 ROLE_* 翻成「四十岁男性，寸头」 ----
  const bible = input.project.creativePack?.character_bible ?? [];
  const roles = input.project.analysis.source_roles;
  for (const [i, role] of roles.entries()) {
    const character = bible[i];
    await db.prepare(
      `INSERT OR REPLACE INTO characters (id,project_id,source_role_id,name,profile_json,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(
      `${projectId}-${role.role_id}`, projectId, role.role_id,
      character?.character_id ?? role.role_id,
      JSON.stringify({
        appearance: character?.appearance ?? role.generalized_appearance,
        wardrobe: character?.wardrobe ?? role.wardrobe_logic,
        referenceSlot: `图${i + 1}`,
      }),
      now,
    ).run();
  }

  // 风格锁：每镜提示词都要带，否则镜与镜之间画风会漂
  const style = input.project.creativePack?.style_lock;
  await db.prepare(
    `INSERT OR REPLACE INTO system_config (key,value_json,scope,updated_at) VALUES (?,?,?,?)`,
  ).bind('style_lock', JSON.stringify({
    pacing: style?.pacing ?? '', camera: style?.camera ?? '',
    visual: style?.visual ?? input.project.analysis.style_dna.visual.medium,
    performance: style?.performance ?? '', sound: style?.sound ?? '',
    negativeConstraints: style?.negative_constraints ?? [],
    dialogueLanguage: input.project.brief.outputLanguage || '中文',
  }), projectId, now).run();

  // ---- 投影出 Shot DNA ----
  // 优先用创作层的分镜（已换角色、已改台词）；没有就用源分析的。
  const pack = input.project.creativePack;
  const beats = pack?.beats?.length ? pack.beats : input.project.analysis.beats;
  let shots: ShotDna[] = buildShotDnaList(
    { ...input.project.analysis, beats: beats as never },
    projectId,
    { shotId: undefined },
  );
  // shot_id 用项目前缀，避免不同项目的 beat_id 撞车。
  // 分隔符必须用 `-` 不能用 `:`：shot_id 会被拼进对象存储的 key，
  // 而 Windows 路径里 `:` 是盘符分隔符，mkdir 会直接 ENOENT——
  // 报出来的错还是「找不到目录」，跟真正的原因差着十万八千里。
  shots = shots.map((s, i) => ({ ...s, shot_id: `${projectId}-s${i}`, idx: i }));

  // ---- 连续性：先查，能确定的自动修，改了什么要告诉用户 ----
  const issues = checkContinuity(shots);
  const fixed = autoFixContinuity(shots, issues);
  shots = fixed.shots;

  for (const dna of shots) await saveShotDna(db, dna);

  // ---- 复杂度路由 ----
  const routed = routeShots(shots);
  for (const r of routed) {
    await db.prepare('UPDATE shot_dna SET complexity_json = ? WHERE shot_id = ?')
      .bind(JSON.stringify({
        score: r.complexity.score,
        factors: r.complexity.factors,
        needs_blender: r.complexity.needsBlender,
        reasons: r.complexity.reasons,
      }), r.shotId).run();
  }

  // ---- 排任务图 ----
  const plan = planProject({
    projectId,
    needsPreprocess: false,   // 源片已经在老项目里分析过了
    needsAnalyze: false,
    videoModel: input.videoModel,
    userId: input.userId,
    previsMode: input.previsMode ?? 'off',
    shots: routed.map(({ shotId, idx, seconds, needsBlender, needsKeyframe, revision }) =>
      ({ shotId, idx, seconds, needsBlender, needsKeyframe, revision })),
  });
  const rows = await submitPlan(new TaskQueue(db), plan);

  const perSecond = CENTS_PER_SECOND[input.videoModel] ?? 100;
  const estimateCents = Math.ceil(
    routed.reduce((sum, r) => sum + (perSecond * r.seconds) / 100, 0),
  );

  return {
    projectId,
    shotCount: shots.length,
    taskCount: rows.length,
    previsMode: input.previsMode ?? 'off',
    previsClips: input.previsMode === 'full' ? 1
      : input.previsMode === 'per_shot' ? routed.length
      : routed.filter((r) => r.needsBlender).length,
    blenderShots: routed.filter((r) => r.needsBlender).length,
    keyframeShots: routed.filter((r) => r.needsKeyframe).length,
    estimateCents,
    autoFixed: fixed.applied.map((i) => ({ shotId: i.shotId, message: i.message })),
    continuityIssues: issues
      .filter((i) => !fixed.applied.includes(i))
      .map((i) => ({ shotId: i.shotId, severity: i.severity, message: i.message })),
  };
}

async function saveShotDna(db: D1Database, dna: ShotDna): Promise<void> {
  const t = Date.now();
  await db.prepare(
    `INSERT OR REPLACE INTO shots (id,project_id,scene_id,idx,start_time,end_time,duration,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(dna.shot_id, dna.project_id, dna.scene_id, dna.idx, dna.start_time, dna.end_time,
    +(dna.end_time - dna.start_time).toFixed(3), t, t).run();

  await db.prepare(
    `INSERT OR REPLACE INTO shot_dna (shot_id,project_id,schema_version,narrative_function,summary,
       dialogue_json,sound,transition_in,camera_json,actors_json,objects_json,environment_json,
       lighting_json,action_timeline,expression_timeline,continuity_json,visual_style_json,
       complexity_json,corrected_by_user,revision,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    dna.shot_id, dna.project_id, dna.schema_version, dna.narrative_function, dna.summary,
    JSON.stringify(dna.dialogue), dna.sound, dna.transition_in,
    JSON.stringify(dna.camera), JSON.stringify(dna.actors), JSON.stringify(dna.objects),
    JSON.stringify(dna.environment), JSON.stringify(dna.lighting),
    JSON.stringify(dna.action_timeline), JSON.stringify(dna.expression_timeline),
    JSON.stringify(dna.continuity), JSON.stringify(dna.visual_style), JSON.stringify(dna.complexity),
    dna.corrected_by_user ? 1 : 0, dna.revision, t, t,
  ).run();
}
