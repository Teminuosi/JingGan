// 把模型的"形状跑偏"在校验之前修回来。
//
// 为什么需要这一层：中转把 Gemini 的结构化输出降级成普通 chat 之后，
// responseJsonSchema 只剩建议作用，模型会随机发挥。实测同一个 gemini-3.7-flash：
// 前四次 style_dna.performance.gesture_language 都给字符串，第五次给了数组；
// 同一份结果里还把机位写成 slow_dolly_in，而枚举里只有 dolly_in。
//
// 这两处偏差在语义上完全正确，可校验是"遇到第一个错就抛"，
// 于是一份一万六千 token、空间数据齐全的分析被整条拒收，用户只能重跑碰运气。
// 一次付费分析因为两个措辞问题作废，这是退款级的体验。
//
// 但"宽容"不等于"和稀泥"：
//  - 只修**能确定原意**的偏差（数组元素合并成文本、去掉枚举值上的程度修饰词）；
//  - 每一处都记下来往上报，绝不静默吞掉；
//  - 修不了的照旧拒收——宁可拦住，也不能让一份读错的 DNA 往下污染故事和成片。

import { VIDEO_DNA_SCHEMA } from './schemas';

export interface DriftFix {
  /** 出问题的字段路径，例如 beats[4].blocking.camera.movement */
  path: string;
  from: string;
  to: string;
  /** 为什么这么修，给人看的 */
  reason: string;
}

/** 枚举值上常见的程度修饰词。模型爱加，语义没变。 */
const QUALIFIERS = [
  'slow', 'slowly', 'fast', 'quick', 'quickly', 'rapid', 'slight', 'slightly',
  'gentle', 'gently', 'subtle', 'smooth', 'smoothly', 'very', 'extreme', 'extremely',
  'medium', 'moderate', 'steady', 'continuous', 'partial', 'soft',
];

/** 说法不同但指同一件事的。只收**没有歧义**的，含糊的一律不猜。 */
const SYNONYMS: Record<string, string> = {
  push_in: 'dolly_in',
  pull_out: 'dolly_out',
  pull_back: 'dolly_out',
  track_in: 'dolly_in',
  track_out: 'dolly_out',
  tracking: 'truck',
  track: 'truck',
  trucking: 'truck',
  dolly: 'truck',
  whip_pan: 'pan',
  panning: 'pan',
  tilting: 'tilt',
  zoom_in: 'zoom',
  zoom_out: 'zoom',
  steadicam: 'handheld',
  shaky: 'handheld',
  orbiting: 'orbit',
  arc: 'orbit',
  fixed: 'static',
  locked_off: 'static',
  still: 'static',
  close_up: 'CU',
  extreme_close_up: 'ECU',
  medium_close_up: 'MCU',
  medium_shot: 'MS',
  medium_long_shot: 'MLS',
  long_shot: 'LS',
  wide: 'LS',
  wide_shot: 'LS',
  extreme_long_shot: 'ELS',
  full_shot: 'LS',
  low_angle: 'low',
  high_angle: 'high',
  eye: 'eye_level',
  eye_level_angle: 'eye_level',
  birds_eye: 'overhead',
  top_down: 'overhead',
  ots: 'over_shoulder',
  over_the_shoulder: 'over_shoulder',
  first_person: 'pov',
  toward_cam: 'toward_camera',
  away_from_cam: 'away_from_camera',
  l_to_r: 'left_to_right',
  r_to_l: 'right_to_left',
};

const slug = (s: string) => s.trim().toLowerCase().replace(/[\s\-/]+/g, '_').replace(/_+/g, '_');

/**
 * 把一个跑偏的枚举值掰回合法值。掰不回来就返回 undefined——
 * 让校验照常拒收，而不是随便挑一个塞进去。
 */
function canonicalizeEnum(raw: string, allowed: readonly string[]): string | undefined {
  if (allowed.includes(raw)) return undefined;             // 本来就对，不用修

  const bySlug = new Map(allowed.map((a) => [slug(a), a]));
  const direct = bySlug.get(slug(raw));
  if (direct) return direct;                                // 只是大小写/连字符不同

  const syn = SYNONYMS[slug(raw)];
  if (syn && allowed.includes(syn)) return syn;

  // 去掉程度修饰词后再试：slow_dolly_in → dolly_in
  const parts = slug(raw).split('_').filter(Boolean);
  const stripped = parts.filter((p) => !QUALIFIERS.includes(p));
  if (stripped.length && stripped.length < parts.length) {
    const joined = stripped.join('_');
    const hit = bySlug.get(joined) ?? (SYNONYMS[joined] && allowed.includes(SYNONYMS[joined]) ? SYNONYMS[joined] : undefined);
    if (hit) return hit;
  }

  // 复合值取第一个能认出来的片段：dolly_in_then_static → dolly_in。
  // 只在结果唯一时才接受，多个候选说明这一镜真有两段运镜，该让人来看。
  const matches = allowed.filter((a) => slug(raw).includes(slug(a)) && slug(a) !== 'unknown');
  if (matches.length === 1) return matches[0];

  return undefined;
}

interface SchemaNode {
  type?: string;
  enum?: readonly string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/** 数组里的元素能不能安全地拼成一句话：全是标量才行。 */
const isFlatArray = (v: unknown): v is Array<string | number> =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' || typeof x === 'number');

/**
 * 顺着 schema 走一遍数据，把能确定原意的偏差改掉。
 * 就地修改 value（和同文件里其它 normalizeLegacy* 一样），返回改了哪些。
 */
function walk(value: unknown, schema: SchemaNode | undefined, path: string, fixes: DriftFix[]): unknown {
  if (!schema || value === null || value === undefined) return value;

  if (schema.type === 'object' && schema.properties && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!(key in obj)) continue;
      obj[key] = walk(obj[key], child, path ? `${path}.${key}` : key, fixes);
    }
    return obj;
  }

  // 该给一串 ID，给了单个字符串 —— 包成一项，不改内容。
  if (schema.type === 'array' && schema.items?.type === 'string' && typeof value === 'string' && value.trim()) {
    fixes.push({ path, from: `"${value}"`, to: `["${value.trim()}"]`, reason: '这里要一串条目，模型给了单个值，已包成一项' });
    return [value.trim()];
  }

  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => { value[i] = walk(item, schema.items, `${path}[${i}]`, fixes); });
    return value;
  }

  if (schema.type === 'string') {
    // 该给一句话，给了一串条目 —— 合并，不丢内容。
    if (isFlatArray(value)) {
      const joined = value.map(String).map((s) => s.trim()).filter(Boolean).join('；');
      fixes.push({
        path,
        from: `数组（${value.length} 项）`,
        to: joined.length > 40 ? `${joined.slice(0, 40)}…` : joined,
        reason: '这里要一句话，模型给了条目列表，已按原顺序合并',
      });
      return joined;
    }
    if (typeof value === 'string' && schema.enum) {
      const fixed = canonicalizeEnum(value, schema.enum);
      if (fixed) {
        fixes.push({ path, from: value, to: fixed, reason: '枚举值带了修饰词或换了说法，已归到合法值' });
        return fixed;
      }
    }
    return value;
  }

  if (schema.type === 'number' && typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    fixes.push({ path, from: `"${value}"`, to: value.trim(), reason: '数字被写成了字符串' });
    return Number(value);
  }

  return value;
}

/**
 * 修正模型的形状偏差。就地改 value，返回改动清单（空数组 = 这份数据本来就规矩）。
 *
 * 由 schema 驱动而不是硬编码字段名：以后往 schema 里加字段，这一层自动覆盖，
 * 不会出现"新字段又踩同一个坑、又得改一遍归一化"。
 */
export function normalizeModelDrift(value: unknown): DriftFix[] {
  const fixes: DriftFix[] = [];
  walk(value, VIDEO_DNA_SCHEMA as SchemaNode, '', fixes);
  dropActorlessActionBeats(value, fixes);
  // 在移拍之后收时间：记下的 action_beats[j] 下标才和最终数据对得上。
  clampSlightTimeOverrun(value, fixes);
  dropMisalignedEnglish(value, fixes);
  return fixes;
}

/** 拍点越出本镜区间多少秒以内算「模型取整多写了一点」，超过这个就当真错了照旧拒收。 */
const TIME_OVERRUN_TOLERANCE_SECONDS = 2;

/**
 * 逐拍动作 at_seconds、入画/出画 entry_at/exit_at 稍微越出本镜区间时，收回到区间边上。
 *
 * 真实案例（2026-11-08）：一条 229 秒的片子，模型把最后一拍标成 230 秒（视频只有 229 秒），
 * 校验只容 0.01 秒误差，整次付费分析被拒收。长片秒数取整更容易多出这一两秒。
 * 只收 2 秒以内的越界，并记进改动清单；越界更多说明时间轴真读错了，交给校验拒收。
 */
function clampSlightTimeOverrun(value: unknown, fixes: DriftFix[]) {
  const dna = value as { beats?: unknown; english?: { beats?: unknown } };
  const english = Array.isArray(dna?.english?.beats) ? dna.english!.beats as Array<Record<string, unknown>> : [];
  if (!Array.isArray(dna?.beats)) return;
  // 容差不超过本镜时长：0.5 秒的短镜越出 2 秒，那一拍其实属于下一镜，不能硬塞回来。
  // at_seconds 本身容 0.01 秒（校验同口径），这点误差不改也不记；入画/出画校验只容 0.001 秒，照收。
  const clamp = (holder: Record<string, unknown>, key: string, start: number, end: number, path: string, ignoreBelow = 0) => {
    const v = holder[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    const to = v > end ? end : v < start ? start : v;
    const tolerance = Math.min(TIME_OVERRUN_TOLERANCE_SECONDS, Math.max(0.5, end - start));
    if (to === v || Math.abs(to - v) <= ignoreBelow || Math.abs(to - v) > tolerance) return;
    holder[key] = to;
    fixes.push({ path: `${path}.${key}`, from: `${v} 秒`, to: `${to} 秒`, reason: `超出本镜 ${start}–${end} 秒不到 ${tolerance} 秒（模型取整多写了），已收回到区间边上` });
  };
  (dna.beats as Array<Record<string, unknown>>).forEach((beat, i) => {
    const start = beat?.start_seconds, end = beat?.end_seconds;
    if (typeof start !== 'number' || typeof end !== 'number' || !(end > start)) return;
    const twin = english.find(item => item?.beat_id === beat.beat_id);
    for (const [owner, prefix] of [[beat, `beats[${i}]`], [twin, `english.beats[${english.indexOf(twin!)}]`]] as const) {
      const steps = (owner as Record<string, unknown> | undefined)?.action_beats;
      if (Array.isArray(steps)) steps.forEach((step, j) => { if (step && typeof step === 'object') clamp(step as Record<string, unknown>, 'at_seconds', start, end, `${prefix}.action_beats[${j}]`, 0.01); });
    }
    const actors = (beat.blocking as { actors?: unknown } | undefined)?.actors;
    if (Array.isArray(actors)) actors.forEach((actor, j) => {
      if (!actor || typeof actor !== 'object') return;
      clamp(actor as Record<string, unknown>, 'entry_at', start, end, `beats[${i}].blocking.actors[${j}]`);
      clamp(actor as Record<string, unknown>, 'exit_at', start, end, `beats[${i}].blocking.actors[${j}]`);
    });
  });
}

/**
 * 逐拍动作里「没有执行角色」的那一拍，移出 action_beats。
 *
 * 真实案例：一条 8 秒的机舱门片子，第 1 段第 1 拍是舱门/镜头本身在动、画面里没人，模型如实给了空的 actor_ids，
 * 校验要求每拍至少一个角色，整次付费分析因此被拒收。这类拍点本来就不是角色交锋，
 * 整段在干什么仍写在 visual_action 里，移掉它不丢画面信息；下游（拆镜、Seedance 分镜、预演覆盖）都假定每拍有执行者。
 * 移了哪一拍会记进改动清单，界面看得见，不静默。
 */
function dropActorlessActionBeats(value: unknown, fixes: DriftFix[]) {
  const beats = (value as { beats?: unknown })?.beats;
  if (!Array.isArray(beats)) return;
  beats.forEach((beat, beatIndex) => {
    const steps = (beat as { action_beats?: unknown })?.action_beats;
    if (!Array.isArray(steps)) return;
    const english = (value as { english?: { beats?: Array<{ beat_id?: unknown; action_beats?: unknown[] }> } })?.english?.beats?.find(item => item?.beat_id === (beat as { beat_id?: unknown })?.beat_id);
    const dropped = new Set<number>();
    const kept = steps.filter((step, stepIndex) => {
      const actors = (step as { actor_ids?: unknown })?.actor_ids;
      if (Array.isArray(actors) && actors.length > 0) return true;
      if (actors !== undefined && actors !== null && !Array.isArray(actors)) return true; // 别的形状交给校验报错
      const action = String((step as { action?: unknown })?.action ?? '').slice(0, 30);
      fixes.push({ path: `beats[${beatIndex}].action_beats[${stepIndex}]`, from: `无执行角色：${action}`, to: '已移出逐拍动作', reason: '这一拍没有执行角色（多为镜头或环境变化），整段动作描述仍保留' });
      dropped.add(stepIndex);
      return false;
    });
    (beat as { action_beats: unknown[] }).action_beats = kept;
    // 英文版逐拍和中文一一对应，中文移掉哪拍，英文也移掉同一拍，否则后面全部错位。
    if (english && Array.isArray(english.action_beats) && english.action_beats.length === steps.length) english.action_beats = english.action_beats.filter((_, i) => !dropped.has(i));
  });
}

/**
 * 英文版只是拼英文提示词用的附件：和中文对不上（缺镜头、逐拍数量不同、角色缺失）时整块丢掉并记录，
 * 不能因为它让整次付费分析被拒收；英文提示词按钮会说明这份分析没有英文版。
 */
function dropMisalignedEnglish(value: unknown, fixes: DriftFix[]) {
  const dna = value as { english?: unknown; beats?: Array<{ beat_id?: unknown; action_beats?: unknown[] }>; source_roles?: Array<{ role_id?: unknown }> };
  if (!dna || dna.english === undefined) return;
  const english = dna.english as { beats?: Array<{ beat_id?: unknown; action_beats?: unknown[] }>; roles?: Array<{ role_id?: unknown }> };
  const beats = Array.isArray(dna.beats) ? dna.beats : [];
  const roles = Array.isArray(dna.source_roles) ? dna.source_roles : [];
  const problem = !english || typeof english !== 'object' ? '不是对象'
    : !Array.isArray(english.beats) || english.beats.length !== beats.length ? '镜头数量和中文不一致'
      : beats.some((beat, i) => english.beats![i]?.beat_id !== beat.beat_id || (english.beats![i]?.action_beats?.length ?? 0) !== (beat.action_beats?.length ?? 0)) ? '某个镜头的编号或逐拍数量和中文不一致'
        : !Array.isArray(english.roles) || roles.some(role => !english.roles!.some(item => item?.role_id === role.role_id)) ? '角色和中文不一致'
          : '';
  if (!problem) return;
  delete dna.english;
  fixes.push({ path: 'english', from: problem, to: '已丢弃英文版', reason: '英文版和中文对不上，丢掉它不影响分析本身，只是这份分析拼不出英文提示词' });
}

/** 一行话说清这次修了什么，给界面和 uncertainties 用。 */
export function describeDrift(fixes: DriftFix[]): string {
  if (!fixes.length) return '';
  const items = fixes.map((f) => `${f.path}：${f.from} → ${f.to}`).join('；');
  return `已自动归一 ${fixes.length} 处模型偏差（${items}）。修不了的仍然拒收，不会静默放过。`;
}
