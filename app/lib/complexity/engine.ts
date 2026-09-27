// 复杂度分析与 Blender 路由。
//
// 规格第七章。要回答的问题只有一个：**这一镜能不能直接交给视频模型？**
//
// 视频模型擅长「一两个人、固定或简单运镜、动作单一」的镜头。
// 一旦出现多人走位交叉、复杂运镜、精确的空间关系（谁必须在谁左后方），
// 它就开始自由发挥——人物穿模、位置乱跳、运镜完全不照做。
// 这类镜头先用 Blender 摆一遍 3D 预演，把空间关系固定下来再喂给模型，成片率高得多。
//
// 但 Blender 很贵（渲染时间 + 复杂度），所以路由必须保守：
// 只在确实需要时才上，而且要说得出为什么——`reasons` 会直接显示给用户，
// 让他能自己判断「这镜值不值得多花这份钱」，而不是被系统悄悄决定。
//
// 评分不是玄学：每一项因子都对应一种已知的失败模式，权重写在下面并注明理由。

import { shotCharacterIds, shotDuration, type ShotDna } from '../shot-dna/types';

export interface ComplexityFactor {
  key: string;
  score: number;
  reason: string;
}

export interface ComplexityResult {
  score: number;
  factors: Record<string, number>;
  needsBlender: boolean;
  reasons: string[];
  /** 没到 Blender 门槛但仍然偏高时给的提醒，写进提示词能提前规避。 */
  warnings: string[];
}

export interface ComplexityOptions {
  /** 超过这个分就上 Blender。默认 6。调高省钱、成片率降；调低反之。 */
  blenderThreshold?: number;
  /** 用户强制指定。true/false 都会跳过评分，但评分结果仍然算出来给用户看。 */
  forceBlender?: boolean;
}

/** 复杂运镜：这几种镜头模型照做的概率很低，空间一错整镜就废。 */
const HARD_MOVEMENTS = new Set(['orbit', 'crane', 'truck']);
const MEDIUM_MOVEMENTS = new Set(['dolly_in', 'dolly_out', 'handheld', 'pan', 'tilt', 'zoom']);

export function analyzeComplexity(dna: ShotDna, opts: ComplexityOptions = {}): ComplexityResult {
  const factors: ComplexityFactor[] = [];
  const duration = shotDuration(dna);
  const characterCount = shotCharacterIds(dna).length;

  // ---- 人数 ----
  // 三人以上开始出现「谁挡住谁」的问题，模型分不清前后层次。
  if (characterCount >= 4) {
    factors.push({ key: 'cast', score: 3, reason: `${characterCount} 个角色同框，前后层次和遮挡关系模型极易搞错` });
  } else if (characterCount === 3) {
    factors.push({ key: 'cast', score: 2, reason: '三人同框，需要明确前后层次' });
  } else if (characterCount === 2) {
    factors.push({ key: 'cast', score: 1, reason: '双人对戏，左右站位要固定' });
  }

  // ---- 走位交叉 ----
  // 有人中途入画/出画，就存在「他从哪儿来、走到哪儿」的路径问题。
  // 这是 pop-in 和穿模的主要来源。
  const movers = dna.actors.filter((a) => a.entry_at !== undefined || a.exit_at !== undefined);
  if (movers.length >= 2) {
    factors.push({ key: 'blocking', score: 3, reason: `${movers.length} 个角色在镜头中途进出画，走位路径会交叉` });
  } else if (movers.length === 1) {
    factors.push({ key: 'blocking', score: 1.5, reason: '有角色中途进出画，需要交代路径' });
  }

  // ---- 深度层次 ----
  // 分布在三个景深层上，说明这是一个有纵深调度的镜头。
  const layers = new Set(dna.actors.map((a) => a.depth_layer));
  if (layers.size >= 3) {
    factors.push({ key: 'depth', score: 2, reason: '前中后景都有人，纵深关系必须锁死' });
  } else if (layers.size === 2 && characterCount >= 3) {
    factors.push({ key: 'depth', score: 1, reason: '多人分布在两个景深层上' });
  }

  // ---- 运镜 ----
  if (HARD_MOVEMENTS.has(dna.camera.movement)) {
    factors.push({ key: 'camera', score: 3, reason: `${dna.camera.movement} 属于复杂运镜，模型很难照做，机位路径需要预演` });
  } else if (MEDIUM_MOVEMENTS.has(dna.camera.movement)) {
    factors.push({ key: 'camera', score: 1, reason: '有运镜，需要明确起止机位' });
  }

  // ---- 动作密度 ----
  // 同一镜里回合越多，模型越容易乱序或漏演。
  // 用「每秒多少拍」而不是绝对数量：19 秒 6 拍是正常节奏，5 秒 6 拍就是快剪。
  const beats = dna.action_timeline.length;
  if (beats >= 2 && duration > 0) {
    const density = beats / duration;
    if (density > 0.6) {
      factors.push({ key: 'density', score: 2.5, reason: `${duration} 秒里 ${beats} 拍动作，节奏过密，模型容易漏演或乱序` });
    } else if (beats >= 5) {
      factors.push({ key: 'density', score: 1.5, reason: `本镜有 ${beats} 个动作回合，需要严格按时间轴执行` });
    }
  }

  // ---- 交互动作 ----
  // 有明确指向对象的动作（指、推、递、看向）意味着两个角色之间有精确的相对位置要求。
  const interactions = dna.action_timeline.filter((f) => (f.toward_ids?.length ?? 0) > 0).length;
  if (interactions >= 3) {
    factors.push({ key: 'interaction', score: 2, reason: `${interactions} 次角色间互动，相对位置必须准确` });
  } else if (interactions >= 1 && characterCount >= 3) {
    factors.push({ key: 'interaction', score: 1, reason: '多人场景中有指向性互动' });
  }

  // ---- 时长 ----
  // 长镜头本身就难：模型在后半段会开始漂。
  if (duration > 15) {
    factors.push({ key: 'duration', score: 2, reason: `本镜 ${duration} 秒，超过 15 秒后模型通常开始偏离提示词` });
  } else if (duration > 10) {
    factors.push({ key: 'duration', score: 1, reason: `本镜 ${duration} 秒，偏长` });
  }

  // ---- 道具交互 ----
  const heldProps = dna.actors.reduce((n, a) => n + a.props_held.length, 0);
  if (heldProps >= 2) {
    factors.push({ key: 'props', score: 1, reason: '多个角色手持道具，手部与道具的关系容易崩' });
  }

  const score = +factors.reduce((sum, f) => sum + f.score, 0).toFixed(2);
  const threshold = opts.blenderThreshold ?? 6;
  const needsBlender = opts.forceBlender ?? score >= threshold;

  // 到不了门槛但确实偏高的，给提示词加强用的警告。
  // 这一层很实用：大部分镜头不值得上 Blender，但值得在提示词里多写一句。
  const warnings: string[] = [];
  if (!needsBlender) {
    for (const f of factors) {
      if (f.score >= 2) warnings.push(f.reason);
    }
  }

  return {
    score,
    factors: Object.fromEntries(factors.map((f) => [f.key, f.score])),
    needsBlender,
    reasons: needsBlender
      ? (opts.forceBlender === true && score < threshold
          ? ['用户强制启用 3D 预演']
          : factors.filter((f) => f.score >= 1.5).map((f) => f.reason))
      : [],
    warnings,
  };
}

/**
 * 关键帧是否值得单独生成。
 *
 * 判断依据是「这一镜的开头需不需要被钉死」：
 * 首镜定全片基调、换场第一镜定新环境、多人镜定站位。
 * 不需要的镜头不生成——每张关键帧都是钱，而且多一张图就多一次形象漂移的机会。
 */
export function needsKeyframe(dna: ShotDna, previous?: ShotDna): boolean {
  if (!previous) return true;                                  // 首镜
  if (dna.scene_id && dna.scene_id !== previous.scene_id) return true;   // 换场
  if (dna.environment.location && dna.environment.location !== previous.environment.location) return true;
  if (dna.actors.length >= 3) return true;                     // 多人要钉站位
  // 上一镜没有的角色出现了，需要一张图来确立他的形象
  const prevIds = new Set(shotCharacterIds(previous));
  return shotCharacterIds(dna).some((id) => !prevIds.has(id));
}

/** 整片路由。返回可直接喂给 planProject 的镜头列表。 */
export function routeShots(shots: ShotDna[], opts: ComplexityOptions = {}): Array<{
  shotId: string;
  idx: number;
  seconds: number;
  needsBlender: boolean;
  needsKeyframe: boolean;
  revision: number;
  complexity: ComplexityResult;
}> {
  return shots.map((dna, i) => {
    const complexity = analyzeComplexity(dna, opts);
    return {
      shotId: dna.shot_id,
      idx: dna.idx,
      seconds: shotDuration(dna),
      needsBlender: complexity.needsBlender,
      needsKeyframe: needsKeyframe(dna, i > 0 ? shots[i - 1] : undefined),
      revision: dna.revision,
      complexity,
    };
  });
}
