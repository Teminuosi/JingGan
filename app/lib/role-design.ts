import type { CharacterCandidate, RoleDesignSettings, SourceRole } from './types';
import { resolveSourceRoleCastingEnvelope, resolveSourceRoleEntity } from './entity-profile';

/** User choices describe a target; the analysis remains an immutable reference. */
export function applyRoleDesign(role: SourceRole, settings?: RoleDesignSettings, medium = ''): SourceRole {
  if (!settings || !Object.values(settings).some(v => typeof v === 'string' && v.trim())) return role;
  const original = resolveSourceRoleEntity(role);
  const changedEntity = Boolean(settings.entity_type && settings.entity_type !== original.entity_type) || Boolean(settings.species?.trim() && settings.species.trim() !== original.species);
  const entity = { ...original };
  if (settings.entity_type) entity.entity_type = settings.entity_type;
  else if (settings.species?.trim() && settings.species.trim() !== original.species) {
    if (/^(人类|human)(\s|\/|$)/i.test(settings.species)) entity.entity_type = 'human';
    else if (/猫|犬|狗|兔|熊|狐狸|cat|dog|rabbit|fox/i.test(settings.species) && original.entity_type === 'human') entity.entity_type = 'animal';
  }
  if (changedEntity && entity.entity_type !== 'human' && !settings.species?.trim()) throw new Error('更换角色类型时，请填写目标物种或角色名称。');
  if (settings.species?.trim()) entity.species = settings.species.trim();
  else if (changedEntity && entity.entity_type === 'human') entity.species = '人类 / human';
  if (changedEntity) {
    entity.anthropomorphism_level = entity.entity_type === 'human' || entity.entity_type === 'animal' ? 'none' : 'full';
    entity.body_plan = settings.body_plan?.trim() || (entity.entity_type === 'human' ? '成年双足人类身体结构' : `${entity.species}的完整身体结构${entity.entity_type === 'anthropomorphic_animal' ? '，拟人双足结构' : '，保持该物种正常骨架、肢体和关节'}`);
  } else if (settings.body_plan?.trim()) entity.body_plan = settings.body_plan.trim();
  const casting = { ...resolveSourceRoleCastingEnvelope(role, medium) };
  if (changedEntity) {
    casting.apparent_age_band = '成年';
    casting.gender_expression = '不限定性别表达';
    casting.build_silhouette = entity.body_plan;
    casting.hair_grooming = `${entity.species}的自然毛发或表面特征`;
    casting.regional_visual_context = '由目标角色设定决定';
  }
  for (const key of ['gender_expression', 'apparent_age_band', 'build_silhouette', 'wardrobe_function', 'visual_medium'] as const) {
    if (settings[key]?.trim()) casting[key] = settings[key]!.trim();
  }
  const changedAppearance = changedEntity || settings.gender_expression || settings.apparent_age_band || settings.build_silhouette;
  return { ...role, ...entity, casting_envelope: casting,
    generalized_appearance: changedAppearance ? `${entity.species}；${casting.gender_expression}；${casting.apparent_age_band}；${settings.prompt || ''}` : role.generalized_appearance,
    silhouette: changedEntity ? entity.body_plan : role.silhouette,
    wardrobe_logic: settings.wardrobe_function?.trim() || role.wardrobe_logic,
  };
}

export function roleForCandidate(role: SourceRole, candidate: Pick<CharacterCandidate, 'design_settings'>, medium = '') {
  return applyRoleDesign(role, candidate.design_settings, medium);
}
