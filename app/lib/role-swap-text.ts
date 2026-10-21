import type { CharacterCandidate, RemixBrief, RoleLeak, RoleSlot, SourceRole, VideoDnaAnalysis } from './types';
import { resolveCharacterEntity, resolveSourceRoleEntity } from './entity-profile';

/**
 * 保留原剧情时，镜头文字（动作/摄影/音效）和风格锁（画面/声音）直接取自源片分析，
 * 里面写死了源角色的物种（小猫、猫毛、喵叫）和源片画面介质（超写实）。
 * 用户在第 3 步把角色换了物种或画风后，这些词会和角色图打架。这里只做确定性的本地替换：
 * 只动「被换掉的那个源角色」的物种词和源片介质词，剧情、时间、镜头、道具、场景一律不动。
 */

type Lexicon = { test: RegExp; nouns: string[]; parts: [string, string][]; sounds: string[]; sound: string; coats: string[] };

// 先长后短：复合词（猫毛、猫叫声）必须在单字「猫」之前替换。
const LEXICONS: Lexicon[] = [
  { test: /猫|cat|kitten/i, nouns: ['三花小猫', '三花猫', '狸花猫', '橘猫', '小猫咪', '幼猫', '小猫', '猫咪', '猫猫', '猫'], parts: [['猫毛', '毛发'], ['猫爪', '爪子'], ['猫须', '胡须'], ['猫耳', '耳朵'], ['猫脸', '面部']], sounds: ['猫叫声', '猫叫', '喵喵叫', '喵叫声', '喵叫', '喵喵', '喵'], sound: '猫叫', coats: ['三花', '狸花', '玳瑁'] },
  { test: /狗|犬|柯基|dog|puppy|corgi/i, nouns: ['小狗狗', '狗狗', '小狗', '幼犬', '狗'], parts: [['狗毛', '毛发'], ['狗爪', '爪子']], sounds: ['狗叫声', '狗叫', '犬吠声', '犬吠', '汪汪叫', '汪汪', '汪'], sound: '小狗叫声', coats: [] },
  { test: /兔|rabbit|bunny/i, nouns: ['小兔子', '兔子', '小兔', '兔'], parts: [['兔毛', '毛发']], sounds: [], sound: '兔子轻微鼻息声', coats: [] },
];

const REALISM = /(照片级|超)?写实(拟真)?(渲染|风格|质感)?|拟真渲染|拟真|真人实拍|实拍|photorealistic|hyper-?realistic|live-action/gi;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortSpecies = (species: string) => species.split(/\s*[\/／]\s*/)[0].trim() || species.trim();
const lexiconOf = (species: string) => LEXICONS.find(l => l.test.test(species));

export type TextAdapter = { text: (value: string) => string; medium?: string };

// ---- 角色槽位（分析时模型交出的专属词）----
// 有槽位：词来自这次分析，内置词表只作补充；没有槽位（旧分析）：走下面原来的词表逻辑，输出逐字不变。

const isLatin = (term: string) => /^[A-Za-z][A-Za-z\s'-]*$/.test(term);
// 英文按整词匹配（允许复数），免得 cat 误伤 category；中文原样匹配。
const termPattern = (term: string) => isLatin(term) ? `(?<![A-Za-z])${escape(term)}(?:e?s)?(?![A-Za-z])` : escape(term);
const terms = (list: unknown) => Array.isArray(list) ? [...new Set(list.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean))] : [];
const alternation = (list: string[]) => [...list].sort((a, b) => b.length - a.length).map(termPattern).join('|');
const notHuman = (name: string) => Boolean(name) && !/^(人类|human)$/i.test(name);

type Kind = RoleLeak['kind'];
type RoleTerms = Record<Kind, string[]>;

/** 一个源角色的全部专属说法，按类别分组。lexicon=false 时不拿内置词表补充（同类角色没换时说不清指谁）。 */
function roleTerms(role: SourceRole, lexicon = true): RoleTerms {
  const species = resolveSourceRoleEntity(role).species ?? '';
  const from = lexicon ? lexiconOf(species) : undefined;
  const base = [shortSpecies(species), ...(from?.nouns ?? []), ...(from?.parts.map(([part]) => part) ?? [])].filter(notHuman);
  const slot = role.slot;
  return {
    species: terms([...base, ...terms(slot?.species_terms)]),
    appearance: terms([...(from?.coats ?? []), ...terms(slot?.appearance_terms)]),
    voice: terms([...(from?.sounds ?? []), ...terms(slot?.voice?.terms)]),
    motion: terms(slot?.motion_terms),
  };
}

/** 没换的角色用到的词：被换角色的词与之重叠（互相包含）时说不清指谁，宁可不替换、不报。 */
function blockedTerms(analysis: VideoDnaAnalysis, swapped: Set<string>): string[] {
  return analysis.source_roles.filter(role => !swapped.has(role.role_id)).flatMap(role => Object.values(roleTerms(role)).flat());
}
const clashes = (term: string, blocked: string[]) => blocked.some(b => term.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(term.toLowerCase()));

type Swap = { id: string; roleId: string; source: ReturnType<typeof resolveSourceRoleEntity>; from?: Lexicon; changed: boolean; targetSpecies: string; slot?: RoleSlot };

function roleSwaps(analysis: VideoDnaAnalysis, characters: CharacterCandidate[]): Swap[] {
  return characters.map((c, index) => {
    const role = analysis.source_roles[index];
    const source = resolveSourceRoleEntity(role);
    const targetSpecies = shortSpecies(resolveCharacterEntity(c).species);
    const from = lexiconOf(source.species);
    const differs = shortSpecies(source.species) !== targetSpecies;
    // 旧分析沿用原判定（新旧都不在词表里也算没换）；有槽位时不靠词表认物种，只有同一词表里的变体（三花猫→橘猫）不算换。
    const changed = role?.slot ? differs && !(from && from === lexiconOf(targetSpecies)) : differs && from !== lexiconOf(targetSpecies);
    return { id: c.character_id, roleId: role?.role_id ?? '', source, from, changed, targetSpecies, slot: role?.slot };
  });
}

/** 换了物种的源角色（role_id）。保留与重写两种模式共用这一个判定。 */
export function swappedRoleIds(analysis: VideoDnaAnalysis, characters: CharacterCandidate[]): string[] {
  return roleSwaps(analysis, characters).filter(swap => swap.changed).map(swap => swap.roleId);
}

/**
 * 在一段出片文字里找被换角色的原有说法。确定性、零调用。
 * CHAR_X（新物种）括号里是替换后的新说法，不算残留（猫→猫头鹰时「猫」会出现在括号里）。
 */
export function findRoleLeaks(text: string, analysis: VideoDnaAnalysis, roleIds: string[], where = ''): RoleLeak[] {
  const swapped = new Set(roleIds);
  if (!text || !swapped.size) return [];
  const blocked = blockedTerms(analysis, swapped);
  const masked = [...text.matchAll(/CHAR_[A-Z0-9_]+（[^）]*）/g)].map(m => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const leaks: RoleLeak[] = [];
  analysis.source_roles.forEach((role, index) => {
    if (!swapped.has(role.role_id)) return;
    const seen = new Set<string>();
    const entries = (Object.entries(roleTerms(role)) as [Kind, string[]][])
      .flatMap(([kind, list]) => list.map(term => ({ term, kind })))
      .filter(({ term }) => !clashes(term, blocked) && !seen.has(term.toLowerCase()) && Boolean(seen.add(term.toLowerCase())));
    if (!entries.length) return;
    const exact = entries.map(entry => ({ ...entry, test: new RegExp(`^(?:${termPattern(entry.term)})$`, 'i') }));
    for (const match of text.matchAll(new RegExp(alternation(entries.map(e => e.term)), 'gi'))) {
      const at = match.index ?? 0;
      if (masked.some(([from, to]) => at >= from && at < to)) continue;
      const hit = exact.find(entry => entry.test.test(match[0]));
      if (!hit) continue;
      leaks.push({ roleId: role.role_id, characterId: `CHAR_${String.fromCharCode(65 + index)}`, term: hit.term, kind: hit.kind, where, index: at, excerpt: text.slice(Math.max(0, at - 10), at + match[0].length + 10).replace(/\s+/g, ' ') });
    }
  });
  return leaks;
}

export function buildRoleSwapAdapter(analysis: VideoDnaAnalysis, brief: Pick<RemixBrief, 'roleDesigns'>, characters: CharacterCandidate[]): TextAdapter {
  const sourceMedium = analysis.style_dna.visual.medium.trim();
  const steps: ((value: string) => string)[] = [];
  const swaps = roleSwaps(analysis, characters);
  const blocked = blockedTerms(analysis, new Set(swaps.filter(swap => swap.changed).map(swap => swap.roleId)));
  for (const swap of swaps) {
    if (!swap.changed) continue;
    const mention = `${swap.id}（${swap.targetSpecies}）`;
    const targetSound = lexiconOf(swap.targetSpecies)?.sound ?? `${swap.targetSpecies}发出的声音`;
    if (swap.slot) {
      // 同类角色没换时，内置词表的词（三花、小猫）说不清指谁，只用槽位里的专属词。
      const sameKindKept = swaps.some(other => other !== swap && !other.changed && other.from && other.from === swap.from);
      const own = roleTerms(analysis.source_roles.find(item => item.role_id === swap.roleId)!, !sameKindKept);
      const usable = (list: string[]) => list.filter(term => !clashes(term, blocked));
      const parts = sameKindKept ? [] : (swap.from?.parts ?? []).filter(([part]) => !clashes(part, blocked));
      const partNames = new Set(parts.map(([part]) => part));
      const sounds = usable(own.voice);
      const looks = usable(own.appearance);
      const nouns = usable(own.species).filter(term => !partNames.has(term));
      steps.push(value => {
        let out = value;
        // 「企鹅嘎嘎叫声」这种「物种+叫声」名词整体换成新角色的声音，免得留下「CHAR_A（机器人）机器人发出的声音」；
        // 「小猫喵了一声」里的物种是主语，不能吞掉，只换叫声本身。
        const soundNouns = sounds.filter(term => /声$/.test(term));
        if (soundNouns.length && nouns.length) out = out.replace(new RegExp(`(?:${alternation(nouns)})的?(?:${alternation(soundNouns)})`, 'gi'), targetSound);
        if (sounds.length) out = out.replace(new RegExp(alternation(sounds), 'gi'), targetSound);
        for (const [part, neutral] of parts) out = out.split(part).join(neutral);
        // 外观词：带「色/色彩/花色」的是配色说法，换成角色图配色；单独的形容（黑白羽毛的）直接去掉。
        if (looks.length) {
          const dropped = out.replace(new RegExp(`(?:${alternation(looks)})(色彩|花色|毛色|配色|色)?(的)?`, 'gi'), (_m, color?: string, of?: string) => color ? `角色图配色${of ?? ''}` : '');
          // 去掉外观词后落单的连接词（「黑白羽毛与橙色喙」→「与」）一并清掉。
          if (dropped !== out) out = dropped.replace(/(^|[；;、，,。\s])(?:与|和|及)(?=[；;、，,。\s]|$)/g, '$1');
        }
        return nouns.length ? out.replace(new RegExp(`(?:${escape(swap.id)}\\s*)?(?:${alternation(nouns)})`, 'gi'), mention) : out;
      });
      continue;
    }
    // 另一个没换物种的角色也是同类时，「小猫」到底指谁说不清，宁可不替换。
    if (swaps.some(other => other !== swap && !other.changed && other.from && other.from === swap.from)) continue;
    const sourceName = shortSpecies(swap.source.species);
    const nouns = [...new Set([sourceName, ...(swap.from?.nouns ?? [])])].filter(n => n && !/^(人类|human)$/i.test(n)).sort((a, b) => b.length - a.length);
    if (!nouns.length) continue;
    const from = swap.from;
    steps.push(value => {
      let out = value;
      if (from) {
        for (const sound of [...from.sounds].sort((a, b) => b.length - a.length)) out = out.split(sound).join(targetSound);
        for (const [part, neutral] of from.parts) out = out.split(part).join(neutral);
        for (const coat of from.coats) out = out.replace(new RegExp(`${escape(coat)}(色彩|花色|色)?`, 'g'), '角色图配色');
      }
      return out.replace(new RegExp(`(?:${escape(swap.id)}\\s*)?(?:${nouns.map(escape).join('|')})`, 'g'), mention);
    });
  }
  // 画面介质：用户在角色设计里明确定了画风，才覆盖源片的介质；只改了 casting_envelope 不算。
  const media = [...new Set(characters.map(c => (brief.roleDesigns?.[c.source_role_id]?.visual_medium || c.design_settings?.visual_medium || '').trim()).filter(Boolean))];
  const medium = media.length && !media.includes(sourceMedium) ? media.join('、') : undefined;
  if (medium) {
    const keepsRealism = /写实|实拍|真人|realistic|live-action/i.test(medium);
    steps.push(value => {
      let out = sourceMedium ? value.split(sourceMedium).join(medium) : value;
      if (!keepsRealism) out = out.replace(REALISM, '');
      return out;
    });
  }
  return { text: value => steps.reduce((out, step) => step(out), value), medium };
}

/** 对白、角色编号与英文副本不动；只改写镜头里的描述文字。 */
export function adaptBeatText<T extends object>(beat: T, adapt: (value: string) => string): T {
  const skip = new Set(['dialogue', 'dialogue_speaker_ids', 'character_ids', 'actor_ids', 'toward_ids', 'beat_id', 'english', 'video_prompt']);
  const walk = (value: unknown, key = ''): unknown => {
    if (skip.has(key)) return value;
    if (typeof value === 'string') return adapt(value);
    if (Array.isArray(value)) return value.map(item => walk(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  return walk(beat) as T;
}
