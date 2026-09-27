// Shot DNA 校验。
//
// 与老项目 validation.ts 的区别：那边是「解析失败就抛」，因为它守的是 API 边界；
// 这里是「把问题列全了返回」，因为 Shot DNA 要给人看、要能在后台一条条修。
// 抛一个异常只能告诉用户第一个错，列表能告诉他全部。
//
// 分两级：
//  - error：会让下游产出错误结果（时间轴越界、引用不存在的角色）。必须修。
//  - warning：能跑，但成片质量会掉（没写入画时机 → 人物会凭空出现）。

import {
  CAMERA_ANGLES, CAMERA_MOVEMENTS, SCREEN_DIRECTIONS, SCREEN_POSITIONS, SHOT_SIZES,
  shotDuration, type ShotDna,
} from './types';

export type IssueSeverity = 'error' | 'warning';

export interface ShotIssue {
  severity: IssueSeverity;
  code: string;
  path: string;
  message: string;
  /** 能自动修的问题在这里给出建议值，后台一键应用。 */
  suggestion?: string;
}

const inSet = <T extends readonly string[]>(set: T, v: unknown): boolean => set.includes(v as T[number]);

export function validateShotDna(dna: ShotDna, knownCharacterIds?: string[]): ShotIssue[] {
  const issues: ShotIssue[] = [];
  const err = (code: string, path: string, message: string, suggestion?: string) =>
    issues.push({ severity: 'error', code, path, message, suggestion });
  const warn = (code: string, path: string, message: string, suggestion?: string) =>
    issues.push({ severity: 'warning', code, path, message, suggestion });

  if (dna.schema_version !== 'shot-dna.v1') {
    err('schema_version', 'schema_version', `未知版本 ${dna.schema_version}，只认 shot-dna.v1`);
  }

  const duration = shotDuration(dna);
  if (!Number.isFinite(dna.start_time) || !Number.isFinite(dna.end_time) || duration <= 0) {
    err('bad_duration', 'start_time/end_time', `时长必须为正，当前 ${dna.start_time} → ${dna.end_time}`);
  }

  // ---- 枚举字段 ----
  if (!inSet(SHOT_SIZES, dna.camera.shot_size)) err('enum', 'camera.shot_size', `景别 ${dna.camera.shot_size} 不在枚举内`, 'unknown');
  if (!inSet(CAMERA_ANGLES, dna.camera.angle)) err('enum', 'camera.angle', `机位角度 ${dna.camera.angle} 不在枚举内`, 'unknown');
  if (!inSet(CAMERA_MOVEMENTS, dna.camera.movement)) err('enum', 'camera.movement', `运镜 ${dna.camera.movement} 不在枚举内`, 'unknown');
  if (!inSet(SCREEN_DIRECTIONS, dna.camera.screen_direction)) err('enum', 'camera.screen_direction', `运动方向 ${dna.camera.screen_direction} 不在枚举内`, 'unknown');
  if (dna.camera.lens_mm !== undefined && !(dna.camera.lens_mm > 0)) {
    err('bad_lens', 'camera.lens_mm', `焦距必须为正，当前 ${dna.camera.lens_mm}`);
  }

  // ---- 角色 ----
  const known = knownCharacterIds ? new Set(knownCharacterIds) : null;
  const seenActors = new Set<string>();
  dna.actors.forEach((actor, i) => {
    const p = `actors[${i}]`;
    if (!actor.character_id) err('missing_id', `${p}.character_id`, '角色缺少 ID');
    else if (seenActors.has(actor.character_id)) err('duplicate_actor', `${p}.character_id`, `角色 ${actor.character_id} 在同一镜里出现两次`);
    seenActors.add(actor.character_id);
    if (known && actor.character_id && !known.has(actor.character_id)) {
      err('unknown_character', `${p}.character_id`, `角色 ${actor.character_id} 不在角色表里`);
    }
    if (!inSet(SCREEN_POSITIONS, actor.screen_position)) err('enum', `${p}.screen_position`, `屏幕位置 ${actor.screen_position} 不在枚举内`, 'center');

    // 入画/出画必须落在本镜内，否则 Blender 和视频模型会按错误的时间点安排走位
    for (const [key, value] of [['entry_at', actor.entry_at], ['exit_at', actor.exit_at]] as const) {
      if (value === undefined) continue;
      if (value < 0 || value > duration + 0.001) {
        err('out_of_range', `${p}.${key}`, `${key}=${value} 超出本镜 0–${duration} 秒`);
      }
    }
    if (actor.entry_at !== undefined && actor.exit_at !== undefined && actor.exit_at <= actor.entry_at) {
      err('bad_range', `${p}.exit_at`, `出画(${actor.exit_at}) 不能早于入画(${actor.entry_at})`);
    }
    // 中途入画却没写怎么进来的 —— 这就是 pop-in 的来源
    if (actor.entry_at !== undefined && actor.entry_at > 0.05 && !/入画|走进|进入|推门|enter|walk/i.test(`${actor.role_in_shot} ${actor.facing}`)) {
      warn('popin_risk', `${p}.entry_at`, `${actor.character_id} 在第 ${actor.entry_at} 秒才入画，但没说明怎么进来的；视频模型会让他凭空出现`,
        '在 role_in_shot 里写明入画方式（从画左走入 / 推门进入）');
    }
  });

  if (!dna.actors.length && dna.action_timeline.some((f) => f.actor_ids.length)) {
    err('actors_missing', 'actors', '动作时间轴里有角色，但 actors 是空的');
  }

  // ---- 动作时间轴 ----
  let prev = -Infinity;
  dna.action_timeline.forEach((frame, i) => {
    const p = `action_timeline[${i}]`;
    if (!Number.isFinite(frame.at) || frame.at < 0 || frame.at > duration + 0.001) {
      err('out_of_range', `${p}.at`, `at=${frame.at} 超出本镜 0–${duration} 秒`);
    }
    if (frame.at < prev) err('out_of_order', `${p}.at`, `时间轴必须递增：${frame.at} 排在 ${prev} 之后`);
    prev = frame.at;
    if (!frame.action?.trim()) err('empty_action', `${p}.action`, '这一拍没写动作');
    if (!frame.actor_ids.length) err('no_actor', `${p}.actor_ids`, '这一拍没写是谁做的');
    for (const id of [...frame.actor_ids, ...(frame.toward_ids ?? [])]) {
      if (seenActors.size && !seenActors.has(id)) {
        err('unknown_character', `${p}`, `${id} 出现在动作里，但不在本镜 actors 中`);
      }
    }
  });

  // ---- 表情时间轴 ----
  dna.expression_timeline.forEach((frame, i) => {
    const p = `expression_timeline[${i}]`;
    if (frame.at < 0 || frame.at > duration + 0.001) err('out_of_range', `${p}.at`, `at=${frame.at} 超出本镜 0–${duration} 秒`);
    if (seenActors.size && !seenActors.has(frame.character_id)) {
      err('unknown_character', `${p}.character_id`, `${frame.character_id} 有表情但不在本镜 actors 中`);
    }
  });

  // ---- 连续性载荷 ----
  for (const [key, map] of [['wardrobe_state', dna.continuity.wardrobe_state], ['position_state', dna.continuity.position_state]] as const) {
    for (const id of Object.keys(map ?? {})) {
      if (seenActors.size && !seenActors.has(id)) {
        warn('stale_continuity', `continuity.${key}.${id}`, `${id} 记在连续性状态里，但本镜没有他`);
      }
    }
  }
  for (const actor of dna.actors) {
    if (!dna.continuity.wardrobe_state?.[actor.character_id]) {
      warn('missing_wardrobe_state', `continuity.wardrobe_state.${actor.character_id}`,
        `${actor.character_id} 没记出镜时的服装状态，下一镜无法比对`, actor.wardrobe || undefined);
    }
  }

  // ---- 内容完整度（不影响运行，但直接影响成片） ----
  if (!dna.summary.trim()) warn('empty_summary', 'summary', '没有整镜概括');
  if (!dna.action_timeline.length) {
    warn('no_action_timeline', 'action_timeline',
      duration > 8
        ? `本镜 ${duration} 秒却没有逐拍动作，模型只能靠一句概括演完，长镜头几乎必然演飞`
        : '没有逐拍动作，提示词只能用整镜概括');
  }
  if (!dna.environment.location.trim()) warn('empty_location', 'environment.location', '没写场景');
  if (!dna.lighting.key_light.trim()) warn('empty_lighting', 'lighting.key_light', '没写主光，Blender 无法建光');

  return issues;
}

export function hasErrors(issues: ShotIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** 汇总一个项目所有镜头的问题，后台列表直接用。 */
export function validateShots(shots: ShotDna[], knownCharacterIds?: string[]): Map<string, ShotIssue[]> {
  const out = new Map<string, ShotIssue[]>();
  for (const shot of shots) {
    const issues = validateShotDna(shot, knownCharacterIds);
    if (issues.length) out.set(shot.shot_id, issues);
  }
  return out;
}
