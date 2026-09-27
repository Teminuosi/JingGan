// 任务与项目的状态机。
//
// 规格第十九章要求「不要用大量 if else 判断任务进度」。做法是：
// 合法的状态迁移写成一张表，任何迁移都必须查表通过；非法迁移直接抛错，
// 而不是让错误状态悄悄写进库里，等到几天后对不上账才发现。
//
// 每一次迁移都要写 task_events，排查时能还原整条时间线。

/** 项目级状态。用户在前端看到的进度条就是按它分段的。 */
export const PROJECT_STATUSES = [
  'created',
  'uploaded',
  'preprocessing',
  'analyzing',
  'dna_ready',
  'keyframe_generating',
  'blender_pending',
  'blender_rendering',
  'video_generating',
  'quality_checking',
  'retrying',
  'merging',
  'completed',
  'failed',
  'canceled',
] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];

/** 单个任务的状态。队列只认 pending。 */
export const TASK_STATUSES = [
  'pending',      // 在队列里等认领
  'leased',       // 已被某个 worker 认领，租约未到期
  'running',      // worker 正在执行（有心跳）
  'succeeded',
  'failed',       // 还能重试
  'dead',         // 重试用尽，进死信
  'canceled',
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

/** 任务类型。每一种对应一个 worker。 */
export const TASK_TYPES = [
  'preprocess',      // FFmpeg：探测元数据、切片、抽帧
  'analyze',         // Gemini：产出 Shot DNA
  'keyframe',        // 图片模型：首/尾关键帧
  'blender',         // Blender：3D Previs
  'video',           // 视频模型：出片
  'qa',              // 质检
  'merge',           // FFmpeg：拼接
] as const;
export type TaskType = typeof TASK_TYPES[number];

/**
 * 合法迁移表。键是当前状态，值是允许迁到的状态。
 *
 * 几条刻意的约束：
 * - succeeded 是终态，不允许再迁走。已经成功并计过费的任务被改回 pending，
 *   会导致重复执行和重复扣费——这是最贵的一类 bug，直接从状态机层面堵死。
 * - failed 可以回 pending（重试），也可以进 dead（重试用尽）。
 * - dead 允许人工回 pending：后台「重试失败任务」要用，但必须是人工动作。
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['leased', 'canceled'],
  leased: ['running', 'pending', 'failed', 'canceled'],  // 回 pending = 租约过期被回收
  running: ['succeeded', 'failed', 'pending', 'canceled'],
  succeeded: [],
  failed: ['pending', 'dead', 'canceled'],
  dead: ['pending'],
  canceled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransition extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus, readonly taskId: string) {
    super(`任务 ${taskId} 不允许从 ${from} 迁移到 ${to}`);
    this.name = 'IllegalTransition';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus, taskId: string): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to, taskId);
}

/** 终态：不会再被队列碰，也不会再产生费用。 */
export function isTerminal(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0 || status === 'dead';
}

/**
 * 失败分类。规格第十八章要求「不同错误采用不同策略」，
 * 分类本身必须是有限集合，否则下游的重试策略没法穷举。
 */
export const FAILURE_CLASSES = [
  'provider_rejected',   // 上游明确拒绝（参数不合法、模型不存在）→ 改参数，别重试
  'provider_unavailable',// 渠道不存在 / 限流 / 5xx → 换 provider 或退避重试
  'timeout',             // 超时，不知道对面收没收 → 必须先查再重试
  'identity_drift',      // 人脸/形象崩 → 重生成关键帧
  'motion_wrong',        // 动作不对 → 重写 motion prompt
  'camera_wrong',        // 镜头不对 → 加强 camera reference
  'spatial_wrong',       // 空间/走位错 → 启用 Blender
  'popin',               // 人物突然出现 → 改 timeline 或启用 Blender
  'minor_artifact',      // 轻微瑕疵 → 原样重跑
  'insufficient_balance',// 余额不足 → 停，不重试
  'internal',            // 我们自己的 bug
  'unknown',
] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];

/** 这一类失败该不该自动重试。余额不足和参数被拒重试多少次都一样。 */
export function isRetryable(cls: FailureClass): boolean {
  return !['provider_rejected', 'insufficient_balance'].includes(cls);
}

/** 指数退避，带上限。用于 run_after。 */
export function backoffMs(attempt: number, baseMs = 5_000, capMs = 5 * 60_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
