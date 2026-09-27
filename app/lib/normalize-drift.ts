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
  return fixes;
}

/** 一行话说清这次修了什么，给界面和 uncertainties 用。 */
export function describeDrift(fixes: DriftFix[]): string {
  if (!fixes.length) return '';
  const items = fixes.map((f) => `${f.path}：${f.from} → ${f.to}`).join('；');
  return `已自动归一 ${fixes.length} 处模型偏差（${items}）。修不了的仍然拒收，不会静默放过。`;
}
