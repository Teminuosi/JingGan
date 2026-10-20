import type { CharacterCandidate, RemixBrief, VideoDnaAnalysis } from './types';
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

export function buildRoleSwapAdapter(analysis: VideoDnaAnalysis, brief: Pick<RemixBrief, 'roleDesigns'>, characters: CharacterCandidate[]): TextAdapter {
  const sourceMedium = analysis.style_dna.visual.medium.trim();
  const steps: ((value: string) => string)[] = [];
  const swaps = characters.map((c, index) => {
    const source = resolveSourceRoleEntity(analysis.source_roles[index]);
    const targetSpecies = shortSpecies(resolveCharacterEntity(c).species);
    const from = lexiconOf(source.species);
    const changed = shortSpecies(source.species) !== targetSpecies && from !== lexiconOf(targetSpecies);
    return { id: c.character_id, source, from, changed, targetSpecies };
  });
  for (const swap of swaps) {
    if (!swap.changed) continue;
    // 另一个没换物种的角色也是同类时，「小猫」到底指谁说不清，宁可不替换。
    if (swaps.some(other => other !== swap && !other.changed && other.from && other.from === swap.from)) continue;
    const sourceName = shortSpecies(swap.source.species);
    const nouns = [...new Set([sourceName, ...(swap.from?.nouns ?? [])])].filter(n => n && !/^(人类|human)$/i.test(n)).sort((a, b) => b.length - a.length);
    if (!nouns.length) continue;
    const mention = `${swap.id}（${swap.targetSpecies}）`;
    const targetSound = lexiconOf(swap.targetSpecies)?.sound ?? `${swap.targetSpecies}发出的声音`;
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
