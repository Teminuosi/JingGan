import { applyRoleDesign } from './role-design';
import { dialogueScriptMatches } from './dialogue-languages';
import type { RoleDesignSettings } from './types';
import { REQUIRED_PROMPT_BLOCKS, SEEDANCE_MAX_RUN_SECONDS, projectCharacterSwapBeats, projectCharacterSwapStyle } from './compiler';
import { normalizeMinuteSecondTimeline } from './timeline-normalization.mjs';
import { ORIGINAL_PROMPT_CHARACTER_LIMIT, ORIGINAL_PROMPT_SAFETY_LIMIT, runMaxSecondsFor } from './original-story';
import type {
  ActionBeat,
  CastingEnvelope,
  CharacterBible,
  CharacterCandidate,
  CharacterProposals,
  CreativeBeat,
  CreativeDraft,
  CreativePack,
  RemixMode,
  SeedanceRun,
  SourceRole,
  TimelineException,
  VideoBeat,
  VideoDnaAnalysis,
} from './types';
import {
  CASTING_ENVELOPE_FIELDS,
  castingDriftField,
  assertAnimalAnatomyText,
  resolveCharacterCastingEnvelope,
  resolveCharacterEntity,
  resolveSourceRoleCastingEnvelope,
  resolveSourceRoleEntity,
  sameCastingEnvelope,
  sameEntityProfile,
} from './entity-profile';
import { minimumDifferentiationAxes } from './remix-policy';
import { normalizeKnownSourceRoleReferences } from './role-references';
import { describeDrift, normalizeModelDrift } from './normalize-drift';

const TIMELINE_EPSILON_SECONDS = 0.01;
const INTERNAL_CUT_PATTERN =
  /(?:切到|切至|切回|跳切|硬切|特写切|景别切|正反打|反打|镜头切换|\bcut(?:s)?(?:\s+to|\s+back)?\b|shot\s*\/\s*reverse|→|->)/i;
const ENTITY_TYPES = ['human', 'animal', 'anthropomorphic_animal', 'anthropomorphic_object', 'creature', 'robot', 'unknown'] as const;
const ANTHROPOMORPHISM_LEVELS = ['none', 'partial', 'full', 'unknown'] as const;
const SOURCE_FACE_COPY_PATTERN = /(?:必须|要求|直接|完全照着|一比一).{0,16}(?:复刻|复制|还原).{0,20}(?:源视频|原视频|源人物|原人物|源脸|原脸|五官|长相)|(?:use|copy|reproduce|match)\s+(?:the\s+)?exact\s+(?:source|original)\s+(?:face|person|likeness)/i;

export interface CreativePackValidationContext {
  analysis?: VideoDnaAnalysis;
  validateCompiledPrompts?: boolean;
  allowSourceDialogue?: boolean;
  remixMode?: RemixMode;
  selectedCharacters?: CharacterCandidate[];
}

interface TimelineItem {
  beat_id: string;
  start_seconds: number;
  end_seconds: number;
  timeline_exception?: TimelineException;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label}格式无效。`);
  return value;
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`${label}必须是${allowEmpty ? '' : '非空'}字符串。`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是有效数字。`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值。`);
  return value;
}

function requireArray(value: unknown, label: string, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${label}格式无效。`);
  return value;
}

function requireStringArray(value: unknown, label: string, minimum = 0): string[] {
  const items = requireArray(value, label, minimum);
  items.forEach((item, index) => requireString(item, `${label}第 ${index + 1} 项`));
  return items as string[];
}

function assertUniqueStrings(values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label}包含重复 ID：${value}`);
    seen.add(value);
  }
}

function assertTimelineException(value: unknown, label: string): asserts value is TimelineException {
  const exception = requireRecord(value, label);
  if (exception.kind !== 'gap' && exception.kind !== 'overlap') {
    throw new Error(`${label}.kind 必须是 gap 或 overlap。`);
  }
  if (requireFiniteNumber(exception.duration_seconds, `${label}.duration_seconds`) <= 0) {
    throw new Error(`${label}.duration_seconds 必须大于 0。`);
  }
  requireString(exception.reason, `${label}.reason`);
}

function assertEntityProfile(value: Record<string, unknown>, label: string) {
  if (!ENTITY_TYPES.includes(String(value.entity_type) as (typeof ENTITY_TYPES)[number])) {
    throw new Error(`${label}.entity_type 无效。`);
  }
  requireString(value.species, `${label}.species`);
  requireString(value.body_plan, `${label}.body_plan`);
  if (!ANTHROPOMORPHISM_LEVELS.includes(String(value.anthropomorphism_level) as (typeof ANTHROPOMORPHISM_LEVELS)[number])) {
    throw new Error(`${label}.anthropomorphism_level 无效。`);
  }
}

function assertCastingEnvelope(value: unknown, label: string): asserts value is CastingEnvelope {
  const envelope = requireRecord(value, label);
  for (const field of CASTING_ENVELOPE_FIELDS) requireString(envelope[field], `${label}.${field}`);
}

function assertVideoDnaShape(value: unknown): asserts value is VideoDnaAnalysis {
  const root = requireRecord(value, '视频 DNA');
  if (root.schema_version !== 'video-dna.v1') throw new Error('Gemini 返回的不是 video-dna.v1 数据。');
  const source = requireRecord(root.source, 'source');
  if (requireFiniteNumber(source.duration_seconds, 'source.duration_seconds') <= 0) throw new Error('source.duration_seconds 必须大于 0。');
  requireString(source.aspect_ratio, 'source.aspect_ratio');
  requireString(source.language, 'source.language');
  requireString(source.format_type, 'source.format_type');
  requireString(source.one_line_summary, 'source.one_line_summary');
  requireStringArray(source.rights_risks, 'source.rights_risks');

  const style = requireRecord(root.style_dna, 'style_dna');
  requireString(style.hook_pattern, 'style_dna.hook_pattern');
  requireStringArray(style.narrative_arc, 'style_dna.narrative_arc', 1);
  const pacing = requireRecord(style.pacing, 'style_dna.pacing');
  requireString(pacing.description, 'style_dna.pacing.description');
  requireFiniteNumber(pacing.average_shot_seconds, 'style_dna.pacing.average_shot_seconds');
  requireStringArray(pacing.energy_curve, 'style_dna.pacing.energy_curve', 1);
  requireString(pacing.cut_pattern, 'style_dna.pacing.cut_pattern');
  const cinematography = requireRecord(style.cinematography, 'style_dna.cinematography');
  requireStringArray(cinematography.framing_pattern, 'style_dna.cinematography.framing_pattern');
  requireStringArray(cinematography.camera_motion_pattern, 'style_dna.cinematography.camera_motion_pattern');
  requireString(cinematography.lens_feel, 'style_dna.cinematography.lens_feel');
  requireStringArray(cinematography.composition_rules, 'style_dna.cinematography.composition_rules');
  requireStringArray(cinematography.continuity_rules, 'style_dna.cinematography.continuity_rules');
  const visual = requireRecord(style.visual, 'style_dna.visual');
  requireString(visual.medium, 'style_dna.visual.medium');
  requireStringArray(visual.palette, 'style_dna.visual.palette');
  requireString(visual.lighting_logic, 'style_dna.visual.lighting_logic');
  requireStringArray(visual.textures, 'style_dna.visual.textures');
  requireString(visual.atmosphere, 'style_dna.visual.atmosphere');
  const performance = requireRecord(style.performance, 'style_dna.performance');
  requireString(performance.energy, 'style_dna.performance.energy');
  requireString(performance.gesture_language, 'style_dna.performance.gesture_language');
  requireString(performance.facial_language, 'style_dna.performance.facial_language');
  requireString(performance.blocking_pattern, 'style_dna.performance.blocking_pattern');
  const audio = requireRecord(style.audio, 'style_dna.audio');
  requireString(audio.dialogue_delivery, 'style_dna.audio.dialogue_delivery');
  requireString(audio.music_logic, 'style_dna.audio.music_logic');
  requireStringArray(audio.sound_effects, 'style_dna.audio.sound_effects');
  requireString(audio.beat_sync, 'style_dna.audio.beat_sync');

  requireArray(root.source_roles, 'source_roles', 1).forEach((item, index) => {
    const role = requireRecord(item, `source_roles 第 ${index + 1} 项`);
    assertEntityProfile(role, `source_roles 第 ${index + 1} 项`);
    assertCastingEnvelope(role.casting_envelope, `source_roles 第 ${index + 1} 项 casting_envelope`);
    requireString(role.role_id, `source_roles 第 ${index + 1} 项 role_id`);
    requireString(role.narrative_function, `source_roles 第 ${index + 1} 项 narrative_function`);
    requireString(role.generalized_appearance, `source_roles 第 ${index + 1} 项 generalized_appearance`);
    requireString(role.silhouette, `source_roles 第 ${index + 1} 项 silhouette`);
    requireString(role.wardrobe_logic, `source_roles 第 ${index + 1} 项 wardrobe_logic`);
    requireStringArray(role.performance_traits, `source_roles 第 ${index + 1} 项 performance_traits`);
    requireStringArray(role.continuity_anchors, `source_roles 第 ${index + 1} 项 continuity_anchors`);
    if (!['none', 'real_person', 'celebrity_or_ip', 'uncertain'].includes(String(role.identity_risk))) {
      throw new Error(`source_roles 第 ${index + 1} 项 identity_risk 无效。`);
    }
  });

  requireArray(root.beats, 'beats', 1).forEach((item, index) => {
    const beat = requireRecord(item, `beats 第 ${index + 1} 项`);
    requireString(beat.beat_id, `beats 第 ${index + 1} 项 beat_id`);
    requireFiniteNumber(beat.start_seconds, `beats 第 ${index + 1} 项 start_seconds`);
    requireFiniteNumber(beat.end_seconds, `beats 第 ${index + 1} 项 end_seconds`);
    requireStringArray(beat.role_ids, `beats 第 ${index + 1} 项 role_ids`);
    requireStringArray(beat.props, `beats 第 ${index + 1} 项 props`);
    for (const field of ['narrative_function', 'visual_action', 'environment', 'framing', 'camera_motion', 'composition', 'lighting', 'color', 'sound', 'transition_in', 'continuity_in', 'continuity_out']) {
      requireString(beat[field], `beats 第 ${index + 1} 项 ${field}`, field === 'transition_in');
    }
    const dialogue = requireRecord(beat.dialogue, `beats 第 ${index + 1} 项 dialogue`);
    requireString(dialogue.speaker_role, `beats 第 ${index + 1} 项 dialogue.speaker_role`, true);
    requireBoolean(dialogue.speaker_on_screen, `beats 第 ${index + 1} 项 dialogue.speaker_on_screen`);
    requireString(dialogue.source_text, `beats 第 ${index + 1} 项 dialogue.source_text`, true);
    requireString(dialogue.semantic_intent, `beats 第 ${index + 1} 项 dialogue.semantic_intent`);
    requireString(dialogue.delivery, `beats 第 ${index + 1} 项 dialogue.delivery`, true);
    const count = requireFiniteNumber(dialogue.approx_characters, `beats 第 ${index + 1} 项 dialogue.approx_characters`);
    if (!Number.isInteger(count) || count < 0) throw new Error(`beats 第 ${index + 1} 项 dialogue.approx_characters 无效。`);
    const confidence = requireFiniteNumber(beat.confidence, `beats 第 ${index + 1} 项 confidence`);
    if (confidence < 0 || confidence > 1) throw new Error(`beats 第 ${index + 1} 项 confidence 必须在 0 到 1 之间。`);
    assertActionBeats(beat.action_beats, `beats 第 ${index + 1} 项`, Number(beat.start_seconds), Number(beat.end_seconds));
    assertBlocking(beat.blocking, `beats 第 ${index + 1} 项`, Number(beat.start_seconds), Number(beat.end_seconds),
      Array.isArray(beat.role_ids) ? beat.role_ids.map(String) : []);
    if (beat.corrected_by_user !== undefined) requireBoolean(beat.corrected_by_user, `beats 第 ${index + 1} 项 corrected_by_user`);
    if (beat.timeline_exception !== undefined) assertTimelineException(beat.timeline_exception, `beats 第 ${index + 1} 项 timeline_exception`);
  });
  requireStringArray(root.preserve_recommendations, 'preserve_recommendations');
  requireStringArray(root.replace_recommendations, 'replace_recommendations');
  requireStringArray(root.originality_risks, 'originality_risks');
  requireStringArray(root.uncertainties, 'uncertainties');
}

const SCREEN_POSITIONS = ['left', 'center_left', 'center', 'center_right', 'right', 'offscreen'];
const DEPTH_LAYERS = ['foreground', 'midground', 'background'];
const BLOCKING_ENUMS: Record<string, string[]> = {
  shot_size: ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS', 'unknown'],
  angle: ['eye_level', 'high', 'low', 'overhead', 'dutch', 'over_shoulder', 'pov', 'unknown'],
  movement: ['static', 'pan', 'tilt', 'dolly_in', 'dolly_out', 'truck', 'crane', 'handheld', 'zoom', 'orbit', 'unknown'],
  screen_direction: ['left_to_right', 'right_to_left', 'toward_camera', 'away_from_camera', 'static', 'unknown'],
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

/**
 * 空间信息校验。旧 DNA 没有 blocking，缺失放行；一旦存在就必须可信。
 *
 * 这里挡的是「模型填了但填错」：枚举写成散文、入画时间落在镜头外、站位引用本镜没有的角色。
 * 这些错一旦流进 3D 预演，渲出来就是错误的空间关系，而它还会以
 * 「已按 3D 预演锁定」的名义写进提示词——比没有更糟。
 */
function assertBlocking(value: unknown, label: string, start: number, end: number, roleIds: string[]) {
  if (value === undefined || value === null) return;
  const blocking = asRecord(value, `${label} blocking`);
  const actors = requireArray(blocking.actors, `${label} blocking.actors`);
  const seen = new Set<string>();
  actors.forEach((raw, i) => {
    const scope = `${label} blocking.actors 第 ${i + 1} 项`;
    const actor = asRecord(raw, scope);
    const roleId = requireString(actor.role_id, `${scope} role_id`);
    if (seen.has(roleId)) throw new Error(`${scope} 角色 ${roleId} 重复。`);
    seen.add(roleId);
    if (roleIds.length && !roleIds.includes(roleId)) {
      throw new Error(`${scope} 角色 ${roleId} 不在本镜 role_ids 里。`);
    }
    if (!SCREEN_POSITIONS.includes(String(actor.screen_position))) {
      throw new Error(`${scope} screen_position 必须是 ${SCREEN_POSITIONS.join(' / ')}。`);
    }
    if (!DEPTH_LAYERS.includes(String(actor.depth_layer))) {
      throw new Error(`${scope} depth_layer 必须是 ${DEPTH_LAYERS.join(' / ')}。`);
    }
    for (const key of ['entry_at', 'exit_at'] as const) {
      const v = actor[key];
      if (v === undefined || v === null) continue;
      const n = Number(v);
      // 入画/出画是绝对秒数，必须落在本镜区间内，
      // 否则 3D 预演会按一个根本不在这一镜里的时间点安排走位。
      if (!Number.isFinite(n) || n < start - 0.001 || n > end + 0.001) {
        throw new Error(`${scope} ${key}=${String(v)} 不在本镜 ${start}–${end} 秒内。`);
      }
    }
  });

  const camera = asRecord(blocking.camera, `${label} blocking.camera`);
  for (const [key, allowed] of Object.entries(BLOCKING_ENUMS)) {
    if (!allowed.includes(String(camera[key]))) {
      throw new Error(`${label} blocking.camera.${key} 必须是枚举值之一：${allowed.join(' / ')}。`);
    }
  }
}


/**
 * 校验一个镜头内部的逐拍动作。
 * 旧数据没有 action_beats，缺失一律放行；一旦存在就必须可信：拍点落在本镜区间内、按时间递增、动作非空。
 * 角色 ID 能不能解析交给 validateSourceReferences / validateCreativeReferences，那里才拿得到角色表。
 */
function assertActionBeats(value: unknown, label: string, startSeconds: number, endSeconds: number) {
  if (value === undefined) return;
  const items = requireArray(value, `${label} action_beats`);
  let previous = -Infinity;
  items.forEach((item, index) => {
    const scope = `${label} action_beats 第 ${index + 1} 拍`;
    const step = requireRecord(item, scope);
    const at = requireFiniteNumber(step.at_seconds, `${scope} at_seconds`);
    if (at < startSeconds - TIMELINE_EPSILON_SECONDS || at > endSeconds + TIMELINE_EPSILON_SECONDS) {
      throw new Error(`${scope} at_seconds ${at} 秒不在本镜 ${startSeconds}–${endSeconds} 秒区间内。`);
    }
    if (at < previous - TIMELINE_EPSILON_SECONDS) throw new Error(`${scope} at_seconds ${at} 秒早于上一拍，必须按时间递增。`);
    previous = at;
    requireStringArray(step.actor_ids, `${scope} actor_ids`, 1);
    requireString(step.action, `${scope} action`);
    if (step.toward_ids !== undefined) requireStringArray(step.toward_ids, `${scope} toward_ids`);
    if (step.reaction !== undefined) requireString(step.reaction, `${scope} reaction`, true);
    if (step.consequence !== undefined) requireString(step.consequence, `${scope} consequence`, true);
  });
}

/** 逐拍动作引用的角色必须在角色表里；没有 action_beats 就什么都不查。 */
function assertActionBeatReferences(beats: { beat_id: string; action_beats?: ActionBeat[] }[], known: Set<string>, subject: string) {
  for (const beat of beats) {
    (beat.action_beats ?? []).forEach((step, index) => {
      for (const id of [...step.actor_ids, ...(step.toward_ids ?? [])]) {
        if (!known.has(id)) throw new Error(`${subject} ${beat.beat_id} 第 ${index + 1} 拍引用了不存在的角色：${id}`);
      }
    });
  }
}

function assertCreativePackShape(value: unknown): asserts value is CreativePack {
  const root = requireRecord(value, '创作包');
  if (root.schema_version !== 'creative-pack.v1') throw new Error('Gemini 返回的不是 creative-pack.v1 数据。');
  requireString(root.title, 'title');
  requireString(root.concept_summary, 'concept_summary');
  requireStringArray(root.differentiation_log, 'differentiation_log', 1);
  requireArray(root.character_bible, 'character_bible', 1).forEach((item, index) => {
    const character = requireRecord(item, `character_bible 第 ${index + 1} 项`);
    assertEntityProfile(character, `character_bible 第 ${index + 1} 项`);
    assertCastingEnvelope(character.casting_envelope, `character_bible 第 ${index + 1} 项 casting_envelope`);
    for (const field of ['character_id', 'role_function', 'appearance', 'wardrobe', 'performance']) requireString(character[field], `character_bible 第 ${index + 1} 项 ${field}`);
    requireStringArray(character.identity_anchors, `character_bible 第 ${index + 1} 项 identity_anchors`, 3);
    requireStringArray(character.palette, `character_bible 第 ${index + 1} 项 palette`);
    requireStringArray(character.continuity_lock, `character_bible 第 ${index + 1} 项 continuity_lock`);
    const prompts = requireRecord(character.reference_prompts, `character_bible 第 ${index + 1} 项 reference_prompts`);
    for (const field of ['turnaround_sheet', 'expression_sheet', 'hero_portrait', 'negative_prompt']) requireString(prompts[field], `character_bible 第 ${index + 1} 项 reference_prompts.${field}`);
  });
  const style = requireRecord(root.style_lock, 'style_lock');
  for (const field of ['pacing', 'camera', 'visual', 'performance', 'sound']) requireString(style[field], `style_lock.${field}`);
  requireStringArray(style.negative_constraints, 'style_lock.negative_constraints');
  requireArray(root.beats, 'beats', 1).forEach((item, index) => {
    const beat = requireRecord(item, `beats 第 ${index + 1} 项`);
    requireString(beat.beat_id, `beats 第 ${index + 1} 项 beat_id`);
    requireFiniteNumber(beat.start_seconds, `beats 第 ${index + 1} 项 start_seconds`);
    requireFiniteNumber(beat.end_seconds, `beats 第 ${index + 1} 项 end_seconds`);
    requireStringArray(beat.character_ids, `beats 第 ${index + 1} 项 character_ids`);
    requireStringArray(beat.props, `beats 第 ${index + 1} 项 props`);
    for (const field of ['story_function', 'action', 'performance', 'environment', 'framing', 'camera_motion', 'lighting', 'continuity', 'dialogue', 'sound', 'video_prompt']) requireString(beat[field], `beats 第 ${index + 1} 项 ${field}`, field === 'dialogue');
    assertActionBeats(beat.action_beats, `beats 第 ${index + 1} 项`, Number(beat.start_seconds), Number(beat.end_seconds));
    assertBlocking(beat.blocking, `beats 第 ${index + 1} 项`, Number(beat.start_seconds), Number(beat.end_seconds),
      Array.isArray(beat.role_ids) ? beat.role_ids.map(String) : []);
    if (beat.dialogue_speaker_ids !== undefined) requireStringArray(beat.dialogue_speaker_ids, `beats 第 ${index + 1} 项 dialogue_speaker_ids`);
    if (beat.timeline_exception !== undefined) assertTimelineException(beat.timeline_exception, `beats 第 ${index + 1} 项 timeline_exception`);
  });
  const bundle = requireRecord(root.prompt_bundle, 'prompt_bundle');
  for (const field of ['generic_master', 'target_model', 'target_prompt', 'negative_prompt', 'first_frame_prompt', 'last_frame_prompt']) requireString(bundle[field], `prompt_bundle.${field}`);
  const qa = requireRecord(root.qa, 'qa');
  for (const field of ['timing_valid', 'variables_applied', 'originality_pass', 'source_identity_leakage', 'source_dialogue_leakage']) requireBoolean(qa[field], `qa.${field}`);
  requireStringArray(qa.notes, 'qa.notes');
  if (root.remix_policy !== undefined) {
    const policy = requireRecord(root.remix_policy, 'remix_policy');
    if (!['character_swap', 'light_remix', 'full_original'].includes(String(policy.requested_mode))) throw new Error('remix_policy.requested_mode 无效。');
    if (!['character_swap', 'light_remix', 'full_original'].includes(String(policy.effective_mode))) throw new Error('remix_policy.effective_mode 无效。');
    if (!['owned_or_authorized', 'third_party_reference'].includes(String(policy.source_rights_scope))) throw new Error('remix_policy.source_rights_scope 无效。');
  }
  if (root.seedance_asset_map !== undefined) {
    const assetMap = requireRecord(root.seedance_asset_map, 'seedance_asset_map');
    if (assetMap.schema_version !== 'seedance-assets.v1') throw new Error('seedance_asset_map.schema_version 无效。');
    requireString(assetMap.usage_note, 'seedance_asset_map.usage_note');
    requireArray(assetMap.bindings, 'seedance_asset_map.bindings', 1).forEach((item, index) => {
      const binding = requireRecord(item, `seedance_asset_map.bindings 第 ${index + 1} 项`);
      requireString(binding.slot, `seedance_asset_map.bindings 第 ${index + 1} 项 slot`);
      if (![
        'character_reference',
        'source_video_reference',
        'dialogue_audio_reference',
        'music_audio_reference',
        'ambience_audio_reference',
      ].includes(String(binding.kind))) throw new Error(`seedance_asset_map.bindings 第 ${index + 1} 项 kind 无效。`);
      requireString(binding.instruction, `seedance_asset_map.bindings 第 ${index + 1} 项 instruction`);
      if (binding.kind === 'character_reference') {
        for (const field of ['source_role_id', 'character_id', 'candidate_id', 'asset_id', 'reference_prompt']) {
          requireString(binding[field], `seedance_asset_map.bindings 第 ${index + 1} 项 ${field}`);
        }
        if (binding.approved !== true) throw new Error(`seedance_asset_map.bindings 第 ${index + 1} 项未确认。`);
      }
    });
    requireArray(assetMap.runs, 'seedance_asset_map.runs', 1).forEach((item, index) => {
      const run = requireRecord(item, `seedance_asset_map.runs 第 ${index + 1} 项`);
      requireString(run.run_id, `seedance_asset_map.runs 第 ${index + 1} 项 run_id`);
      requireFiniteNumber(run.source_start_seconds, `seedance_asset_map.runs 第 ${index + 1} 项 source_start_seconds`);
      requireFiniteNumber(run.source_end_seconds, `seedance_asset_map.runs 第 ${index + 1} 项 source_end_seconds`);
      requireFiniteNumber(run.duration_seconds, `seedance_asset_map.runs 第 ${index + 1} 项 duration_seconds`);
      requireStringArray(run.beat_ids, `seedance_asset_map.runs 第 ${index + 1} 项 beat_ids`, 1);
      requireString(run.target_prompt, `seedance_asset_map.runs 第 ${index + 1} 项 target_prompt`);
      requireString(run.assembly_instruction, `seedance_asset_map.runs 第 ${index + 1} 项 assembly_instruction`);
    });
    if (assetMap.full_run !== undefined) {
      const fullRun = requireRecord(assetMap.full_run, 'seedance_asset_map.full_run');
      requireString(fullRun.run_id, 'seedance_asset_map.full_run.run_id');
      requireFiniteNumber(fullRun.source_start_seconds, 'seedance_asset_map.full_run.source_start_seconds');
      requireFiniteNumber(fullRun.source_end_seconds, 'seedance_asset_map.full_run.source_end_seconds');
      requireFiniteNumber(fullRun.duration_seconds, 'seedance_asset_map.full_run.duration_seconds');
      requireFiniteNumber(fullRun.character_limit, 'seedance_asset_map.full_run.character_limit');
      requireBoolean(fullRun.within_character_limit, 'seedance_asset_map.full_run.within_character_limit');
      requireStringArray(fullRun.beat_ids, 'seedance_asset_map.full_run.beat_ids', 1);
      requireString(fullRun.target_prompt, 'seedance_asset_map.full_run.target_prompt');
      requireString(fullRun.assembly_instruction, 'seedance_asset_map.full_run.assembly_instruction');
    }
  }
}

function assertCreativeDraftShape(value: unknown): asserts value is CreativeDraft {
  const root = requireRecord(value, '创作草稿');
  if (root.schema_version !== 'creative-draft.v1') throw new Error('Gemini 返回的不是 creative-draft.v1 数据。');
  requireString(root.title, 'title');
  requireString(root.concept_summary, 'concept_summary');
  requireStringArray(root.differentiation_log, 'differentiation_log', 1);
  const style = requireRecord(root.style_lock, 'style_lock');
  for (const field of ['pacing', 'camera', 'visual', 'performance', 'sound']) requireString(style[field], `style_lock.${field}`);
  requireStringArray(style.negative_constraints, 'style_lock.negative_constraints');
  requireArray(root.beats, 'beats', 1).forEach((item, index) => {
    const beat = requireRecord(item, `beats 第 ${index + 1} 项`);
    requireString(beat.beat_id, `beats 第 ${index + 1} 项 beat_id`);
    requireFiniteNumber(beat.start_seconds, `beats 第 ${index + 1} 项 start_seconds`);
    requireFiniteNumber(beat.end_seconds, `beats 第 ${index + 1} 项 end_seconds`);
    requireStringArray(beat.character_ids, `beats 第 ${index + 1} 项 character_ids`);
    requireStringArray(beat.props, `beats 第 ${index + 1} 项 props`);
    for (const field of ['story_function', 'action', 'performance', 'environment', 'framing', 'camera_motion', 'lighting', 'continuity', 'dialogue', 'sound']) requireString(beat[field], `beats 第 ${index + 1} 项 ${field}`, field === 'dialogue');
    assertActionBeats(beat.action_beats, `beats 第 ${index + 1} 项`, Number(beat.start_seconds), Number(beat.end_seconds));
    assertBlocking(beat.blocking, `beats 第 ${index + 1} 项`, Number(beat.start_seconds), Number(beat.end_seconds),
      Array.isArray(beat.role_ids) ? beat.role_ids.map(String) : []);
    if (beat.dialogue_speaker_ids !== undefined) requireStringArray(beat.dialogue_speaker_ids, `beats 第 ${index + 1} 项 dialogue_speaker_ids`);
    if (beat.timeline_exception !== undefined) assertTimelineException(beat.timeline_exception, `beats 第 ${index + 1} 项 timeline_exception`);
  });
  const qa = requireRecord(root.qa, 'qa');
  for (const field of ['timing_valid', 'variables_applied', 'originality_pass', 'source_identity_leakage', 'source_dialogue_leakage']) requireBoolean(qa[field], `qa.${field}`);
  requireStringArray(qa.notes, 'qa.notes');
}

function readJson(text: string, source = '模型', combine?: (parts: unknown[]) => unknown): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // Only unwrap complete JSON. Never invent fields or close truncated output.
    const candidates: unknown[] = [];
    let start = -1, quoted = false, escaped = false;
    const stack: string[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (start < 0) {
        if (char === '{' || char === '[') { start = i; stack.push(char); }
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) throw new Error(`${source}返回的 JSON 括号不匹配，尚未采用此结果。请下载返回诊断，不要连续重新生成。`);
        if (!stack.length) {
          try { candidates.push(JSON.parse(cleaned.slice(start, i + 1))); } catch { /* Not valid JSON; do not repair its contents. */ }
          start = -1;
        }
      }
    }
    if (start < 0 && candidates.length === 1) return candidates[0];
    if (start < 0 && candidates.length > 1 && combine) {
      const combined = combine(candidates);
      if (combined !== undefined) return combined;
    }
    const reason = start >= 0 ? 'JSON 不完整或已被截断' : candidates.length > 1 ? '包含多份 JSON，无法确定应采用哪一份' : '没有可解析的完整 JSON';
    throw new Error(`${source}返回的内容${reason}，尚未采用此结果。请下载返回诊断，不要连续重新生成。`);
  }
}

function normalizeEmptyDialogueIntents(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.beats)) return;
  for (const item of value.beats) {
    if (!isRecord(item) || !isRecord(item.dialogue)) continue;
    const dialogue = item.dialogue;
    const missingIntent = dialogue.semantic_intent == null;
    const blankIntent = typeof dialogue.semantic_intent === 'string' && !dialogue.semantic_intent.trim();
    if (missingIntent || blankIntent) {
      const isSilent =
        typeof dialogue.speaker_role === 'string' &&
        !dialogue.speaker_role.trim() &&
        typeof dialogue.source_text === 'string' &&
        !dialogue.source_text.trim() &&
        dialogue.approx_characters === 0;
      if (isSilent) {
        dialogue.semantic_intent = '无对白';
      } else if (blankIntent) {
        dialogue.semantic_intent = '意图未识别';
      }
      if (!isSilent && blankIntent && Array.isArray(value.uncertainties)) {
        const beatId = typeof item.beat_id === 'string' && item.beat_id.trim() ? item.beat_id : '未知镜头';
        value.uncertainties.push(`${beatId} 的对白语义意图未能可靠识别。`);
      }
    }
  }
}

function normalizeLegacySpeakerVisibility(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.beats)) return;
  for (const item of value.beats) {
    if (!isRecord(item) || !isRecord(item.dialogue) || Object.hasOwn(item.dialogue, 'speaker_on_screen')) continue;
    const speaker = typeof item.dialogue.speaker_role === 'string' ? item.dialogue.speaker_role : '';
    const visibleRoleIds = Array.isArray(item.role_ids) ? item.role_ids : [];
    item.dialogue.speaker_on_screen = Boolean(speaker && visibleRoleIds.includes(speaker));
  }
}

function normalizeLegacySourceRoleEntities(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.source_roles)) return;
  const visualMedium = isRecord(value.style_dna) && isRecord(value.style_dna.visual) && typeof value.style_dna.visual.medium === 'string'
    ? value.style_dna.visual.medium
    : '';
  for (const item of value.source_roles) {
    if (!isRecord(item)) continue;
    const role = {
      role_id: typeof item.role_id === 'string' ? item.role_id : '',
      narrative_function: typeof item.narrative_function === 'string' ? item.narrative_function : '',
      generalized_appearance: typeof item.generalized_appearance === 'string' ? item.generalized_appearance : '',
      silhouette: typeof item.silhouette === 'string' ? item.silhouette : '',
      wardrobe_logic: typeof item.wardrobe_logic === 'string' ? item.wardrobe_logic : '',
      performance_traits: Array.isArray(item.performance_traits) ? item.performance_traits.filter((entry): entry is string => typeof entry === 'string') : [],
      continuity_anchors: Array.isArray(item.continuity_anchors) ? item.continuity_anchors.filter((entry): entry is string => typeof entry === 'string') : [],
      identity_risk: typeof item.identity_risk === 'string' ? item.identity_risk : 'uncertain',
      entity_type: typeof item.entity_type === 'string' ? item.entity_type : undefined,
      species: typeof item.species === 'string' ? item.species : undefined,
      body_plan: typeof item.body_plan === 'string' ? item.body_plan : undefined,
      anthropomorphism_level: typeof item.anthropomorphism_level === 'string' ? item.anthropomorphism_level : undefined,
      casting_envelope: isRecord(item.casting_envelope) ? item.casting_envelope as unknown as CastingEnvelope : undefined,
    } as SourceRole;
    const profile = resolveSourceRoleEntity(role);
    item.entity_type ??= profile.entity_type;
    item.species ??= profile.species;
    item.body_plan ??= profile.body_plan;
    item.anthropomorphism_level ??= profile.anthropomorphism_level;
    item.casting_envelope ??= resolveSourceRoleCastingEnvelope(role, visualMedium);
  }
}

function normalizeLegacyCharacterEntities(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.character_bible)) return;
  for (const item of value.character_bible) {
    if (!isRecord(item)) continue;
    const profile = resolveCharacterEntity(item as unknown as CharacterBible);
    item.entity_type ??= profile.entity_type;
    item.species ??= profile.species;
    item.body_plan ??= profile.body_plan;
    item.anthropomorphism_level ??= profile.anthropomorphism_level;
    item.casting_envelope ??= resolveCharacterCastingEnvelope(item as unknown as CharacterBible);
  }
}

function validateTimeline(beats: TimelineItem[], label: string, expectedDuration: number) {
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) throw new Error(`${label}总时长无效。`);
  assertUniqueStrings(beats.map((beat) => beat.beat_id), `${label}镜头`);
  let previousStart = 0;
  let previousEnd = 0;
  beats.forEach((beat, index) => {
    if (!Number.isFinite(beat.start_seconds) || !Number.isFinite(beat.end_seconds)) throw new Error(`${label}第 ${index + 1} 镜头时间码无效。`);
    if (beat.start_seconds < 0 || beat.end_seconds <= beat.start_seconds) throw new Error(`${label}第 ${index + 1} 镜头起止时间不成立。`);
    if (index === 0) {
      if (Math.abs(beat.start_seconds) > TIMELINE_EPSILON_SECONDS) throw new Error(`${label}第 1 镜头必须从 0 秒开始。`);
      if (beat.timeline_exception !== undefined) throw new Error(`${label}第 1 镜头不能声明 timeline_exception。`);
    } else {
      if (beat.start_seconds < previousStart - TIMELINE_EPSILON_SECONDS) throw new Error(`${label}第 ${index + 1} 镜头没有按时间顺序排列。`);
      const delta = beat.start_seconds - previousEnd;
      if (Math.abs(delta) <= TIMELINE_EPSILON_SECONDS) {
        if (beat.timeline_exception !== undefined) throw new Error(`${label}第 ${index + 1} 镜头时间连续，不应声明 timeline_exception。`);
      } else {
        const expectedKind: TimelineException['kind'] = delta > 0 ? 'gap' : 'overlap';
        if (!beat.timeline_exception) throw new Error(`${label}第 ${index + 1} 镜头存在未显式声明的 ${expectedKind}。`);
        if (beat.timeline_exception.kind !== expectedKind) throw new Error(`${label}第 ${index + 1} 镜头 timeline_exception.kind 与时间码不一致。`);
        if (Math.abs(beat.timeline_exception.duration_seconds - Math.abs(delta)) > TIMELINE_EPSILON_SECONDS) throw new Error(`${label}第 ${index + 1} 镜头 timeline_exception.duration_seconds 与时间码不一致。`);
      }
      if (beat.end_seconds <= previousEnd + TIMELINE_EPSILON_SECONDS) throw new Error(`${label}第 ${index + 1} 镜头终点没有向前推进。`);
    }
    previousStart = beat.start_seconds;
    previousEnd = beat.end_seconds;
  });
  if (Math.abs(previousEnd - expectedDuration) > TIMELINE_EPSILON_SECONDS) throw new Error(`${label}时间轴终点 ${previousEnd} 秒与总时长 ${expectedDuration} 秒不一致。`);
}

function validateAtomicShots(beats: Array<Pick<VideoBeat | CreativeBeat, 'beat_id' | 'framing' | 'camera_motion'>>, label: string) {
  for (const beat of beats) {
    if (INTERNAL_CUT_PATTERN.test(beat.framing) || INTERNAL_CUT_PATTERN.test(beat.camera_motion)) throw new Error(`${label}${beat.beat_id} 包含内部切镜或反打，请拆成多个原子镜头。`);
  }
}

function extractIds(text: string, prefix: 'ROLE' | 'CHAR'): string[] {
  return [...text.matchAll(new RegExp(`\\b${prefix}_[A-Z0-9_]+\\b`, 'gi'))].map((match) => match[0].toUpperCase());
}

function validateSourceReferences(analysis: VideoDnaAnalysis) {
  const roleIds = analysis.source_roles.map((role) => role.role_id);
  assertUniqueStrings(roleIds, 'source_roles');
  for (const roleId of roleIds) if (!/^ROLE_[A-Z0-9_]+$/.test(roleId)) throw new Error(`源角色 ID 格式无效：${roleId}`);
  const known = new Set(roleIds);
  for (const beat of analysis.beats) {
    const visible = beat.role_ids;
    if (visible) {
      assertUniqueStrings(visible, `源镜头 ${beat.beat_id} role_ids`);
      for (const roleId of visible) if (!known.has(roleId)) throw new Error(`源镜头 ${beat.beat_id} 引用了不存在的角色：${roleId}`);
    }
    const speaker = beat.dialogue.speaker_role;
    if (speaker && !known.has(speaker)) throw new Error(`源镜头 ${beat.beat_id} 对白引用了不存在的角色：${speaker}`);
    if (beat.dialogue.speaker_on_screen && !speaker) throw new Error(`源镜头 ${beat.beat_id} 标记为画面内说话，但没有 speaker_role。`);
    if (speaker && beat.dialogue.speaker_on_screen && visible && !visible.includes(speaker)) throw new Error(`源镜头 ${beat.beat_id} 标记 ${speaker} 为画面内说话，但 role_ids 漏标。`);
    if (beat.dialogue.source_text.trim() && !speaker) throw new Error(`源镜头 ${beat.beat_id} 有对白文本但没有 speaker_role。`);
  }
  assertActionBeatReferences(analysis.beats, known, '源镜头');
}

function isSilentDialogue(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\s./_-]/g, '');
  return !normalized || ['无对白', '无台词', 'none', 'silent', 'silence', 'na'].includes(normalized);
}

function validateCreativeReferences(pack: CreativePack) {
  const characterIds = pack.character_bible.map((character) => character.character_id);
  assertUniqueStrings(characterIds, 'character_bible');
  for (const characterId of characterIds) if (!/^CHAR_[A-Z0-9_]+$/.test(characterId)) throw new Error(`新角色 ID 格式无效：${characterId}`);
  const known = new Set(characterIds);
  for (const beat of pack.beats) {
    assertUniqueStrings(beat.character_ids, `新镜头 ${beat.beat_id} character_ids`);
    for (const characterId of beat.character_ids) if (!known.has(characterId)) throw new Error(`新镜头 ${beat.beat_id} 引用了不存在的角色：${characterId}`);
    const labelledSpeakers = extractIds(beat.dialogue, 'CHAR');
    const promptReferences = extractIds(beat.video_prompt, 'CHAR');
    const declaredSpeakers = beat.dialogue_speaker_ids;
    const allowedTextReferences = new Set([...beat.character_ids, ...(declaredSpeakers ?? [])]);
    for (const characterId of promptReferences) {
      if (!known.has(characterId)) throw new Error(`新镜头 ${beat.beat_id} 文本引用了不存在的角色：${characterId}`);
    }
    for (const characterId of labelledSpeakers) {
      if (!known.has(characterId)) throw new Error(`新镜头 ${beat.beat_id} 文本引用了不存在的角色：${characterId}`);
      if (!allowedTextReferences.has(characterId)) throw new Error(`新镜头 ${beat.beat_id} 文本引用了未列入 character_ids 或 dialogue_speaker_ids 的角色：${characterId}`);
    }
    if (declaredSpeakers) {
      assertUniqueStrings(declaredSpeakers, `新镜头 ${beat.beat_id} dialogue_speaker_ids`);
      for (const characterId of declaredSpeakers) {
        if (!known.has(characterId)) throw new Error(`新镜头 ${beat.beat_id} 对白引用了不存在的角色：${characterId}`);
      }
      for (const characterId of labelledSpeakers) if (!declaredSpeakers.includes(characterId)) throw new Error(`新镜头 ${beat.beat_id} 的对白标签 ${characterId} 未列入 dialogue_speaker_ids。`);
    }
    if (!isSilentDialogue(beat.dialogue)) {
      if (declaredSpeakers && declaredSpeakers.length === 0) throw new Error(`新镜头 ${beat.beat_id} 有对白但 dialogue_speaker_ids 为空。`);
      if (!declaredSpeakers && labelledSpeakers.length === 0 && beat.character_ids.length !== 1) throw new Error(`新镜头 ${beat.beat_id} 的对白说话人不明确。`);
    } else if (declaredSpeakers && declaredSpeakers.length > 0) throw new Error(`新镜头 ${beat.beat_id} 没有对白，却声明了 dialogue_speaker_ids。`);
  }
  assertActionBeatReferences(pack.beats, known, '新镜头');
  const bundleText = Object.values(pack.prompt_bundle).join('\n');
  for (const characterId of extractIds(bundleText, 'CHAR')) if (!known.has(characterId)) throw new Error(`最终提示词引用了不存在的角色：${characterId}`);
  const leakScanTarget = {
    ...pack,
    // source_role_id / candidate_id 是“这个新角色替换哪个源角色槽位”的结构性映射，不是提示词里的源角色引用。
    // bindings 早就因此被裁剪；原创线把整个候选对象直接当 character_bible 存，同样带这两个字段，一并裁掉。
    character_bible: pack.character_bible.map((character) => {
      const scanned: Record<string, unknown> = { ...character };
      delete scanned.source_role_id;
      delete scanned.candidate_id;
      return scanned;
    }),
    seedance_asset_map: pack.seedance_asset_map
      ? {
          ...pack.seedance_asset_map,
          bindings: pack.seedance_asset_map.bindings.map(({ slot, kind, instruction }) => ({ slot, kind, instruction })),
        }
      : undefined,
  };
  const leakedSourceRole = extractIds(collectStrings(leakScanTarget).join('\n'), 'ROLE')[0];
  if (leakedSourceRole) throw new Error(`创作包泄漏了源角色引用：${leakedSourceRole}`);
}

function validateQa(pack: CreativePack, mode?: RemixMode) {
  if (!pack.qa.timing_valid) throw new Error('创作包 QA 报告时间轴未通过。');
  if (!pack.qa.variables_applied) throw new Error('创作包 QA 报告用户变量未完整应用。');
  // full_original 按单一真相故意把 originality_pass 标成 false（原创性与平台判重不能由程序保证，不伪装为已通过）；
  // character_swap 是角色替换复刻/保留原剧情，本来就不主张原创。这两种模式都不能反过来要求它必须为 true。
  if (mode !== 'full_original' && mode !== 'character_swap' && !pack.qa.originality_pass) throw new Error('创作包 QA 报告原创性未通过。');
  if (pack.qa.source_identity_leakage) throw new Error('创作包 QA 报告存在源人物身份泄漏。');
  if (pack.qa.source_dialogue_leakage) throw new Error('创作包 QA 报告存在源对白泄漏。');
}

type DifferentiationAxis = 'identity' | 'dialogue' | 'setting' | 'props' | 'plot' | 'action' | 'performance' | 'visual' | 'sound';

function differentiationAxis(entry: string): DifferentiationAxis {
  const prefix = entry.trim().split(/[:：\-—]/, 1)[0].replace(/\s+/g, '').toLowerCase();
  const aliases: Array<[DifferentiationAxis, RegExp]> = [
    ['identity', /^(身份|角色|人物|identity|character)(轴|axis)?$/i],
    ['dialogue', /^(对白|台词|dialogue)(轴|axis)?$/i],
    ['setting', /^(场景|环境|地点|时代|setting|environment)(轴|axis)?$/i],
    ['props', /^(道具|物件|props?)(轴|axis)?$/i],
    ['plot', /^(故事|剧情|事件|叙事内容|plot|story)(轴|axis)?$/i],
    ['action', /^(动作|行为|action)(轴|axis)?$/i],
    ['performance', /^(表演|情绪|performance)(轴|axis)?$/i],
    ['visual', /^(视觉|美术|色彩|材质|visual|look)(轴|axis)?$/i],
    ['sound', /^(声音|音效|音乐|sound|audio)(轴|axis)?$/i],
  ];
  const match = aliases.find(([, pattern]) => pattern.test(prefix));
  if (!match) throw new Error(`差异化记录必须以明确轴名开头：${entry}`);
  return match[0];
}

function validateDifferentiation(pack: CreativePack, mode: RemixMode) {
  const axes = pack.differentiation_log.map(differentiationAxis);
  const uniqueAxes = new Set(axes);
  if (uniqueAxes.size !== axes.length) throw new Error('差异化记录包含重复轴。');
  const minimum = minimumDifferentiationAxes(mode);
  if (uniqueAxes.size < minimum) throw new Error(`${mode} 至少需要 ${minimum} 个不同差异轴。`);
  if (mode === 'character_swap') {
    if (uniqueAxes.size !== 2 || !uniqueAxes.has('identity') || !uniqueAxes.has('dialogue')) {
      throw new Error('character_swap 必须且只能包含身份轴与对白保留轴。');
    }
  }
  if (mode === 'light_remix') {
    if (!uniqueAxes.has('identity') || !uniqueAxes.has('dialogue')) {
      throw new Error('light_remix 必须包含身份轴、对白轴和至少一个其他内容轴。');
    }
  }
}

function normalizeForComparison(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (isRecord(value)) Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function validateSourceDialogueLeakage(pack: CreativePack, analysis: VideoDnaAnalysis) {
  const sourceLines = analysis.beats.map((beat) => beat.dialogue.source_text.trim()).filter(Boolean).map((original) => ({ original, normalized: normalizeForComparison(original) })).filter((line) => line.normalized.length >= 2);
  if (sourceLines.length === 0) return;
  const dialogueCandidates = pack.beats.map((beat) => beat.dialogue.replace(/\bCHAR_[A-Z0-9_]+\b/gi, ''));
  const allCandidates = collectStrings(pack);
  for (const source of sourceLines) {
    const exactDialogueLeak = dialogueCandidates.some((candidate) => normalizeForComparison(candidate) === source.normalized);
    const embeddedLeak = source.normalized.length >= 4 && allCandidates.some((candidate) => normalizeForComparison(candidate).includes(source.normalized));
    if (exactDialogueLeak || embeddedLeak) throw new Error(`创作包复用了源对白：“${source.original.slice(0, 24)}”`);
  }
}

function assertPromptContainsCharacter(prompt: string, character: CharacterBible, label: string) {
  const normalizedPrompt = normalizeForComparison(prompt);
  const profile = resolveCharacterEntity(character);
  const casting = resolveCharacterCastingEnvelope(character);
  const requiredAnchors = [
    character.character_id,
    profile.entity_type,
    profile.species,
    profile.body_plan,
    profile.anthropomorphism_level,
    ...CASTING_ENVELOPE_FIELDS.map((field) => casting[field]),
    character.appearance,
    character.wardrobe,
    ...character.identity_anchors,
    ...character.continuity_lock,
  ];
  for (const anchor of requiredAnchors) if (!normalizedPrompt.includes(normalizeForComparison(anchor))) throw new Error(`${label}没有自包含角色 ${character.character_id} 的锚点：${anchor}`);
}

function assertPromptContainsDialogue(prompt: string, beat: CreativeBeat, label: string) {
  if (isSilentDialogue(beat.dialogue)) return;
  if (!normalizeForComparison(prompt).includes(normalizeForComparison(beat.dialogue))) throw new Error(`${label}没有包含镜头 ${beat.beat_id} 的完整新对白。`);
}

function assertPromptBlocks(prompt: string, beatId: string) {
  let previousIndex = -1;
  for (const block of REQUIRED_PROMPT_BLOCKS) {
    const index = prompt.indexOf(block);
    if (index < 0) throw new Error(`镜头 ${beatId} 的视频提示词缺少区块 ${block}。`);
    if (index <= previousIndex) throw new Error(`镜头 ${beatId} 的视频提示词区块顺序错误：${block}。`);
    if (prompt.indexOf(block, index + block.length) >= 0) throw new Error(`镜头 ${beatId} 的视频提示词重复区块 ${block}。`);
    previousIndex = index;
  }
}

function validateCompiledPrompts(pack: CreativePack) {
  const byId = new Map(pack.character_bible.map((character) => [character.character_id, character]));
  for (const beat of pack.beats) {
    assertPromptBlocks(beat.video_prompt, beat.beat_id);
    for (const characterId of beat.character_ids) {
      const character = byId.get(characterId);
      if (!character) throw new Error(`镜头 ${beat.beat_id} 缺少角色定义：${characterId}`);
      if (!beat.video_prompt.includes(character.character_id)) throw new Error(`镜头 ${beat.beat_id} 的视频提示词缺少角色 ${character.character_id}。`);
    }
    assertPromptContainsDialogue(beat.video_prompt, beat, `镜头 ${beat.beat_id} 的视频提示词`);
  }
  const usedCharacterIds = new Set(pack.beats.flatMap((beat) => [...beat.character_ids, ...(beat.dialogue_speaker_ids ?? [])]));
  for (const [field, prompt] of [['generic_master', pack.prompt_bundle.generic_master], ['target_prompt', pack.prompt_bundle.target_prompt]] as const) {
    for (const beat of pack.beats) {
      if (!prompt.includes(beat.beat_id)) throw new Error(`prompt_bundle.${field} 缺少镜头 ${beat.beat_id}。`);
      assertPromptContainsDialogue(prompt, beat, `prompt_bundle.${field}`);
    }
    for (const characterId of usedCharacterIds) {
      const character = byId.get(characterId);
      if (!character) throw new Error(`prompt_bundle.${field} 缺少角色定义：${characterId}`);
      assertPromptContainsCharacter(prompt, character, `prompt_bundle.${field}`);
    }
  }
  const firstBeat = pack.beats[0];
  const lastBeat = pack.beats[pack.beats.length - 1];
  for (const [field, beat] of [['first_frame_prompt', firstBeat], ['last_frame_prompt', lastBeat]] as const) {
    for (const characterId of beat.character_ids) {
      const character = byId.get(characterId);
      if (!character) throw new Error(`prompt_bundle.${field} 缺少角色定义：${characterId}`);
      assertPromptContainsCharacter(pack.prompt_bundle[field], character, `prompt_bundle.${field}`);
    }
  }
}

function validateCompiledMetadata(pack: CreativePack, selectedCharacters?: CharacterCandidate[]) {
  if (!pack.remix_policy) throw new Error('最终生成包缺少 remix_policy。');
  if (!pack.seedance_asset_map) throw new Error('最终生成包缺少 seedance_asset_map。');
  if (selectedCharacters && selectedCharacters.length !== pack.character_bible.length) throw new Error('最终生成包与已选角色数量不一致。');
  const bindings = pack.seedance_asset_map.bindings;
  const localizedCharacterSwap = pack.remix_policy.effective_mode === 'character_swap';
  const expectedBindingCount = pack.character_bible.length + 1;
  if (bindings.length !== expectedBindingCount) throw new Error('Seedance 参考素材必须包含每个角色的一张参考图和一份无声原视频。');
  const slots = bindings.map((binding) => binding.slot);
  assertUniqueStrings(slots, 'Seedance 素材槽位');
  const assetIds: string[] = [];
  const candidateIds: string[] = [];
  const sourceRoleIds: string[] = [];
  pack.character_bible.forEach((character, index) => {
    const binding = bindings[index];
    const expectedSlot = `@Image ${index + 1}`;
    if (binding?.slot !== expectedSlot || binding.kind !== 'character_reference') throw new Error(`Seedance 角色槽位 ${expectedSlot} 缺失或顺序错误。`);
    if (!binding.source_role_id?.trim()) throw new Error(`${expectedSlot} 缺少 source_role_id。`);
    if (binding.character_id !== character.character_id) throw new Error(`${expectedSlot} 没有绑定角色 ${character.character_id}。`);
    if (!binding.candidate_id?.trim()) throw new Error(`${expectedSlot} 缺少 candidate_id。`);
    if (!binding.asset_id?.trim()) throw new Error(`${expectedSlot} 缺少已确认参考图 asset_id。`);
    if (!binding.reference_prompt?.trim()) throw new Error(`${expectedSlot} 缺少参考图提示词。`);
    if (binding.approved !== true) throw new Error(`${expectedSlot} 的参考图未确认。`);
    sourceRoleIds.push(binding.source_role_id);
    candidateIds.push(binding.candidate_id);
    assetIds.push(binding.asset_id);
    if (selectedCharacters) {
      const selected = selectedCharacters.find((candidate) => candidate.source_role_id === binding.source_role_id);
      if (
        !selected ||
        selected.character_id !== binding.character_id ||
        selected.candidate_id !== binding.candidate_id ||
        selected.reference_image_prompt !== binding.reference_prompt ||
        !sameEntityProfile(resolveCharacterEntity(selected), resolveCharacterEntity(character)) ||
        !sameCastingEnvelope(resolveCharacterCastingEnvelope(selected), resolveCharacterCastingEnvelope(character))
      ) throw new Error(`${expectedSlot} 与已选角色方案不一致。`);
    }
    const referenceAlias = `${character.character_id}角色参考图`;
    const usedCharacterIds = new Set(pack.beats.flatMap((beat) => [...beat.character_ids, ...(beat.dialogue_speaker_ids ?? [])]));
    if (usedCharacterIds.has(character.character_id) && !pack.prompt_bundle.target_prompt.includes(referenceAlias)) throw new Error(`Seedance 提示词缺少素材名称 ${referenceAlias}。`);
  });
  assertUniqueStrings(sourceRoleIds, 'Seedance 源角色绑定');
  assertUniqueStrings(candidateIds, 'Seedance 角色候选绑定');
  assertUniqueStrings(assetIds, 'Seedance 角色参考图');
  const sourceBindings = bindings.filter((binding) => binding.kind === 'source_video_reference');
  if (sourceBindings.length !== 1 || sourceBindings[0].slot !== '@Video 1') throw new Error('Seedance 生成阶段必须且只能绑定一份无声原视频。');
  if (!pack.prompt_bundle.target_prompt.includes('无声参考视频')) throw new Error('Seedance 可复制提示词缺少无声参考视频别名。');
  if (/@(?:Image|Video)\b/i.test(pack.prompt_bundle.target_prompt) || /@[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(pack.prompt_bundle.target_prompt)) {
    throw new Error('Seedance 可复制提示词只能在开头手动绑定素材，正文不得残留 @Image、@Video 或 UUID。');
  }
  if (localizedCharacterSwap) {
    if (!pack.prompt_bundle.target_prompt.includes('Generate the final synchronized audio natively')) {
      throw new Error('Seedance 英文原对白复刻提示词必须要求模型原生生成最终英文人声、配乐与环境音效。');
    }
    const executableText = [
      ...bindings.flatMap((binding) => [binding.slot, binding.instruction]),
      pack.seedance_asset_map.usage_note,
      pack.prompt_bundle.generic_master,
      pack.prompt_bundle.target_prompt,
      ...pack.beats.map((beat) => beat.video_prompt),
      ...(pack.seedance_asset_map.runs ?? []).map((run) => run.target_prompt),
    ].join('\n');
    if (/@Audio\b/.test(executableText)) throw new Error('Seedance 原生出声包不应要求额外的 @Audio 文件。');
    if (/(?:use|copy|reuse|imitate|follow|match|reference|inherit|lip-sync to)\s+(?:the\s+)?(?:@Video\s*1|source video)(?:'s)?\s+(?:audio|sound|voice|dialogue|music|ambience|sfx)/i.test(executableText)) {
      throw new Error('Seedance 生成包不得把原视频音轨作为生成依赖。');
    }
  }
  const runs = pack.seedance_asset_map.runs;
  if (!runs?.length) throw new Error('Seedance 生成包缺少可执行 runs。');
  assertUniqueStrings(runs.map((run) => run.run_id), 'Seedance runs');
  const totalDuration = pack.beats.at(-1)?.end_seconds ?? 0;
  const knownBeatIds = new Set(pack.beats.map((beat) => beat.beat_id));
  const assignedBeatIds = new Set<string>();
  let previousEnd = 0;
  runs.forEach((run, index) => {
    if (Math.abs(run.source_start_seconds - previousEnd) > TIMELINE_EPSILON_SECONDS) throw new Error(`Seedance ${run.run_id} 与前一段不连续。`);
    if (run.source_end_seconds <= run.source_start_seconds) throw new Error(`Seedance ${run.run_id} 时长无效。`);
    const computedDuration = run.source_end_seconds - run.source_start_seconds;
    if (Math.abs(run.duration_seconds - computedDuration) > TIMELINE_EPSILON_SECONDS) throw new Error(`Seedance ${run.run_id} duration_seconds 与源区间不一致。`);
    if (run.duration_seconds > SEEDANCE_MAX_RUN_SECONDS + TIMELINE_EPSILON_SECONDS) throw new Error(`Seedance ${run.run_id} 超过 ${SEEDANCE_MAX_RUN_SECONDS} 秒单次上限。`);
    if (!run.target_prompt.includes('无声参考视频')) throw new Error(`Seedance ${run.run_id} 缺少无声参考视频。`);
    if (index < runs.length - 1) {
      const splitBeat = pack.beats.find((beat) =>
        beat.start_seconds < run.source_end_seconds - TIMELINE_EPSILON_SECONDS &&
        beat.end_seconds > run.source_end_seconds + TIMELINE_EPSILON_SECONDS,
      );
      if (splitBeat) throw new Error(`Seedance ${run.run_id} 在镜头 ${splitBeat.beat_id} 中途分段，可能重复动作或对白。`);
    }
    assertUniqueStrings(run.beat_ids, `Seedance ${run.run_id} beat_ids`);
    for (const beatId of run.beat_ids) {
      if (!knownBeatIds.has(beatId)) throw new Error(`Seedance ${run.run_id} 引用了不存在的镜头 ${beatId}。`);
      if (assignedBeatIds.has(beatId)) throw new Error(`Seedance 镜头 ${beatId} 被分配到多个 runs，可能重复动作或对白。`);
      assignedBeatIds.add(beatId);
    }
    const expectedBeats = pack.beats.filter((beat) =>
      beat.end_seconds > run.source_start_seconds && beat.start_seconds < run.source_end_seconds,
    );
    if (JSON.stringify(run.beat_ids) !== JSON.stringify(expectedBeats.map((beat) => beat.beat_id))) throw new Error(`Seedance ${run.run_id} 的镜头覆盖与源区间不一致。`);
    const expectedCharacterIds = new Set(expectedBeats.flatMap((beat) => [...beat.character_ids, ...(beat.dialogue_speaker_ids ?? [])]));
    for (const binding of bindings.filter((item) => item.kind === 'character_reference' && item.character_id && expectedCharacterIds.has(item.character_id))) {
      const alias = `${binding.character_id}角色参考图`;
      if (!run.target_prompt.includes(alias)) throw new Error(`Seedance ${run.run_id} 缺少素材名称 ${alias}。`);
    }
    for (const beat of expectedBeats) {
      if (!run.target_prompt.includes(beat.beat_id)) throw new Error(`Seedance ${run.run_id} 缺少镜头 ${beat.beat_id}。`);
      assertPromptContainsDialogue(run.target_prompt, beat, `Seedance ${run.run_id}`);
      for (const characterId of beat.character_ids) {
        const character = pack.character_bible.find((item) => item.character_id === characterId);
        if (!character) throw new Error(`Seedance ${run.run_id} 缺少角色定义 ${characterId}。`);
        assertPromptContainsCharacter(run.target_prompt, character, `Seedance ${run.run_id}`);
      }
    }
    const expectedRunId = `RUN_${String(index + 1).padStart(2, '0')}`;
    if (run.run_id !== expectedRunId) throw new Error(`Seedance run 顺序错误：应为 ${expectedRunId}。`);
    previousEnd = run.source_end_seconds;
  });
  if (Math.abs(previousEnd - totalDuration) > TIMELINE_EPSILON_SECONDS) throw new Error('Seedance runs 未覆盖完整视频时长。');
  if (assignedBeatIds.size !== knownBeatIds.size) throw new Error('Seedance runs 未覆盖全部镜头。');
}

function validateCharacterSwapPreservation(pack: CreativePack, analysis: VideoDnaAnalysis) {
  const roleBindings = pack.seedance_asset_map?.bindings
    .filter((binding) => binding.kind === 'character_reference')
    .map((binding) => ({ source_role_id: binding.source_role_id ?? '', character_id: binding.character_id ?? '' })) ?? [];
  const expectedBeats = normalizeKnownSourceRoleReferences(projectCharacterSwapBeats(analysis, roleBindings), roleBindings);
  const expectedStyle = normalizeKnownSourceRoleReferences(projectCharacterSwapStyle(analysis), roleBindings);
  if (JSON.stringify(pack.style_lock) !== JSON.stringify(expectedStyle)) throw new Error('character_swap style_lock 未保持源 analysis。');
  const axes = pack.differentiation_log.map(differentiationAxis);
  if (axes.length !== 2 || !axes.includes('identity') || !axes.includes('dialogue')) throw new Error('character_swap 差异记录必须是身份轴与对白本地化轴。');
  if (pack.beats.length !== expectedBeats.length) throw new Error('character_swap 镜头数量与源视频不一致。');
  const fields: Array<keyof Omit<CreativeBeat, 'video_prompt'>> = [
    'beat_id', 'start_seconds', 'end_seconds', 'story_function', 'character_ids', 'action', 'performance',
    'environment', 'props', 'framing', 'camera_motion', 'lighting', 'continuity',
    'dialogue_speaker_ids', 'sound', 'timeline_exception',
  ];
  pack.beats.forEach((beat, index) => {
    const expected = expectedBeats[index];
    for (const field of fields) {
      if (JSON.stringify(beat[field]) !== JSON.stringify(expected[field])) {
        throw new Error(`character_swap 镜头 ${expected.beat_id} 的 ${field} 未保持源 analysis。`);
      }
    }
  });
}

export function validateVideoDna(analysis: VideoDnaAnalysis, expectedDurationSeconds = analysis.source.duration_seconds) {
  assertVideoDnaShape(analysis);
  if (Math.abs(analysis.source.duration_seconds - expectedDurationSeconds) > TIMELINE_EPSILON_SECONDS) throw new Error(`源视频声明时长 ${analysis.source.duration_seconds} 秒与本地时长 ${expectedDurationSeconds} 秒不一致。`);
  validateTimeline(analysis.beats, '源视频', expectedDurationSeconds);
  validateSourceReferences(analysis);
}

function validateCreativePack(pack: CreativePack, context: CreativePackValidationContext) {
  assertCreativePackShape(pack);
  const remixMode = context.remixMode ?? pack.remix_policy?.effective_mode;
  if (remixMode) validateDifferentiation(pack, remixMode);
  const expectedDuration = context.analysis?.source.duration_seconds ?? pack.beats[pack.beats.length - 1].end_seconds;
  validateTimeline(pack.beats, '新视频', expectedDuration);
  if (remixMode !== 'character_swap') validateAtomicShots(pack.beats, '新镜头 ');
  validateCreativeReferences(pack);
  validateQa(pack, remixMode);
  if (context.analysis && !context.allowSourceDialogue) validateSourceDialogueLeakage(pack, context.analysis);
  if (context.validateCompiledPrompts) {
    validateCompiledMetadata(pack, context.selectedCharacters);
    if (remixMode === 'character_swap' && context.analysis) validateCharacterSwapPreservation(pack, context.analysis);
    validateCompiledPrompts(pack);
  }
}

function draftValidationPack(draft: CreativeDraft, selectedCharacters: CharacterCandidate[]): CreativePack {
  return {
    schema_version: 'creative-pack.v1',
    title: draft.title,
    concept_summary: draft.concept_summary,
    differentiation_log: draft.differentiation_log,
    character_bible: selectedCharacters.map((candidate) => ({
      ...resolveCharacterEntity(candidate),
      casting_envelope: resolveCharacterCastingEnvelope(candidate),
      character_id: candidate.character_id,
      role_function: candidate.role_function,
      identity_anchors: candidate.identity_anchors,
      appearance: candidate.appearance,
      wardrobe: candidate.wardrobe,
      palette: candidate.palette,
      performance: candidate.performance,
      continuity_lock: candidate.continuity_lock,
      reference_prompts: candidate.reference_prompts,
    })),
    style_lock: draft.style_lock,
    beats: draft.beats.map((beat) => ({ ...beat, video_prompt: 'compiler_pending' })),
    prompt_bundle: {
      generic_master: 'compiler_pending',
      target_model: 'compiler_pending',
      target_prompt: 'compiler_pending',
      negative_prompt: 'compiler_pending',
      first_frame_prompt: 'compiler_pending',
      last_frame_prompt: 'compiler_pending',
    },
    qa: draft.qa,
  };
}

export function parseVideoDna(text: string, expectedDurationSeconds?: number): VideoDnaAnalysis {
  const value = readJson(text);
  normalizeLegacySourceRoleEntities(value);
  normalizeLegacySpeakerVisibility(value);
  normalizeEmptyDialogueIntents(value);
  // 先把模型的形状偏差掰回来，再校验。改了什么一律写进 uncertainties，
  // 那是界面上已经在显示的"待核清单"——不能修完就当没发生过。
  const drift = normalizeModelDrift(value);
  assertVideoDnaShape(value);
  if (drift.length) value.uncertainties.push(describeDrift(drift));
  validateVideoDna(value, expectedDurationSeconds ?? value.source.duration_seconds);
  return value;
}

// Reference analysis is evidence, not the final shot timeline. Keep uncertainties visible
// without applying exact-reproduction constraints to an independently written new story.
export function parseReferenceDna(text: string): VideoDnaAnalysis {
  const value = readJson(text);
  normalizeLegacySourceRoleEntities(value);
  normalizeLegacySpeakerVisibility(value);
  normalizeEmptyDialogueIntents(value);
  // 先把模型的形状偏差掰回来，再校验。改了什么一律写进 uncertainties，
  // 那是界面上已经在显示的"待核清单"——不能修完就当没发生过。
  const drift = normalizeModelDrift(value);
  assertVideoDnaShape(value);
  if (drift.length) value.uncertainties.push(describeDrift(drift));
  if (!Number.isFinite(value.source.duration_seconds) || value.source.duration_seconds <= 0 || !value.source_roles.length) throw new Error('参考 DNA 需要有效时长和角色列表。');
  const ids = value.source_roles.map(role => role.role_id);
  assertUniqueStrings(ids, '源角色');
  const normalized = normalizeMinuteSecondTimeline(value);
  try { validateVideoDna(normalized, normalized.source.duration_seconds); }
  catch (error) {
    normalized.uncertainties.push(`参考层待核：${error instanceof Error ? error.message : String(error)}。仅供叙事和风格参考，不投影到新片时间轴。`);
  }
  return normalized;
}

export function parseCreativePack(text: string, context: CreativePackValidationContext = {}): CreativePack {
  const value = readJson(text);
  normalizeLegacyCharacterEntities(value);
  assertCreativePackShape(value);
  validateCreativePack(value, context);
  return value;
}

export function parseCreativeDraft(text: string, context: CreativePackValidationContext): CreativeDraft {
  const value = normalizeKnownSourceRoleReferences(readJson(text), context.selectedCharacters ?? []);
  assertCreativeDraftShape(value);
  if (!context.selectedCharacters?.length) throw new Error('创作草稿校验缺少已选角色。');
  const validationPack = normalizeKnownSourceRoleReferences(draftValidationPack(value, context.selectedCharacters), context.selectedCharacters);
  validateCreativePack(validationPack, context);
  return value;
}

export function parseCharacterProposals(text: string, sourceRoles: Array<string | SourceRole>, expectedCandidates = 4, requireDesignModes = false, designs?: Record<string, RoleDesignSettings>, roleOrder?: string[]): CharacterProposals {
  const value = readJson(text, '角色设计模型', parts => {
    const first = parts[0];
    if (!isRecord(first) || first.schema_version !== 'character-proposals.v1' || !Array.isArray(first.role_sets)) return undefined;
    const rest = parts.slice(1);
    if (rest.some(part => !isRecord(part) || part.schema_version !== undefined || typeof part.source_role_id !== 'string' || !Array.isArray(part.candidates))) return undefined;
    // A prematurely closed role_sets wrapper may leave complete role objects outside it.
    // Merge only these fragments; full competing proposals remain ambiguous.
    return { ...first, role_sets: [...first.role_sets, ...rest] };
  });
  const root = requireRecord(value, '角色候选');
  if (root.schema_version !== 'character-proposals.v1') throw new Error('角色设计模型返回的不是 character-proposals.v1 数据。');
  const roleSets = requireArray(root.role_sets, 'role_sets', 1);
  const sourceRoleIds = sourceRoles.map((role) => typeof role === 'string' ? role : role.role_id);
  const expected = new Set(sourceRoleIds);
  const sourceById = new Map(sourceRoles.filter((role): role is SourceRole => typeof role !== 'string').map((role) => [role.role_id, role]));
  const seenRoles = new Set<string>();
  const candidateIds: string[] = [];

  for (const [setIndex, setValue] of roleSets.entries()) {
    const set = requireRecord(setValue, `role_sets 第 ${setIndex + 1} 项`);
    const sourceRoleId = requireString(set.source_role_id, `role_sets 第 ${setIndex + 1} 项 source_role_id`);
    if (!expected.has(sourceRoleId)) throw new Error(`角色候选引用了不存在的源角色：${sourceRoleId}`);
    if (seenRoles.has(sourceRoleId)) throw new Error(`角色候选重复了源角色：${sourceRoleId}`);
    seenRoles.add(sourceRoleId);
    const roleFunction = requireString(set.role_function, `role_sets 第 ${setIndex + 1} 项 role_function`);
    const roleIndex = (roleOrder ?? sourceRoleIds).indexOf(sourceRoleId);
    const expectedCharacterId = `CHAR_${String.fromCharCode(65 + roleIndex)}`;
    const candidates = requireArray(set.candidates, `${sourceRoleId} candidates`);
    // 数量由用户选，但每个角色必须一样多：少一个角色只有两套可挑，界面就没法并排比较了。
    if (expectedCandidates > 0 && candidates.length !== expectedCandidates) throw new Error(`${sourceRoleId} 必须恰好生成 ${expectedCandidates} 个角色方案，实际 ${candidates.length} 个。`);
    if (expectedCandidates <= 0 && (candidates.length < 2 || candidates.length > 6)) throw new Error(`${sourceRoleId} 需要 2–6 个角色方案。`);
    const hasDesignModes = requireDesignModes || candidates.some(c => isRecord(c) && c.design_mode !== undefined);
    for (const [candidateIndex, candidateValue] of candidates.entries()) {
      const candidate = requireRecord(candidateValue, `${sourceRoleId} 第 ${candidateIndex + 1} 个方案`);
      if (hasDesignModes && candidate.design_mode !== (candidateIndex === 0 ? 'source_match' : 'style_variant')) {
        throw new Error(`${sourceRoleId} 必须第一套为原片相近设计（source_match），其余为同物种风格变体（style_variant）。`);
      }
      if (sourceById.size === 0) {
        const profile = resolveCharacterEntity(candidate as unknown as CharacterBible);
        candidate.entity_type ??= profile.entity_type;
        candidate.species ??= profile.species;
        candidate.body_plan ??= profile.body_plan;
        candidate.anthropomorphism_level ??= profile.anthropomorphism_level;
      }
      assertEntityProfile(candidate, `${sourceRoleId} 第 ${candidateIndex + 1} 个方案`);
      assertCastingEnvelope(candidate.casting_envelope, `${sourceRoleId} 第 ${candidateIndex + 1} 个方案 casting_envelope`);
      for (const field of [
        'candidate_id', 'source_role_id', 'character_id', 'design_name', 'design_rationale',
        'role_function', 'appearance', 'wardrobe', 'performance', 'reference_image_prompt',
      ]) requireString(candidate[field], `${sourceRoleId} 第 ${candidateIndex + 1} 个方案 ${field}`);
      if (candidate.source_role_id !== sourceRoleId) throw new Error(`${sourceRoleId} 的候选 source_role_id 不一致。`);
      if (!/^CHAR_[A-Z0-9_]+$/.test(String(candidate.character_id))) throw new Error(`${sourceRoleId} 的 character_id 格式无效。`);
      if (candidate.character_id !== expectedCharacterId) throw new Error(`${sourceRoleId} 的所有候选必须使用 ${expectedCharacterId}。`);
      if (candidate.role_function !== roleFunction) {
        candidate.original_role_function = candidate.role_function;
        candidate.role_function = roleFunction;
      }
      if (designs !== undefined) candidate.design_settings = designs[sourceRoleId] ?? undefined;
      const originalRole = sourceById.get(sourceRoleId);
      const sourceRole = originalRole ? applyRoleDesign(originalRole, candidate.design_settings as RoleDesignSettings | undefined) : undefined;
      if (sourceRole && !sameEntityProfile(resolveSourceRoleEntity(sourceRole), resolveCharacterEntity(candidate as unknown as CharacterBible))) {
        throw new Error(`${sourceRoleId} 的候选改变了源角色的物种、身体结构或拟人程度，请重新设计。`);
      }
      const candidateCasting = candidate.casting_envelope as unknown as CastingEnvelope;
      if (sourceRole) {
        const sourceCasting = resolveSourceRoleCastingEnvelope(sourceRole);
        const driftedField = castingDriftField(sourceCasting, candidateCasting, candidate.design_mode as CharacterCandidate['design_mode'], candidate.design_settings as RoleDesignSettings | undefined);
        if (driftedField) throw new Error(`${sourceRoleId} 的候选改变了源片选角范围：${driftedField}，请重新设计。`);
      }
      const identityText = [candidate.design_rationale, candidate.appearance, candidate.reference_image_prompt].join('\n');
      if (SOURCE_FACE_COPY_PATTERN.test(identityText)) throw new Error(`${sourceRoleId} 的候选不得复刻源人物的具体五官或身份。`);
      candidateIds.push(String(candidate.candidate_id));
      requireStringArray(candidate.identity_anchors, `${sourceRoleId} identity_anchors`, 3);
      requireStringArray(candidate.palette, `${sourceRoleId} palette`, 2);
      requireStringArray(candidate.continuity_lock, `${sourceRoleId} continuity_lock`, 3);
      assertAnimalAnatomyText(candidate as unknown as CharacterCandidate);
      const prompts = requireRecord(candidate.reference_prompts, `${sourceRoleId} reference_prompts`);
      for (const field of ['turnaround_sheet', 'expression_sheet', 'hero_portrait', 'negative_prompt']) {
        requireString(prompts[field], `${sourceRoleId} reference_prompts.${field}`);
      }
    }
  }
  if (seenRoles.size !== expected.size) throw new Error('角色候选没有覆盖全部源角色。');
  assertUniqueStrings(candidateIds, '角色候选');
  return value as CharacterProposals;
}

export function validateCompiledCreativePack(
  pack: CreativePack,
  analysis: VideoDnaAnalysis,
  allowSourceDialogue = false,
  selectedCharacters?: CharacterCandidate[],
) {
  validateCreativePack(pack, { analysis, validateCompiledPrompts: true, allowSourceDialogue: allowSourceDialogue || pack.remix_policy?.effective_mode === 'character_swap', selectedCharacters });
}

// ---- 同类型原创线（full_original）的编译后校验 ----
// character_swap 那套 validateCompiledMetadata 检查的是 @Image/@Video 槽位与无声原视频，
// 原创线根本不传视频，套不上，此前等于没有第二道闸。这里按原创线自己的契约补齐，纯本地不调模型。

const ORIGINAL_BINDING_MARK = '【在此绑定';
const SOURCE_VIDEO_LEAK_PATTERN = /@Image\b|@Video\b|SOURCE PREP|无声参考视频|无声原视频/i;
// 这条管线不给模型任何原片输入，提示词里就不该指代一个它看不见的"原片/参考片"——
// 既没有指代对象，又等于告诉生成模型这是复刻。硬编码文案和模型自己写的负面约束都要拦。
const PHANTOM_SOURCE_PATTERN = /(原片|参考片|源片|原视频|参考视频|参考录音)/;

function originalRunCast(pack: CreativePack, beatIds: string[]): string[] {
  const inRun = new Set(beatIds);
  const used = new Set(pack.beats
    .filter((beat) => inRun.has(beat.beat_id))
    .flatMap((beat) => [...beat.character_ids, ...(beat.dialogue_speaker_ids ?? [])]));
  return pack.character_bible.filter((character) => used.has(character.character_id)).map((character) => character.character_id);
}

function validateOriginalPrompt(pack: CreativePack, run: SeedanceRun, label: string) {
  if (SOURCE_VIDEO_LEAK_PATTERN.test(run.target_prompt)) {
    throw new Error(`${label} 引用了原视频或 @Image/@Video 槽位；同类型原创线只给角色图和文字，不上传参考视频。`);
  }
  const phantom = run.target_prompt.replace(/不需要参考视频/g, '').match(PHANTOM_SOURCE_PATTERN);
  if (phantom) {
    throw new Error(`${label} 提到了“${phantom[0]}”，但模型看不到任何原片；这种指代没有对象，还会暗示成片是复刻。请改成正面指令。`);
  }
  if (run.target_prompt.length > ORIGINAL_PROMPT_CHARACTER_LIMIT) {
    throw new Error(`${label} 提示词 ${run.target_prompt.length} 字符，超过 ${ORIGINAL_PROMPT_CHARACTER_LIMIT} 字符上限。`);
  }
  const cast = originalRunCast(pack, run.beat_ids);
  const marks = run.target_prompt.match(new RegExp(ORIGINAL_BINDING_MARK, 'g'))?.length ?? 0;
  if (marks !== cast.length) {
    throw new Error(`${label} 的角色图绑定占位有 ${marks} 处，本段出场角色 ${cast.length} 个；每个出场角色必须且只能在开头绑定一次。`);
  }
  for (const characterId of cast) {
    if (!run.target_prompt.includes(characterId)) throw new Error(`${label} 缺少出场角色 ${characterId}。`);
  }
  for (const beat of pack.beats.filter((item) => run.beat_ids.includes(item.beat_id))) {
    const dialogue = beat.dialogue.trim();
    // 台词逐字进提示词：分段时压缩描述可以，删台词不行。
    if (dialogue && !run.target_prompt.includes(dialogue)) {
      throw new Error(`${label} 的镜头 ${beat.beat_id} 台词没有完整出现，可能被截断。`);
    }
  }
}

function validateOriginalDialogueLanguage(pack: CreativePack, outputLanguage: string) {
  for (const beat of pack.beats) {
    const line = beat.dialogue.replace(/CHAR_[A-Z0-9_]+\s*[:：]/g, '').trim();
    if (!line) continue;
    if (!dialogueScriptMatches(line, outputLanguage)) throw new Error(`镜头 ${beat.beat_id} 的对白文字与 ${outputLanguage} 不符；请重新设计故事或手工改写这句台词。`);
  }
}

/** 原创线编译后校验：形状 / 时间轴 / 绑定 / 分段覆盖 / 整片一致 / 对白语言。纯本地，不请求任何模型。 */
export function validateCompiledOriginalPack(pack: CreativePack, outputLanguage?: string) {
  const mode = pack.remix_policy?.effective_mode;
  // 两种都走这条纯文字管线：full_original 重写新故事（四条差异轴）、character_swap 保留原剧情（身份+对白两条轴）。
  // 区别只在差异轴数量和原子镜头检查，由 validateCreativePack 按 mode 处理；素材与提示词规则完全一致。
  if (mode !== 'full_original' && mode !== 'character_swap') throw new Error('这不是本管线产出的生成包，请使用对应的校验。');
  // 时间轴以自己的最后一镜为准，不传 analysis：重写线时长独立于源片，保留线已在草稿层逐镜对齐过。
  validateCreativePack(pack, { remixMode: mode });
  const map = pack.seedance_asset_map;
  if (!map) throw new Error('原创生成包缺少 seedance_asset_map。');
  if (map.bindings.some((binding) => binding.kind !== 'character_reference')) {
    throw new Error('原创生成包只能绑定角色图，不得出现原视频或音频素材。');
  }
  if (map.bindings.length !== pack.character_bible.length) throw new Error('角色图绑定数量与角色圣经不一致。');
  assertUniqueStrings(map.bindings.map((binding) => binding.slot), '原创角色槽位');
  assertUniqueStrings(map.bindings.map((binding) => binding.asset_id ?? ''), '原创角色参考图');
  assertUniqueStrings(map.bindings.map((binding) => binding.candidate_id ?? ''), '原创角色候选');
  pack.character_bible.forEach((character, index) => {
    const binding = map.bindings[index];
    if (binding.character_id !== character.character_id) throw new Error(`第 ${index + 1} 个角色图绑定的不是 ${character.character_id}。`);
    if (binding.approved !== true) throw new Error(`${character.character_id} 的参考图未确认采用。`);
    for (const field of ['asset_id', 'candidate_id', 'reference_prompt', 'source_role_id'] as const) {
      if (!binding[field]?.trim()) throw new Error(`${character.character_id} 的绑定缺少 ${field}。`);
    }
  });

  const runs = map.runs;
  if (!runs?.length) throw new Error('原创生成包缺少可执行分段。');
  // 保留原剧情不能拆镜，分段上限跟着模式走，和编译器保持同一个来源。
  const runMax = runMaxSecondsFor(mode === 'character_swap');
  assertUniqueStrings(runs.map((run) => run.run_id), '原创分段');
  const totalDuration = pack.beats.at(-1)?.end_seconds ?? 0;
  const knownBeatIds = new Set(pack.beats.map((beat) => beat.beat_id));
  const assigned = new Set<string>();
  let previousEnd = 0;
  runs.forEach((run, index) => {
    const label = `原创分段 ${run.run_id}`;
    if (run.run_id !== `RUN_${String(index + 1).padStart(2, '0')}`) throw new Error(`${label} 顺序错误。`);
    if (Math.abs(run.source_start_seconds - previousEnd) > TIMELINE_EPSILON_SECONDS) throw new Error(`${label} 与前一段不连续。`);
    if (Math.abs(run.duration_seconds - (run.source_end_seconds - run.source_start_seconds)) > TIMELINE_EPSILON_SECONDS) throw new Error(`${label} 时长与区间不一致。`);
    if (run.duration_seconds > runMax + TIMELINE_EPSILON_SECONDS) throw new Error(`${label} 超过 ${runMax} 秒分段上限。`);
    const expected = pack.beats.filter((beat) => beat.end_seconds > run.source_start_seconds + TIMELINE_EPSILON_SECONDS && beat.start_seconds < run.source_end_seconds - TIMELINE_EPSILON_SECONDS);
    if (JSON.stringify(run.beat_ids) !== JSON.stringify(expected.map((beat) => beat.beat_id))) throw new Error(`${label} 的镜头覆盖与时间区间不一致。`);
    for (const beatId of run.beat_ids) {
      if (!knownBeatIds.has(beatId)) throw new Error(`${label} 引用了不存在的镜头 ${beatId}。`);
      if (assigned.has(beatId)) throw new Error(`镜头 ${beatId} 被分到多个分段，会重复动作或对白。`);
      assigned.add(beatId);
    }
    validateOriginalPrompt(pack, run, label);
    previousEnd = run.source_end_seconds;
  });
  if (Math.abs(previousEnd - totalDuration) > TIMELINE_EPSILON_SECONDS) throw new Error('原创分段未覆盖完整时长。');
  if (assigned.size !== knownBeatIds.size) throw new Error('原创分段未覆盖全部镜头。');

  const fullRun = map.full_run;
  if (fullRun) {
    if (JSON.stringify(fullRun.beat_ids) !== JSON.stringify(pack.beats.map((beat) => beat.beat_id))) throw new Error('整片提示词未覆盖全部镜头。');
    if (Math.abs(fullRun.duration_seconds - totalDuration) > TIMELINE_EPSILON_SECONDS) throw new Error('整片提示词时长与新故事总时长不一致。');
    // 超限标记必须说实话，否则界面会拿一条会被截断的提示词当能用的。
    if (fullRun.within_character_limit !== (fullRun.target_prompt.length <= ORIGINAL_PROMPT_SAFETY_LIMIT)) {
      throw new Error('整片提示词的超限标记与实际字符数不符。');
    }
    validateOriginalPrompt(pack, fullRun, '整片提示词');
  }

  if (outputLanguage) validateOriginalDialogueLanguage(pack, outputLanguage);
}

/**
 * 人工修正过的分析能不能存。
 *
 * 分析层是证据层。允许人改，是因为模型看不清的地方（瞬时手势、后景角色）必须让看过片的人纠正，
 * 否则一份读错的 DNA 会往下污染故事、角色和成片。但「可修正」不等于「可伪造」：
 * 时间轴、镜头数、镜头边界、置信度、源片时长一律不许动——那些是取证事实，改了就等于编造证据。
 * 能改的只有「这一镜里发生了什么」：概括、逐拍动作、在场角色。
 */
export const EDIT_REJECTED = 'edit_rejected: ';
const rejectEdit = (reason: string): never => { throw new Error(EDIT_REJECTED + reason); };

/** 形状与角色引用都合法才算一份能存的分析；不合法时把原因原样往上抛。 */
function parseEditedAnalysis(value: unknown): VideoDnaAnalysis {
  assertVideoDnaShape(value);
  validateSourceReferences(value);
  return value;
}

export function assertEditableAnalysisPatch(next: unknown, previous: VideoDnaAnalysis): VideoDnaAnalysis {
  let parsed: VideoDnaAnalysis;
  try {
    parsed = parseEditedAnalysis(next);
  } catch (cause) {
    return rejectEdit(cause instanceof Error ? cause.message : String(cause));
  }
  if (parsed.source.duration_seconds !== previous.source.duration_seconds) rejectEdit('源片时长属于取证事实，不能修改。');
  if (parsed.beats.length !== previous.beats.length) rejectEdit('镜头数量属于取证事实，不能增删镜头。');
  parsed.beats.forEach((beat, index) => {
    const before = previous.beats[index];
    const label = `第 ${index + 1} 镜`;
    if (beat.beat_id !== before.beat_id) rejectEdit(`${label} 的编号不能修改。`);
    if (beat.start_seconds !== before.start_seconds || beat.end_seconds !== before.end_seconds) rejectEdit(`${label} 的时间边界属于取证事实，不能修改。`);
    if (beat.confidence !== before.confidence) rejectEdit(`${label} 的置信度是模型给的，不能改写。`);
  });
  return parsed;
}
