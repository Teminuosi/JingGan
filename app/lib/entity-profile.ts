import type {
  AnthropomorphismLevel,
  CastingEnvelope,
  CharacterBible,
  CharacterCandidate,
  EntityType,
  SourceRole,
  VideoDnaAnalysis,
} from './types';

export interface ResolvedEntityProfile {
  entity_type: EntityType;
  species: string;
  body_plan: string;
  anthropomorphism_level: AnthropomorphismLevel;
}

export const CASTING_ENVELOPE_FIELDS = [
  'apparent_age_band',
  'gender_expression',
  'regional_visual_context',
  'build_silhouette',
  'hair_grooming',
  'wardrobe_function',
  'visual_medium',
] as const;

const ANIMAL_SPECIES: Array<[RegExp, string]> = [
  [/(?:橘猫|家猫|小猫|猫咪|猫|kitten|domestic cat|\bcat\b)/i, '家猫 / domestic cat'],
  [/(?:小狗|狗狗|家犬|犬|狗|puppy|domestic dog|\bdog\b)/i, '家犬 / domestic dog'],
  [/(?:兔子|兔|rabbit|bunny)/i, '兔 / rabbit'],
  [/(?:狐狸|fox)/i, '狐狸 / fox'],
  [/(?:熊猫|panda)/i, '熊猫 / panda'],
  [/(?:老虎|tiger)/i, '虎 / tiger'],
  [/(?:狮子|lion)/i, '狮 / lion'],
  [/(?:鸟|鹦鹉|企鹅|鸭|鸡|bird|parrot|penguin|duck)/i, '鸟类 / bird'],
  [/(?:鱼|鲸|海豚|鲨|fish|whale|dolphin|shark)/i, '水生动物 / aquatic animal'],
  [/(?:马|牛|羊|猪|鹿|猴|猩猩|松鼠|浣熊|水獭|horse|cow|sheep|pig|deer|monkey|gorilla|squirrel|raccoon|otter)/i, '非人类动物 / non-human animal'],
];

const ANTHROPOMORPHIC_PATTERN = /拟人|人形|直立行走|会说话|类人|anthropomorphic|human[- ]?like|humanoid/i;
const ROBOT_PATTERN = /机器人|机械人|机甲角色|robot|android|mech/i;
const OBJECT_PATTERN = /拟人(?:水果|蔬菜|物体|食物|器物)|会说话的(?:水果|蔬菜|物体|食物|器物)|anthropomorphic (?:object|fruit|food|vehicle)/i;
const CREATURE_PATTERN = /怪物|精灵|龙|幻想生物|外星生物|monster|creature|dragon|alien/i;

function suppliedProfile(value: SourceRole | CharacterBible): ResolvedEntityProfile | null {
  if (!value.entity_type || !value.species?.trim() || !value.body_plan?.trim() || !value.anthropomorphism_level) return null;
  return {
    entity_type: value.entity_type,
    species: value.species.trim(),
    body_plan: value.body_plan.trim(),
    anthropomorphism_level: value.anthropomorphism_level,
  };
}

function suppliedCastingEnvelope(value: SourceRole | CharacterBible): CastingEnvelope | null {
  const envelope = value.casting_envelope;
  if (!envelope || CASTING_ENVELOPE_FIELDS.some((field) => !envelope[field]?.trim())) return null;
  return Object.fromEntries(CASTING_ENVELOPE_FIELDS.map((field) => [field, envelope[field].trim()])) as unknown as CastingEnvelope;
}

export function resolveSourceRoleEntity(role: SourceRole): ResolvedEntityProfile {
  const supplied = suppliedProfile(role);
  if (supplied) return supplied;
  const evidence = [
    role.narrative_function,
    role.generalized_appearance,
    role.silhouette,
    role.wardrobe_logic,
    ...role.performance_traits,
    ...role.continuity_anchors,
  ].join(' ');
  const animal = ANIMAL_SPECIES.find(([pattern]) => pattern.test(evidence));
  if (animal) {
    // Performance (talking, cooking, standing) is not evidence of human anatomy.
    const anatomy = [role.generalized_appearance, role.silhouette, role.body_plan].filter(Boolean).join(' ');
    const anthropomorphic = /人形(?:身体|躯干|骨架)|类人(?:身体|躯干|骨架)|humanoid (?:body|torso|skeleton)|human-shaped (?:body|torso)/i.test(anatomy);
    return {
      entity_type: anthropomorphic ? 'anthropomorphic_animal' : 'animal',
      species: animal[1],
      body_plan: role.silhouette || role.generalized_appearance || '物种对应的完整身体结构',
      anthropomorphism_level: anthropomorphic ? 'full' : 'none',
    };
  }
  if (OBJECT_PATTERN.test(evidence)) {
    return {
      entity_type: 'anthropomorphic_object',
      species: '拟人物体角色 / anthropomorphic object character',
      body_plan: role.silhouette || role.generalized_appearance || '物体原型对应的完整角色结构',
      anthropomorphism_level: 'full',
    };
  }
  if (ROBOT_PATTERN.test(evidence)) {
    return {
      entity_type: 'robot',
      species: '机器人 / robot',
      body_plan: role.silhouette || role.generalized_appearance || '机器人结构',
      anthropomorphism_level: ANTHROPOMORPHIC_PATTERN.test(evidence) ? 'full' : 'partial',
    };
  }
  if (CREATURE_PATTERN.test(evidence)) {
    return {
      entity_type: 'creature',
      species: '幻想生物 / creature',
      body_plan: role.silhouette || role.generalized_appearance || '生物原型对应的完整身体结构',
      anthropomorphism_level: ANTHROPOMORPHIC_PATTERN.test(evidence) ? 'full' : 'partial',
    };
  }
  return {
    entity_type: 'human',
    species: '人类 / human',
    body_plan: role.silhouette || '成年双足人类身体结构',
    anthropomorphism_level: 'none',
  };
}

export function resolveCharacterEntity(character: CharacterBible): ResolvedEntityProfile {
  return suppliedProfile(character) ?? {
    entity_type: 'human',
    species: '人类 / human',
    body_plan: '成年双足人类身体结构',
    anthropomorphism_level: 'none',
  };
}

export function resolveSourceRoleCastingEnvelope(role: SourceRole, visualMedium = ''): CastingEnvelope {
  const supplied = suppliedCastingEnvelope(role);
  if (supplied) return supplied;
  const appearance = role.generalized_appearance.trim() || '未明确，保持源角色的宽泛呈现范围';
  return {
    apparent_age_band: `保持源角色描述中的表观生命阶段：${appearance}`,
    gender_expression: `保持源角色描述中的性别表达：${appearance}`,
    regional_visual_context: `保持源角色描述中的地域视觉语境：${appearance}`,
    build_silhouette: role.silhouette.trim() || role.body_plan?.trim() || '保持源角色的身体量级与轮廓',
    hair_grooming: `保持源角色描述中的发型、毛发或表面整理逻辑：${appearance}`,
    wardrobe_function: role.wardrobe_logic.trim() || '保持源角色的服装、露肤或配饰功能',
    visual_medium: visualMedium.trim() || '保持源视频的视觉媒介与写实程度',
  };
}

export function resolveCharacterCastingEnvelope(character: CharacterBible): CastingEnvelope {
  const supplied = suppliedCastingEnvelope(character);
  if (supplied) return supplied;
  const appearance = character.appearance.trim() || '保持已保存角色的宽泛呈现范围';
  return {
    apparent_age_band: `保持已保存角色的表观生命阶段：${appearance}`,
    gender_expression: `保持已保存角色的性别表达：${appearance}`,
    regional_visual_context: `保持已保存角色的地域视觉语境：${appearance}`,
    build_silhouette: appearance,
    hair_grooming: appearance,
    wardrobe_function: character.wardrobe.trim() || '保持已保存角色的服装或配饰功能',
    visual_medium: '保持已保存角色参考图的视觉媒介与写实程度',
  };
}

export function normalizeVideoDnaEntityProfiles(analysis: VideoDnaAnalysis): VideoDnaAnalysis {
  return {
    ...analysis,
    source_roles: analysis.source_roles.map((role) => ({
      ...role,
      ...resolveSourceRoleEntity(role),
      casting_envelope: resolveSourceRoleCastingEnvelope(role, analysis.style_dna.visual.medium),
    })),
  };
}

export function sameEntityProfile(left: ResolvedEntityProfile, right: ResolvedEntityProfile): boolean {
  return left.entity_type === right.entity_type &&
    left.species === right.species &&
    left.body_plan === right.body_plan &&
    left.anthropomorphism_level === right.anthropomorphism_level;
}

export function sameCastingEnvelope(left: CastingEnvelope, right: CastingEnvelope): boolean {
  return CASTING_ENVELOPE_FIELDS.every((field) => left[field].trim() === right[field].trim());
}

export function castingDriftField(source: CastingEnvelope, candidate: CastingEnvelope, mode?: CharacterCandidate['design_mode'], settings?: CharacterCandidate['design_settings']) {
  return CASTING_ENVELOPE_FIELDS.find(field =>
    !(mode === 'style_variant' && (field === 'hair_grooming' || (field === 'visual_medium' && !settings?.visual_medium?.trim()))) &&
    source[field].trim() !== candidate[field].trim());
}

export function animalAnatomyInstruction(profile: EntityProfileLike): string {
  if (profile.entity_type !== 'animal' && profile.entity_type !== 'anthropomorphic_animal') return '';
  return `身体约束：保持${profile.species}的既定身体结构（${profile.body_plan}）。美术风格只改变外观表现，不改变骨架、肢体数量、关节与足爪结构；站立、拿道具等只在指定动作发生时表现，不据此添加人类躯干、手掌或全片双足行走习惯。`;
}

type EntityProfileLike = Pick<ResolvedEntityProfile, 'entity_type' | 'species' | 'body_plan'>;

export function assertAnimalAnatomyText(character: CharacterBible & { reference_image_prompt?: string }) {
  if (resolveCharacterEntity(character).entity_type !== 'animal') return;
  const text = [character.appearance, character.wardrobe, character.reference_image_prompt, ...character.identity_anchors, ...character.continuity_lock].filter(Boolean).join('\n');
  const humanAnatomy = /人(?:类|形)的?(?:躯干|身体|骨架|手掌|手脚)|双足(?:直立)?行走|humanoid (?:body|torso|skeleton)|human (?:body|torso|hands|feet)|bipedal (?:walking|gait|locomotion)/gi;
  for (const clause of text.split(/[。；;.!?\n]/)) {
    for (const match of clause.matchAll(humanAnatomy)) {
      const prefix = clause.slice(0, match.index);
      if (/(?:禁止|不得|不能|不要|避免|无|不添加|不使用|不变成|不据此添加|\bno\b|\bnot\b|\bwithout\b|\bforbid\w*\b|\bavoid\w*\b)/i.test(prefix)) continue;
      throw new Error(`${character.character_id} 的文字把自然动物描述为“${match[0]}”；请修正身体描述，不能只在物种字段里写动物。`);
    }
  }
}

export function formatCastingEnvelope(envelope: CastingEnvelope): string {
  return CASTING_ENVELOPE_FIELDS.map((field) => `${field}=${envelope[field]}`).join('; ');
}

export function isHumanEntity(profile: ResolvedEntityProfile): boolean {
  return profile.entity_type === 'human';
}
