// 重试督导。
//
// 这是把质检和重试引擎接成闭环的那一环，也是整条管线里最后一块「自动」。
// 没有它，质检算出了结论、重试引擎知道该怎么打，但没人去执行——
// 用户看到的是「质检说这镜废了」然后管线停在那儿。
//
// 它做的事：
//   找出质检判废的镜头 → 问重试引擎该换什么打法 → 按打法重新排任务 → 把新任务挂进依赖图
//
// 三条必须守住的规则：
//
//  1. **新任务的幂等键必须带重试轮次**。不带的话第二次重试会命中第一次的任务，
//     队列直接返回那个已经 succeeded 的旧任务，于是什么都不会发生——
//     管线看起来在跑，实际上死循环空转。
//
//  2. **拼接必须挂上新的质检任务作为依赖**。老的质检任务已经 succeeded 了
//     （它成功地完成了「判定」这件事），光靠它挡不住拼接。
//
//  3. **该停手时停手**。次数用尽、策略用尽、成本超闸，都要停下来交给人，
//     而不是接着烧余额。停手之后拼接会明确失败并说清是哪几镜，
//     绝不静默交一条把废镜头拼进去的成片。

import type { TaskQueue } from '../task/queue';
import { decideRetry, withinRetryBudget, type RetryDecision, type RetryStrategy } from '../qa/retry';
import type { QaReport } from '../qa/report';

/** 督导需要的数据访问。与 handler 一样走注入，便于测试。 */
export interface SupervisorRepo {
  /** 本项目所有镜头的最新质检结论。 */
  latestQa(projectId: string): Promise<Array<{ shotId: string; report: QaReport }>>;
  /** 这一镜历史上用过哪些重试策略。同一招不用两次全靠它。 */
  usedStrategies(shotId: string): Promise<RetryStrategy[]>;
  /** 这一镜到目前为止花了多少分，以及最初的预估。成本闸用。 */
  spending(shotId: string): Promise<{ spentCents: number; estimateCents: number }>;
  /** 记录这次的处置决定，后台能看出系统为什么这么做。 */
  recordDecision(shotId: string, report: QaReport, decision: RetryDecision): Promise<void>;
  /** 这一镜当前是否已启用 Blender。 */
  blenderEnabled(shotId: string): Promise<boolean>;
  /** 镜头时长与拍点数，用来判断能不能拆镜。 */
  shotShape(shotId: string): Promise<{ seconds: number; actionBeats: number; revision: number }>;
}

export interface SupervisorOptions {
  projectId: string;
  /** 每一镜最多自动重试几次。 */
  maxAttempts?: number;
  /** 还有没有备份 Provider 可换。 */
  hasFallbackProvider?: boolean;
  /** 重试累计成本上限（原始预估的倍数）。 */
  budgetMultiplier?: number;
  /** 出片模型。重排出片任务时要带上。 */
  videoModel?: string;
  userId?: string;
  log?: (line: string) => void;
}

export interface SupervisorResult {
  /** 这一轮重新排了几镜。 */
  retried: Array<{ shotId: string; strategy: RetryStrategy; explanation: string }>;
  /** 已经放弃、需要人工处理的镜头。 */
  giveUp: Array<{ shotId: string; reason: string }>;
}

export class RetrySupervisor {
  constructor(
    private readonly queue: TaskQueue,
    private readonly repo: SupervisorRepo,
  ) {}

  /**
   * 巡检一遍。由 worker 循环定期调用，和 reclaimExpired 一样。
   * 幂等：同一个判废结果重复巡检不会排出第二套任务（靠幂等键挡住）。
   */
  async reconcile(opts: SupervisorOptions): Promise<SupervisorResult> {
    const log = opts.log ?? (() => {});
    const result: SupervisorResult = { retried: [], giveUp: [] };

    for (const { shotId, report } of await this.repo.latestQa(opts.projectId)) {
      if (report.verdict !== 'fail') continue;

      // 上一次重试还在飞就别再排了。
      // 判废的结论要等新的质检报告出来才会更新，在那之前每轮巡检看到的都是同一份 fail，
      // 不挡住的话同一镜会同时有好几条重试链在跑——钱翻倍花，最后还不知道该用哪一份成片。
      if (await this.queue.hasActiveWork(opts.projectId, shotId)) continue;

      // ---- 成本闸优先于一切。哪怕还有招可用，钱到线了也得停。 ----
      const { spentCents, estimateCents } = await this.repo.spending(shotId);
      const budget = withinRetryBudget(spentCents, estimateCents, opts.budgetMultiplier);
      if (!budget.ok) {
        result.giveUp.push({ shotId, reason: budget.reason ?? '超出重试预算' });
        log(`${shotId} 停止重试：${budget.reason}`);
        continue;
      }

      const used = await this.repo.usedStrategies(shotId);
      const shape = await this.repo.shotShape(shotId);
      const decision = decideRetry(report, {
        attempt: used.length + 1,
        maxAttempts: opts.maxAttempts ?? 3,
        usedStrategies: used,
        blenderEnabled: await this.repo.blenderEnabled(shotId),
        hasFallbackProvider: opts.hasFallbackProvider ?? false,
        // 能拆镜的前提是它确实长、且有拍点可以下刀——
        // 对一个 4 秒单拍的镜头说「拆成两段」是没有意义的建议。
        splittable: shape.seconds >= 8 && shape.actionBeats >= 2,
      });

      await this.repo.recordDecision(shotId, report, decision);

      if (decision.strategy === 'manual') {
        result.giveUp.push({ shotId, reason: decision.explanation });
        log(`${shotId} 交人工：${decision.explanation}`);
        continue;
      }

      await this.scheduleRetry(shotId, used.length + 1, shape.revision, decision, opts);
      result.retried.push({ shotId, strategy: decision.strategy, explanation: decision.explanation });
      log(`${shotId} 第 ${used.length + 1} 次重试：${decision.explanation}`);
    }

    return result;
  }

  /**
   * 按决定重新排任务。
   *
   * 排的是一整条小链：[关键帧] → [Blender] → 出片 → 质检，
   * 然后把新的质检挂成拼接的依赖。
   */
  private async scheduleRetry(
    shotId: string,
    round: number,
    revision: number,
    decision: RetryDecision,
    opts: SupervisorOptions,
  ): Promise<void> {
    const { projectId } = opts;
    // 轮次一定要进幂等键。不带的话第二次重试会命中第一次那个已经 succeeded 的任务，
    // 队列原样返回它，什么都不会发生——管线看着在跑，其实在空转。
    const scope = `${shotId}:r${revision}:retry${round}`;
    const deps: string[] = [];

    if (decision.regenerateKeyframe) {
      const kf = await this.queue.enqueue({
        type: 'keyframe', idempotencyKey: `${projectId}:keyframe:${scope}`,
        projectId, shotId, priority: 100,
        input: { projectId, shotId, retryRound: round },
      });
      deps.push(kf.id);
    }

    if (decision.enableBlender) {
      const bl = await this.queue.enqueue({
        type: 'blender', idempotencyKey: `${projectId}:blender:${scope}`,
        projectId, shotId, priority: 90,
        input: { projectId, shotId, retryRound: round },
      });
      deps.push(bl.id);
    }

    const video = await this.queue.enqueue({
      type: 'video', idempotencyKey: `${projectId}:video:${scope}`,
      projectId, shotId, priority: 200,
      input: {
        projectId, shotId,
        model: opts.videoModel ?? 'mock/video',
        ...(opts.userId ? { userId: opts.userId } : {}),
        // 提示词由出片 handler 现编，retryHint 会让它加强对应段落。
        // 这就是「换了点什么」的具体内容——没有它这次重试和上次没区别。
        retryHint: { failureClass: decision.failureClass, note: decision.note },
        ...(decision.newSeed ? { seed: Date.now() % 2_147_483_647 } : {}),
      },
    });
    if (deps.length) await this.queue.addDependencies(video.id, deps);

    const qa = await this.queue.enqueue({
      type: 'qa', idempotencyKey: `${projectId}:qa:${scope}`,
      projectId, shotId, priority: 300,
      input: { projectId, shotId, retryRound: round },
    });
    await this.queue.addDependencies(qa.id, [video.id]);

    // 拼接必须等这次新的质检。老的质检任务已经 succeeded 了
    // （它成功地完成了「判定」），光靠它挡不住拼接。
    const tasks = await this.queue.listByProject(projectId);
    const merge = tasks.find((t) => t.type === 'merge');
    if (merge) await this.queue.addDependencies(merge.id, [qa.id]);
  }
}
