// 连续性引擎。
//
// 规格第六章。这是「复刻」和「一镜一镜各自生成」的分界线：
// 视频模型每次调用都是无记忆的，第 3 镜不知道第 2 镜里角色穿什么、站在哪、手里拿着什么。
// 不管的结果就是——同一个人上一镜穿蓝衬衫下一镜变白的，上一镜在左边下一镜跳到右边，
// 手里的杯子凭空消失。观众说不出哪里怪，但会觉得「这是 AI 拼的」。
//
// 做法：把每一镜的收尾状态（服装/道具/位置/时间/地点）与下一镜的开场状态逐项比对，
// 不一致就报，并且给出可直接写回 Shot DNA 的修复值。
//
// 两条自我约束：
//  1. 只在双方都有数据时比对。旧分析投影出来的字段大量为空，
//     拿空值去比会产出成百上千条假问题，用户看两眼就再也不看了。
//  2. 能确定的才自动修（把上一镜的状态传下去）。判断不了的只报不改。

import { shotCharacterIds, type ScreenPosition, type ShotDna } from '../shot-dna/types';

export type ContinuitySeverity = 'error' | 'warning' | 'info';

export interface ContinuityIssue {
  severity: ContinuitySeverity;
  code: string;
  /** 出问题的这一镜。 */
  shotId: string;
  /** 与之冲突的上一镜。 */
  previousShotId?: string;
  subject: string;
  message: string;
  /** 建议写回哪个字段、写什么值。autoFix 用的就是它。 */
  fix?: { path: string; value: string };
}

const POSITION_ORDER: Record<ScreenPosition, number> = {
  left: 0, center_left: 1, center: 2, center_right: 3, right: 4, offscreen: -1,
};

/** 判断两个描述是不是「实质不同」。空值、同义的空白差异不算。 */
function differs(a?: string, b?: string): boolean {
  const norm = (s?: string) => (s ?? '').replace(/\s+/g, '').trim();
  const x = norm(a); const y = norm(b);
  return Boolean(x && y && x !== y);
}

export interface ContinuityOptions {
  /**
   * 允许的场景切换点。跨场景时地点/时间/光线本来就该变，不该报。
   * 传入 scene_id 不同即视为换场；同一 scene_id 内才严格比对。
   */
  strictWithinSceneOnly?: boolean;
  /** 时间轴允许的最大空隙（秒）。超过说明漏了镜头。 */
  maxGapSeconds?: number;
}

/**
 * 全片连续性检查。shots 必须按时间顺序传入。
 */
export function checkContinuity(shots: ShotDna[], opts: ContinuityOptions = {}): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const maxGap = opts.maxGapSeconds ?? 0.05;
  const push = (i: Omit<ContinuityIssue, 'shotId'> & { shotId: string }) => issues.push(i);

  for (let i = 0; i < shots.length; i += 1) {
    const cur = shots[i];
    const prev = i > 0 ? shots[i - 1] : undefined;

    // ---- 时间轴：空隙与重叠 ----
    // 这一条不看场景，任何情况下时间轴都必须是连续的，
    // 否则拼接出来的成片会比源片短或长，用户一眼就看得出。
    if (prev) {
      const gap = +(cur.start_time - prev.end_time).toFixed(3);
      if (gap > maxGap) {
        push({
          severity: 'error', code: 'timeline_gap', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: '时间轴',
          message: `第 ${prev.idx + 1} 镜在 ${prev.end_time}s 结束，第 ${cur.idx + 1} 镜从 ${cur.start_time}s 开始，中间缺了 ${gap} 秒`,
          fix: { path: 'start_time', value: String(prev.end_time) },
        });
      } else if (gap < -maxGap) {
        push({
          severity: 'error', code: 'timeline_overlap', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: '时间轴',
          message: `第 ${cur.idx + 1} 镜与上一镜重叠了 ${-gap} 秒`,
          fix: { path: 'start_time', value: String(prev.end_time) },
        });
      }
    }

    // ---- 镜内：入画未说明 ----
    for (const actor of cur.actors) {
      if (actor.entry_at !== undefined && actor.entry_at > 0.05 && !actor.role_in_shot.trim()) {
        push({
          severity: 'warning', code: 'unexplained_entry', shotId: cur.shot_id,
          subject: actor.character_id,
          message: `${actor.character_id} 在第 ${actor.entry_at} 秒才入画，但没写他从哪儿进来的；模型会让他凭空出现`,
        });
      }
    }

    if (!prev) continue;
    const sameScene = !opts.strictWithinSceneOnly || (cur.scene_id && cur.scene_id === prev.scene_id);

    // ---- 跨镜：服装 ----
    const prevChars = new Set(shotCharacterIds(prev));
    for (const id of shotCharacterIds(cur)) {
      if (!prevChars.has(id)) continue;   // 上一镜没他，没得比

      const was = prev.continuity.wardrobe_state?.[id] ?? prev.actors.find((a) => a.character_id === id)?.wardrobe;
      const isNow = cur.actors.find((a) => a.character_id === id)?.wardrobe;
      if (differs(was, isNow)) {
        push({
          severity: 'error', code: 'wardrobe_break', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: id,
          message: `${id} 上一镜是「${was}」，这一镜变成「${isNow}」。中间没有换装的理由就是穿帮`,
          fix: { path: `actors.${id}.wardrobe`, value: was ?? '' },
        });
      } else if (was && !isNow) {
        // 更常见的情况不是写错，是这一镜压根没写。补上比报错有用。
        push({
          severity: 'info', code: 'wardrobe_inherit', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: id,
          message: `${id} 这一镜没写服装，按上一镜沿用「${was}」`,
          fix: { path: `actors.${id}.wardrobe`, value: was },
        });
      }

      // ---- 跨镜：屏幕位置跳变（180 度轴线） ----
      // 只在两边都不是默认的 center 时才比：投影出来的旧数据全是 center，
      // 拿它去比会得出「全片没问题」的假结论，也可能反过来全是噪音。
      const wasPos = prev.continuity.position_state?.[id] ?? prev.actors.find((a) => a.character_id === id)?.screen_position;
      const nowPos = cur.actors.find((a) => a.character_id === id)?.screen_position;
      if (sameScene && wasPos && nowPos && wasPos !== 'center' && nowPos !== 'center'
          && wasPos !== 'offscreen' && nowPos !== 'offscreen') {
        const jump = Math.abs(POSITION_ORDER[wasPos] - POSITION_ORDER[nowPos]);
        if (jump >= 3) {
          push({
            severity: 'error', code: 'axis_break', shotId: cur.shot_id, previousShotId: prev.shot_id,
            subject: id,
            message: `${id} 从画面${wasPos}直接跳到${nowPos}，越过了轴线。同一场戏里人物左右关系反转，观众会以为换了地方`,
          });
        }
      }
    }

    // ---- 跨镜：运动方向反转 ----
    if (sameScene
        && cur.camera.screen_direction !== 'unknown' && prev.camera.screen_direction !== 'unknown'
        && ((cur.camera.screen_direction === 'left_to_right' && prev.camera.screen_direction === 'right_to_left')
          || (cur.camera.screen_direction === 'right_to_left' && prev.camera.screen_direction === 'left_to_right'))) {
      push({
        severity: 'warning', code: 'direction_reversal', shotId: cur.shot_id, previousShotId: prev.shot_id,
        subject: '运动方向',
        message: '上一镜从左往右，这一镜从右往左，同一场戏里方向反转会让观众以为人物折返了',
      });
    }

    // ---- 跨镜：道具 ----
    const prevProps = prev.continuity.prop_state ?? {};
    for (const [name, state] of Object.entries(prevProps)) {
      const now = cur.continuity.prop_state?.[name];
      const stillPresent = cur.objects.some((o) => o.name === name);
      if (now && differs(state, now)) {
        push({
          severity: 'warning', code: 'prop_state_break', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: name,
          message: `道具「${name}」上一镜是「${state}」，这一镜是「${now}」，中间没有交代变化过程`,
        });
      } else if (!now && !stillPresent && prev.objects.find((o) => o.name === name)?.persistent) {
        push({
          severity: 'warning', code: 'prop_vanished', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: name,
          message: `道具「${name}」被标为常驻，但这一镜里没有了`,
          fix: { path: `continuity.prop_state.${name}`, value: state },
        });
      }
    }

    // ---- 跨镜：地点与时间 ----
    if (sameScene) {
      if (differs(prev.environment.location, cur.environment.location)) {
        push({
          severity: 'warning', code: 'location_jump', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: '场景',
          message: `同一场戏里地点从「${prev.environment.location}」变成「${cur.environment.location}」；如果确实换场了，应该拆成两个 scene`,
        });
      }
      if (differs(prev.environment.time_of_day, cur.environment.time_of_day)) {
        push({
          severity: 'error', code: 'time_jump', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: '时间',
          message: `同一场戏里时间从「${prev.environment.time_of_day}」跳到「${cur.environment.time_of_day}」，光线会整段对不上`,
          fix: { path: 'environment.time_of_day', value: prev.environment.time_of_day },
        });
      }
      if (differs(prev.lighting.key_light, cur.lighting.key_light) && !differs(prev.environment.location, cur.environment.location)) {
        push({
          severity: 'info', code: 'lighting_shift', shotId: cur.shot_id, previousShotId: prev.shot_id,
          subject: '光线',
          message: `同一地点里主光从「${prev.lighting.key_light}」变成「${cur.lighting.key_light}」，确认是有意为之`,
        });
      }
    }
  }

  return issues;
}

/**
 * 自动修复。只处理「能确定答案」的那几类——本质都是「把上一镜的状态传下去」，
 * 这类修复不需要判断力，漏做才是错的。
 *
 * 轴线跳变、方向反转这种要判断导演意图的，一律只报不改。
 *
 * 返回新数组，不改入参：Shot DNA 是真相源，原地改会让「改了什么」无从追溯。
 */
export function autoFixContinuity(shots: ShotDna[], issues: ContinuityIssue[]): { shots: ShotDna[]; applied: ContinuityIssue[] } {
  const FIXABLE = new Set(['wardrobe_inherit', 'prop_vanished', 'timeline_gap', 'timeline_overlap']);
  const out = shots.map((s) => structuredClone(s));
  const byId = new Map(out.map((s) => [s.shot_id, s]));
  const applied: ContinuityIssue[] = [];
  // 一次修复过程只算一次修订，哪怕同一镜修了好几处。
  // revision 会进任务幂等键，它表达的是「这份 DNA 是第几版」，
  // 按问题条数累加会让版本号跟实际改动次数对不上。
  const touched = new Set<string>();

  for (const issue of issues) {
    if (!FIXABLE.has(issue.code) || !issue.fix) continue;
    const shot = byId.get(issue.shotId);
    if (!shot) continue;

    if (issue.code === 'wardrobe_inherit') {
      const actor = shot.actors.find((a) => a.character_id === issue.subject);
      if (!actor) continue;
      actor.wardrobe = issue.fix.value;
      shot.continuity.wardrobe_state = { ...shot.continuity.wardrobe_state, [issue.subject]: issue.fix.value };
    } else if (issue.code === 'prop_vanished') {
      shot.continuity.prop_state = { ...shot.continuity.prop_state, [issue.subject]: issue.fix.value };
    } else {
      // 时间轴对齐：只挪开始时间，结束时间跟着平移，保住本镜时长——
      // 时长是已经按它计过价、也按它写好动作时间轴的，动不得。
      const duration = shot.end_time - shot.start_time;
      shot.start_time = Number(issue.fix.value);
      shot.end_time = +(shot.start_time + duration).toFixed(3);
    }
    if (!touched.has(shot.shot_id)) { shot.revision += 1; touched.add(shot.shot_id); }
    applied.push(issue);
  }
  return { shots: out, applied };
}

/** 把检查结果按严重度汇总，前端进度页和后台都用这个口径。 */
export function continuitySummary(issues: ContinuityIssue[]): Record<ContinuitySeverity, number> {
  return issues.reduce((acc, i) => { acc[i.severity] += 1; return acc; },
    { error: 0, warning: 0, info: 0 } as Record<ContinuitySeverity, number>);
}
