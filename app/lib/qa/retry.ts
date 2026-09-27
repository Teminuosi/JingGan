// 智能重试引擎。
//
// 规格第十八章：不同错误采用不同策略。
//
// 这一层存在的全部理由是：**原样重跑基本没用，而且每次都要钱。**
// 视频模型是有随机性，但形象崩了、动作没演、空间错了这些问题，
// 换个 seed 再跑一遍大概率还是同样的结果——因为根因在提示词和参考图，不在随机数。
//
// 所以每一次重试都必须「换了点什么」：加强提示词、换参考图、启用 Blender、降复杂度。
// 换不动了就停手，把镜头交给人，而不是把用户的余额烧完。
//
// 一条硬规则：**同一个策略不重复用**。第二次还用「原样重跑」就是在骗自己。

import type { FailureClass } from '../task/states';
import type { QaReport } from './report';

export type RetryStrategy =
  | 'regenerate_same'        // 原样重跑：只对随机性瑕疵有效
  | 'reinforce_prompt'       // 加强提示词对应段落
  | 'regenerate_keyframe'    // 重生成关键帧再出片（形象崩了的主要解法）
  | 'enable_blender'         // 上 3D 预演（空间/走位错的解法）
  | 'split_shot'             // 拆镜：把太复杂的一镜拆成两镜
  | 'switch_provider'        // 换上游
  | 'reduce_complexity'      // 砍动作密度/降时长
  | 'manual';                // 交给人

export interface RetryDecision {
  strategy: RetryStrategy;
  /** 给 Prompt Compiler 的 retryHint。 */
  failureClass: FailureClass;
  note: string;
  /** 要不要重新生成关键帧。 */
  regenerateKeyframe: boolean;
  /** 要不要启用 Blender。 */
  enableBlender: boolean;
  /** 要不要换 Provider。 */
  switchProvider: boolean;
  /** 要不要换 seed。原样重跑必须换，否则确定性模型会给出完全一样的结果。 */
  newSeed: boolean;
  /** 人读的解释，显示在进度页上。 */
  explanation: string;
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  /** 已经用过的策略。同一个策略不重复用。 */
  usedStrategies: RetryStrategy[];
  /** 这一镜当前是否已启用 Blender。已经用了就不能再拿它当新策略。 */
  blenderEnabled: boolean;
  /** 还有没有备用 Provider。 */
  hasFallbackProvider: boolean;
  /** 这一镜能不能拆（时长够长、拍点够多）。 */
  splittable: boolean;
}

/** 每种失败分类的策略优先级。排在前面的先试。 */
const LADDER: Record<FailureClass, RetryStrategy[]> = {
  // 形象崩：根因在参考图，先重做关键帧，再加强提示词
  identity_drift: ['regenerate_keyframe', 'reinforce_prompt', 'regenerate_same'],
  // 动作不对：先加强时间轴描述，还不行就降密度或拆镜
  motion_wrong: ['reinforce_prompt', 'reduce_complexity', 'split_shot'],
  // 镜头不对：加强机位段，不行就上 Blender 锁机位路径
  camera_wrong: ['reinforce_prompt', 'enable_blender'],
  // 空间错：这就是 Blender 存在的意义，直接上
  spatial_wrong: ['enable_blender', 'reinforce_prompt', 'split_shot'],
  // pop-in：先在提示词里交代入画，不行就用 Blender 固定走位
  popin: ['reinforce_prompt', 'enable_blender'],
  // 轻微瑕疵：换个 seed 原样重跑确实有效，这是唯一适用它的场景
  minor_artifact: ['regenerate_same', 'reinforce_prompt'],
  // 上游问题：换家，或者退避重试
  provider_unavailable: ['switch_provider', 'regenerate_same'],
  // 参数被拒：重试多少次都一样，只能改参数——交给人
  provider_rejected: ['manual'],
  timeout: ['regenerate_same', 'switch_provider'],
  insufficient_balance: ['manual'],
  internal: ['manual'],
  unknown: ['regenerate_same', 'reinforce_prompt', 'manual'],
};

const EXPLAIN: Record<RetryStrategy, string> = {
  regenerate_same: '换一个随机种子重跑',
  reinforce_prompt: '在提示词里加强对应部分后重跑',
  regenerate_keyframe: '先重新生成关键帧，再用新关键帧出片',
  enable_blender: '启用 3D 预演把空间关系锁死，再出片',
  split_shot: '把这一镜拆成两段分别生成',
  switch_provider: '换一家上游重试',
  reduce_complexity: '减少同镜动作数量后重跑',
  manual: '自动手段已用尽，需要人工处理',
};

/**
 * 决定这一次重试怎么打。
 *
 * 返回 manual 就意味着停手。停手比接着烧钱重要——
 * 一个镜头连着失败三次还在自动重试，用户看到的是余额在掉而片子还是废的。
 */
export function decideRetry(report: QaReport, ctx: RetryContext): RetryDecision {
  const cls = report.primaryFailure ?? 'unknown';

  if (ctx.attempt >= ctx.maxAttempts) {
    return manual(cls, `已重试 ${ctx.attempt} 次，达到上限`);
  }

  const used = new Set(ctx.usedStrategies);
  for (const strategy of LADDER[cls] ?? LADDER.unknown) {
    if (used.has(strategy)) continue;                                   // 同一招不用两次
    if (strategy === 'enable_blender' && ctx.blenderEnabled) continue;   // 已经在用了，不算新招
    if (strategy === 'switch_provider' && !ctx.hasFallbackProvider) continue;
    if (strategy === 'split_shot' && !ctx.splittable) continue;
    if (strategy === 'manual') break;

    return {
      strategy,
      failureClass: cls,
      note: noteFor(strategy, report),
      regenerateKeyframe: strategy === 'regenerate_keyframe',
      enableBlender: strategy === 'enable_blender',
      switchProvider: strategy === 'switch_provider',
      // 不换点什么就必须换 seed，否则确定性的上游会原样再给一遍同样的废片
      newSeed: strategy === 'regenerate_same',
      explanation: `${describeFailure(report)}，${EXPLAIN[strategy]}`,
    };
  }

  return manual(cls, '可用的自动策略都试过了');
}

function manual(cls: FailureClass, why: string): RetryDecision {
  return {
    strategy: 'manual', failureClass: cls, note: '',
    regenerateKeyframe: false, enableBlender: false, switchProvider: false, newSeed: false,
    explanation: `${why}，${EXPLAIN.manual}`,
  };
}

/** 给 Prompt Compiler 的补充提示：把质检发现的具体问题写进去，比泛泛的加强语有用得多。 */
function noteFor(strategy: RetryStrategy, report: QaReport): string {
  if (strategy !== 'reinforce_prompt' && strategy !== 'reduce_complexity') return '';
  return report.findings
    .filter((f) => f.verdict === 'fail')
    .map((f) => f.message)
    .join('；')
    .slice(0, 300);
}

function describeFailure(report: QaReport): string {
  const first = report.findings.find((f) => f.verdict === 'fail');
  return first ? first.message : '质检未通过';
}

/**
 * 这一镜到此为止花了多少、还值不值得再试。
 *
 * 规格第廿二章要求「避免任务失败仍扣全款、重试无限扣钱」。
 * 这里定的是硬闸：重试的累计成本不许超过原始预估的若干倍，
 * 超了就停手交给人——否则一个顽固的镜头能把整单的利润吃光。
 */
export function withinRetryBudget(
  spentCents: number,
  originalEstimateCents: number,
  multiplier = 3,
): { ok: boolean; reason?: string } {
  const cap = originalEstimateCents * multiplier;
  if (spentCents <= cap) return { ok: true };
  return {
    ok: false,
    reason: `这一镜已累计花费 ${(spentCents / 100).toFixed(2)}，超过预估 ${(originalEstimateCents / 100).toFixed(2)} 的 ${multiplier} 倍上限，停止自动重试`,
  };
}
