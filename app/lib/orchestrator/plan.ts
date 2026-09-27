// 任务编排。
//
// 规格第二章：用户只做四件事（上传、设参数、点开始、等），其余全自动。
// 这个文件就是「点开始」之后发生的全部——把一个项目展开成一张带依赖的任务图，
// 然后交给队列。之后没有任何人需要再决定下一步做什么：
// 一个任务成功，它的下游依赖自动满足，worker 自己就取走了。
//
// 为什么一次性把图建完，而不是每步跑完再决定下一步：
//  - 图建完了，进度就是可算的（成功数/总数），用户能看到真实进度条而不是转圈；
//  - 预估费用也是可算的，能在扣钱之前告诉用户这一单要花多少；
//  - 崩溃恢复不需要「重新推导进行到哪了」，图还在库里，接着跑就是。
//
// 幂等键的构造是这张图的命根子：`${projectId}:${type}:${shotId}:${revision}`。
// 用户狂点「开始」十次，也只会有一份任务图。

import type { TaskQueue, TaskRow } from '../task/queue';
import type { TaskType } from '../task/states';

export interface PlanShotInput {
  shotId: string;
  idx: number;
  seconds: number;
  /** 复杂度路由的结果。true 则先跑 Blender 预演，视频任务依赖它。 */
  needsBlender: boolean;
  /** 需要先生成首帧关键帧。首镜或换场镜通常需要。 */
  needsKeyframe: boolean;
  /** Shot DNA 的修订号，进幂等键——DNA 被人工改过就该重跑，而不是命中旧任务。 */
  revision: number;
}

export interface PlanInput {
  projectId: string;
  shots: PlanShotInput[];
  /** 是否已经有源视频的预处理产物（切片、元数据）。没有就先排一个 preprocess。 */
  needsPreprocess: boolean;
  /** 分析任务。已经有 Shot DNA 时（比如老项目投影过来的）可以跳过。 */
  needsAnalyze: boolean;
  /** 出片用哪一档模型。写进任务输入，重试时也能看出当初用的是哪一档。 */
  videoModel?: string;
  /** 付费用户；byok 模式留空，出片时不走钱包。 */
  userId?: string;
  /**
   * 3D 预演模式：
   *  - `full`     全片渲成一条 MP4，出片时按镜切段当参考视频。运镜和走位锁得最死。
   *  - `per_shot` 每镜单独预演。渲得快，但镜与镜之间的空间连续性没有保证。
   *  - `off`      不做预演。
   * 缺省 off——预演要花渲染时间，不该默默替用户决定。
   */
  previsMode?: 'full' | 'per_shot' | 'off';
  traceId?: string;
}

export interface PlannedTask {
  type: TaskType;
  idempotencyKey: string;
  shotId?: string;
  dependsOn: string[];   // 这里存的是幂等键，落库前再换成真实 task id
  priority: number;
  input: Record<string, unknown>;
}

/**
 * 把项目展开成任务图（纯函数，不碰数据库）。
 * 拆成纯函数是为了能直接对图本身断言——「拼接是不是依赖了全部镜头」这种事
 * 不该等到跑起来才发现。
 */
export function planProject(input: PlanInput): PlannedTask[] {
  const { projectId } = input;
  const key = (type: string, scope = '') => `${projectId}:${type}${scope ? `:${scope}` : ''}`;
  const tasks: PlannedTask[] = [];

  const preprocessKey = key('preprocess');
  if (input.needsPreprocess) {
    tasks.push({ type: 'preprocess', idempotencyKey: preprocessKey, dependsOn: [], priority: 10, input: { projectId } });
  }

  const analyzeKey = key('analyze');
  if (input.needsAnalyze) {
    tasks.push({
      type: 'analyze', idempotencyKey: analyzeKey,
      dependsOn: input.needsPreprocess ? [preprocessKey] : [],
      priority: 20, input: { projectId },
    });
  }

  const upstreamOfShots = input.needsAnalyze ? [analyzeKey] : (input.needsPreprocess ? [preprocessKey] : []);
  const videoKeys: string[] = [];

  // 全片预演：一个不带 shotId 的 blender 任务，所有出片都等它。
  // 不带 shotId 正是 handler 用来区分「全片」和「单镜」的依据。
  const filmPrevisKey = key('blender', 'film');
  const previsMode = input.previsMode ?? 'off';
  if (previsMode === 'full') {
    tasks.push({
      type: 'blender', idempotencyKey: filmPrevisKey,
      dependsOn: [...upstreamOfShots], priority: 50,
      input: { projectId, mode: 'full' },
    });
  }

  for (const shot of input.shots) {
    const scope = `${shot.shotId}:r${shot.revision}`;
    const deps: string[] = [...upstreamOfShots];

    if (shot.needsKeyframe) {
      const kfKey = key('keyframe', scope);
      tasks.push({
        type: 'keyframe', idempotencyKey: kfKey, shotId: shot.shotId,
        dependsOn: [...upstreamOfShots],
        // 优先级用 100 + 镜号：同类任务按镜头顺序跑，用户看到的进度才是从头往后推进的，
        // 而不是第 7 镜先好了、第 2 镜还在等。
        priority: 100 + shot.idx, input: { projectId, shotId: shot.shotId },
      });
      deps.push(kfKey);
    }

    // 逐镜预演：模式说了算。
    // 以前是按复杂度评分自动挑几镜，现在不了——要不要花这份渲染时间是用户的决定，
    // 复杂度分数照样算、照样显示，但只作为参考信息，不再替他拍板。
    if (previsMode === 'per_shot') {
      const bKey = key('blender', scope);
      tasks.push({
        type: 'blender', idempotencyKey: bKey, shotId: shot.shotId,
        dependsOn: [...upstreamOfShots],
        priority: 90 + shot.idx, input: { projectId, shotId: shot.shotId, mode: 'per_shot' },
      });
      deps.push(bKey);
    }
    if (previsMode === 'full') deps.push(filmPrevisKey);

    const vKey = key('video', scope);
    tasks.push({
      type: 'video', idempotencyKey: vKey, shotId: shot.shotId,
      dependsOn: deps, priority: 200 + shot.idx,
      input: {
        projectId, shotId: shot.shotId, seconds: shot.seconds,
        model: input.videoModel ?? 'mock/video',
        previsMode,
        ...(input.userId ? { userId: input.userId } : {}),
      },
    });

    const qKey = key('qa', scope);
    tasks.push({
      type: 'qa', idempotencyKey: qKey, shotId: shot.shotId,
      dependsOn: [vKey], priority: 300 + shot.idx,
      input: { projectId, shotId: shot.shotId },
    });
    // 拼接依赖质检而不是出片：没过质检的镜头会被重试引擎换掉，
    // 直接依赖出片会把废片拼进成片里。
    videoKeys.push(qKey);
  }

  if (videoKeys.length) {
    tasks.push({
      type: 'merge', idempotencyKey: key('merge', `n${videoKeys.length}`),
      dependsOn: videoKeys, priority: 900, input: { projectId },
    });
  }

  return tasks;
}

/**
 * 把任务图落库。先全部入队拿到真实 id，再补依赖边——
 * 依赖的目标可能排在自己后面（merge 依赖所有 qa），一趟写不完。
 */
export async function submitPlan(queue: TaskQueue, plan: PlannedTask[], traceId?: string): Promise<TaskRow[]> {
  const byKey = new Map<string, TaskRow>();
  for (const t of plan) {
    const row = await queue.enqueue({
      type: t.type, idempotencyKey: t.idempotencyKey, shotId: t.shotId,
      projectId: String(t.input.projectId ?? ''), input: t.input, priority: t.priority, traceId,
    });
    byKey.set(t.idempotencyKey, row);
  }
  for (const t of plan) {
    if (!t.dependsOn.length) continue;
    const self = byKey.get(t.idempotencyKey);
    if (!self) continue;
    const ids = t.dependsOn.map((k) => byKey.get(k)?.id).filter((id): id is string => Boolean(id));
    if (ids.length) await queue.addDependencies(self.id, ids);
  }
  return [...byKey.values()];
}

export interface ProjectProgress {
  total: number;
  succeeded: number;
  running: number;
  pending: number;
  failed: number;
  dead: number;
  canceled: number;
  percent: number;
  /** 当前正在做什么，给用户看的一句话。 */
  stage: string;
  /** 卡住的任务。非空说明需要人介入。 */
  blocked: TaskRow[];
}

const STAGE_LABEL: Record<TaskType, string> = {
  preprocess: '正在处理源视频',
  analyze: '正在分析镜头',
  keyframe: '正在生成关键帧',
  blender: '正在做 3D 预演',
  video: '正在生成视频',
  qa: '正在质检',
  merge: '正在拼接成片',
};

/**
 * 从任务表算进度。
 * 刻意不单独维护一个 progress 字段：那需要在每处状态变更时同步更新，
 * 漏一处就永远对不上。从任务表现算，慢一点，但不会说谎。
 */
export function projectProgress(tasks: TaskRow[]): ProjectProgress {
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const succeeded = count('succeeded');
  const total = tasks.length;
  const active = tasks.find((t) => t.status === 'running') ?? tasks.find((t) => t.status === 'leased');
  const dead = count('dead');

  return {
    total,
    succeeded,
    running: count('running') + count('leased'),
    pending: count('pending'),
    failed: count('failed'),
    dead,
    canceled: count('canceled'),
    percent: total ? Math.round((succeeded / total) * 100) : 0,
    stage: dead && !active ? '有任务失败，等待处理'
      : active ? STAGE_LABEL[active.type] ?? active.type
      : succeeded === total && total ? '已完成' : '排队中',
    blocked: tasks.filter((t) => t.status === 'dead'),
  };
}
