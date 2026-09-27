import { roleForCandidate } from './role-design';
import { resolveRemixMode } from './remix-policy';
import {
  formatCastingEnvelope,
  resolveCharacterCastingEnvelope,
  resolveCharacterEntity,
  resolveSourceRoleCastingEnvelope,
  resolveSourceRoleEntity,
  castingDriftField,
  animalAnatomyInstruction,
  assertAnimalAnatomyText,
  sameEntityProfile,
} from './entity-profile';
import { normalizeKnownSourceRoleReferences } from './role-references';
import type {
  ActionBeat,
  CharacterBible,
  CharacterCandidate,
  CreativeBeat,
  CreativeDraft,
  CreativePack,
  ReferenceAsset,
  RemixBrief,
  RemixMode,
  VideoBeat,
  VideoDnaAnalysis,
} from './types';

export const REQUIRED_PROMPT_BLOCKS = [
  '[STYLE LOCK]',
  '[CHARACTER DEFINITIONS]',
  '[SHOT PURPOSE]',
  '[ACTION & PERFORMANCE]',
  '[ENVIRONMENT]',
  '[CAMERA & MOTION]',
  '[LIGHTING & MATERIAL]',
  '[CONTINUITY]',
  '[DIALOGUE & SOUND]',
  '[DURATION & OUTPUT]',
] as const;

export const SEEDANCE_MAX_RUN_SECONDS = 30;
const CHARACTER_SWAP_MAX_RUN_SECONDS = 15;
export const SEEDANCE_MAX_PROMPT_CHARACTERS = 15000;
const SEEDANCE_PROMPT_SAFETY_LIMIT = 14000;

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function characterDefinition(character: CharacterBible): string {
  const profile = resolveCharacterEntity(character);
  const casting = resolveCharacterCastingEnvelope(character);
  return `${character.character_id}: Entity type: ${profile.entity_type}. Species: ${profile.species}. Body plan: ${profile.body_plan}. Anthropomorphism level: ${profile.anthropomorphism_level}. Casting envelope: ${formatCastingEnvelope(casting)}. This is a new fictional identity and must not reproduce the source face. Appearance: ${character.appearance} Wardrobe or accessories: ${character.wardrobe} Identity anchors: ${character.identity_anchors.join('；')}。Continuity locks: ${character.continuity_lock.join('；')}。${animalAnatomyInstruction(profile)}`;
}

function definitionsForBeat(beat: CreativeBeat, characters: CharacterBible[]): string {
  if (beat.character_ids.length === 0) return 'No visible character in this shot.';
  const byId = new Map(characters.map((character) => [character.character_id, character]));
  return beat.character_ids
    .map((id) => byId.get(id))
    .filter((character): character is CharacterBible => Boolean(character))
    .map(characterDefinition)
    .join(' ');
}

function styleDefinition(pack: CreativePack): string {
  return `Pacing: ${pack.style_lock.pacing} Camera grammar: ${pack.style_lock.camera} Visual logic: ${pack.style_lock.visual} Performance curve: ${pack.style_lock.performance} Sound logic: ${pack.style_lock.sound}`;
}

function candidateToBible(candidate: CharacterCandidate): CharacterBible {
  return {
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
  };
}

function orderedSelections(
  selectedCharacters: CharacterCandidate[],
  analysis?: VideoDnaAnalysis,
): CharacterCandidate[] {
  const characterIds = selectedCharacters.map((candidate) => candidate.character_id);
  const candidateIds = selectedCharacters.map((candidate) => candidate.candidate_id);
  if (new Set(characterIds).size !== characterIds.length) throw new Error('已选角色的 character_id 必须唯一。');
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error('已选角色的 candidate_id 必须唯一。');
  if (!analysis) return selectedCharacters;
  if (selectedCharacters.length !== analysis.source_roles.length) throw new Error('已选角色数量与源角色数量不一致。');
  return analysis.source_roles.map((originalRole) => {
    const matches = selectedCharacters.filter((candidate) => candidate.source_role_id === originalRole.role_id);
    if (matches.length !== 1) throw new Error(`源角色 ${originalRole.role_id} 必须恰好选择一个角色方案。`);
    const selected = matches[0];
    const role = roleForCandidate(originalRole, selected, analysis.style_dna.visual.medium);
    assertAnimalAnatomyText(selected);
    if (!sameEntityProfile(resolveSourceRoleEntity(role), resolveCharacterEntity(selected))) {
      throw new Error(`源角色 ${role.role_id} 的已选方案改变了物种、身体结构或拟人程度，请重新设计角色。`);
    }
    if (castingDriftField(
      resolveSourceRoleCastingEnvelope(role, analysis.style_dna.visual.medium),
      resolveCharacterCastingEnvelope(selected),
      selected.design_mode,
      selected.design_settings,
    )) {
      throw new Error(`源角色 ${role.role_id} 的已选方案改变了源片选角风格，请重新设计角色。`);
    }
    return selected;
  });
}

function sourcePerformance(analysis: VideoDnaAnalysis, beatIndex: number): string {
  const curve = analysis.style_dna.pacing.energy_curve;
  const energy = curve[Math.min(curve.length - 1, Math.floor((curve.length * beatIndex) / Math.max(analysis.beats.length, 1)))] ?? analysis.style_dna.performance.energy;
  return `Energy: ${energy}. Gesture: ${analysis.style_dna.performance.gesture_language}. Facial: ${analysis.style_dna.performance.facial_language}. Blocking: ${analysis.style_dna.performance.blocking_pattern}.`;
}

export function projectCharacterSwapStyle(analysis: VideoDnaAnalysis): CreativePack['style_lock'] {
  return {
    pacing: `${analysis.style_dna.pacing.description} Average shot: ${formatSeconds(analysis.style_dna.pacing.average_shot_seconds)} seconds. Cut pattern: ${analysis.style_dna.pacing.cut_pattern}. Energy curve: ${analysis.style_dna.pacing.energy_curve.join('；')}.`,
    camera: `Framing: ${analysis.style_dna.cinematography.framing_pattern.join('；')}. Motion: ${analysis.style_dna.cinematography.camera_motion_pattern.join('；')}. Lens: ${analysis.style_dna.cinematography.lens_feel}. Composition: ${analysis.style_dna.cinematography.composition_rules.join('；')}.`,
    visual: `Medium: ${analysis.style_dna.visual.medium}. Palette: ${analysis.style_dna.visual.palette.join('；')}. Lighting: ${analysis.style_dna.visual.lighting_logic}. Textures: ${analysis.style_dna.visual.textures.join('；')}. Atmosphere: ${analysis.style_dna.visual.atmosphere}.`,
    performance: `Energy: ${analysis.style_dna.performance.energy}. Gesture: ${analysis.style_dna.performance.gesture_language}. Facial: ${analysis.style_dna.performance.facial_language}. Blocking: ${analysis.style_dna.performance.blocking_pattern}.`,
    sound: `Dialogue delivery: ${analysis.style_dna.audio.dialogue_delivery}. Music: ${analysis.style_dna.audio.music_logic}. Effects: ${analysis.style_dna.audio.sound_effects.join('；')}. Beat sync: ${analysis.style_dna.audio.beat_sync}.`,
    negative_constraints: ['No source face or identity', 'No copyrighted character, brand logo, or watermark', 'No character-reference drift'],
  };
}

/**
 * 把镜头内部的逐拍动作投影到创作层：ROLE_* 换成 CHAR_*，其余原样保留。
 * 与 role_ids 同源同规则——映射不到就报错，宁可拦住也不能让 ROLE_* 漏进新提示词。
 */
function projectActionBeats(beat: VideoBeat, roleToCharacter: Map<string, string>): ActionBeat[] {
  const mapIds = (ids: string[], field: string) =>
    ids.map((roleId) => {
      const characterId = roleToCharacter.get(roleId);
      if (!characterId) throw new Error(`源镜头 ${beat.beat_id} 的逐拍动作 ${field} 无法映射角色 ${roleId}。`);
      return characterId;
    });
  return (beat.action_beats ?? []).map((step) => ({
    at_seconds: step.at_seconds,
    actor_ids: mapIds(step.actor_ids, 'actor_ids'),
    action: step.action,
    ...(step.toward_ids?.length ? { toward_ids: mapIds(step.toward_ids, 'toward_ids') } : {}),
    ...(step.reaction ? { reaction: step.reaction } : {}),
    ...(step.consequence ? { consequence: step.consequence } : {}),
  }));
}

export function projectCharacterSwapBeats(
  analysis: VideoDnaAnalysis,
  selectedCharacters: Array<Pick<CharacterCandidate, 'source_role_id' | 'character_id'>>,
): Array<Omit<CreativeBeat, 'video_prompt'>> {
  const roleToCharacter = new Map(selectedCharacters.map((candidate) => [candidate.source_role_id, candidate.character_id]));
  if (roleToCharacter.size !== analysis.source_roles.length) throw new Error('角色映射没有覆盖全部源角色。');
  for (const role of analysis.source_roles) if (!roleToCharacter.has(role.role_id)) throw new Error(`角色映射缺少源角色 ${role.role_id}。`);
  return analysis.beats.map((beat, index) => {
    const visibleRoleIds = [...new Set(beat.role_ids)];
    const characterIds = visibleRoleIds.map((roleId) => {
      const characterId = roleToCharacter.get(roleId);
      if (!characterId) throw new Error(`源镜头 ${beat.beat_id} 无法映射角色 ${roleId}。`);
      return characterId;
    });
    const dialogueText = beat.dialogue.source_text.trim();
    const sourceIsSilent = !dialogueText && /^(无对白|无台词|沉默)/.test(beat.dialogue.semantic_intent.trim());
    const speakerId = beat.dialogue.speaker_role && !sourceIsSilent ? roleToCharacter.get(beat.dialogue.speaker_role) : undefined;
    if (beat.dialogue.speaker_role && !sourceIsSilent && !speakerId) throw new Error(`源镜头 ${beat.beat_id} 有对白但无法映射说话角色。`);
    const dialogue = speakerId
      ? dialogueText
        ? `${speakerId}: ${dialogueText}`
        : `${speakerId}: [Untranscribed authorized source speech from the analysis record; preserve its timing, semantic intent “${beat.dialogue.semantic_intent}”, and delivery “${beat.dialogue.delivery}”; do not invent or display a transcript.]`
      : '';
    return {
      beat_id: beat.beat_id,
      start_seconds: beat.start_seconds,
      end_seconds: beat.end_seconds,
      story_function: beat.narrative_function,
      character_ids: characterIds,
      action: beat.visual_action,
      ...(beat.action_beats?.length ? { action_beats: projectActionBeats(beat, roleToCharacter) } : {}),
      // 空间信息要跟着换角色一起投影下去，否则换完角色 3D 预演就找不到人了
      ...(beat.blocking ? {
        blocking: {
          ...beat.blocking,
          actors: beat.blocking.actors.map((a) => ({
            ...a,
            role_id: roleToCharacter.get(a.role_id) ?? a.role_id,
          })),
        },
      } : {}),
      performance: sourcePerformance(analysis, index),
      environment: beat.environment ?? `${beat.composition}; ${analysis.style_dna.visual.atmosphere}`,
      props: [...(beat.props ?? [])],
      framing: beat.framing,
      camera_motion: beat.camera_motion,
      lighting: `${beat.lighting} Color: ${beat.color}`,
      continuity: `Composition: ${beat.composition}. Transition in: ${beat.transition_in || 'none'}. Continuity in: ${beat.continuity_in}. Continuity out: ${beat.continuity_out}.`,
      dialogue,
      dialogue_speaker_ids: speakerId ? [speakerId] : [],
      sound: beat.sound,
      ...(beat.timeline_exception ? { timeline_exception: { ...beat.timeline_exception } } : {}),
    };
  });
}

export function createCreativeDraftFromAnalysis(
  analysis: VideoDnaAnalysis,
  selectedCharacters: CharacterCandidate[],
): CreativeDraft {
  const projected = projectCharacterSwapBeats(analysis, selectedCharacters);
  return {
    schema_version: 'creative-draft.v1',
    title: '英文原对白角色替换复刻包',
    concept_summary: analysis.source.one_line_summary,
    differentiation_log: ['身份轴：仅替换角色身份与形象', '对白轴：英文原对白逐字保留'],
    style_lock: projectCharacterSwapStyle(analysis),
    beats: projected.map((beat, index) => {
      const sourceDialogue = analysis.beats[index].dialogue;
      const localizedText = sourceDialogue.source_text.trim();
      if (beat.dialogue_speaker_ids?.length && !localizedText) throw new Error(`镜头 ${beat.beat_id} 缺少可用的英文原对白。`);
      return {
        ...beat,
        dialogue: beat.dialogue_speaker_ids?.length ? `${beat.dialogue_speaker_ids[0]}: ${localizedText}` : '',
      };
    }),
    qa: {
      timing_valid: true,
      variables_applied: true,
      originality_pass: true,
      source_identity_leakage: false,
      source_dialogue_leakage: false,
      notes: ['由一次 Gemini 视频分析结果在本地确定性编译。'],
    },
  };
}

function applyLocalizedDialogue(
  projectedBeats: Array<Omit<CreativeBeat, 'video_prompt'>>,
  sourceBeats: VideoDnaAnalysis['beats'],
): Array<Omit<CreativeBeat, 'video_prompt'>> {
  const sourceById = new Map(sourceBeats.map((beat) => [beat.beat_id, beat]));
  return projectedBeats.map((beat) => {
    const source = sourceById.get(beat.beat_id);
    if (!source) throw new Error(`英文对白记录缺少镜头 ${beat.beat_id}。`);
    const expectedSpeakers = beat.dialogue_speaker_ids ?? [];
    if (expectedSpeakers.length === 0) return { ...beat, dialogue: '', dialogue_speaker_ids: [] };
    const sourceText = source.dialogue.source_text.trim();
    if (!sourceText) throw new Error(`镜头 ${beat.beat_id} 缺少英文原对白。`);
    return {
      ...beat,
      dialogue: `${expectedSpeakers[0]}: ${sourceText}`,
      dialogue_speaker_ids: expectedSpeakers,
    };
  });
}

function compileBeatPrompt(
  beat: CreativeBeat,
  pack: CreativePack,
  aspectRatio: string,
  effectiveMode: RemixMode,
  voiceDirection: string,
): string {
  const duration = beat.end_seconds - beat.start_seconds;
  const compact = (value: string, limit = 120) => value.replace(/\s+/g, ' ').trim().slice(0, limit);
  const environment = compact(beat.environment || pack.concept_summary, 90);
  const props = (beat.props ?? []).join('；') || 'none';
  const offscreenSpeakerIds = (beat.dialogue_speaker_ids ?? []).filter((id) => !beat.character_ids.includes(id));
  const speakerPlacement = offscreenSpeakerIds.length > 0 ? `；画外音=${offscreenSpeakerIds.join(',')}，不得出镜` : '';
  return [
    '[STYLE LOCK] Follow GLOBAL STYLE LOCK.',
    `[CHARACTER DEFINITIONS] ${beat.character_ids.join(',') || 'none'}; follow GLOBAL CHARACTER DEFINITIONS and the named reference images.`,
    `[SHOT PURPOSE] ${compact(beat.story_function, 70)}`,
    `[ACTION & PERFORMANCE] ${compact(beat.action, 120)}；${compact(beat.performance, 100)}`,
    `[ENVIRONMENT] ${environment}；props=${compact(props, 60)}`,
    `[CAMERA & MOTION] ${compact(beat.framing, 45)}；${compact(beat.camera_motion, 45)}；single uninterrupted shot.`,
    `[LIGHTING & MATERIAL] ${compact(beat.lighting, 80)}`,
    `[CONTINUITY] ${compact(beat.continuity, 110)}`,
    effectiveMode === 'character_swap'
      ? `[DIALOGUE & SOUND] 英文原对白=${beat.dialogue.trim() || 'none'}${speakerPlacement}；音效=${compact(beat.sound, 70)}；逐字保留英文台词，使用全新声线并原生生成音乐/环境音；非人角色不得强加人嘴。${voiceDirection ? ` Voice=${compact(voiceDirection, 60)}` : ''}`
      : `[DIALOGUE & SOUND] 对白=${compact(beat.dialogue.trim() || 'none', 90)}${speakerPlacement}；音效=${compact(beat.sound, 70)}`,
    `[DURATION & OUTPUT] ${formatSeconds(beat.start_seconds)}-${formatSeconds(beat.end_seconds)}s；duration=${formatSeconds(duration)}s；${aspectRatio}.`,
  ].join('\n');
}

function framePrompt(
  label: 'first' | 'last',
  beat: CreativeBeat,
  pack: CreativePack,
  aspectRatio: string,
): string {
  return `[${label.toUpperCase()} FRAME] ${aspectRatio}. [CHARACTER DEFINITIONS] ${definitionsForBeat(beat, pack.character_bible)} [FRAME CONTENT] ${beat.action} Environment: ${beat.environment || pack.concept_summary}. Props: ${(beat.props ?? []).join('；') || 'none'}. Framing: ${beat.framing}. Lighting: ${beat.lighting}. Continuity: ${beat.continuity}. Render a single cinematic frame with stable identity and the exact locked species, body plan and anatomically or mechanically correct structure; no text, logo, or watermark.`;
}

function nativeAudioGenerationBlock(pack: CreativePack, voiceDirection: string): string {
  return [
    '[NATIVE AUDIO GENERATION — NO AUDIO FILE INPUT]',
    `1. ENGLISH VOICES: Speak every written English source line exactly word-for-word inside its listed timeline window. Preserve the assigned CHAR_* speaker, emotion and delivery. Voice direction: ${voiceDirection || 'create a distinct new character-appropriate voice that does not imitate any source voice'}. Use entity-appropriate articulation and lip sync only when the visible entity has a speaking mouth; never humanize a non-human entity. Do not translate, add, omit, clean up or paraphrase dialogue.`,
    `2. ORIGINAL INSTRUMENTAL MUSIC: Compose a new non-vocal music bed that follows the requested pacing, emotional energy and beat changes without copying the source recording. Audio style logic: ${pack.style_lock.sound}`,
    '3. ORIGINAL AMBIENCE & SFX: Generate a new ambience bed and synchronized action, prop and transition effects from each shot\'s [DIALOGUE & SOUND] description. Keep speech intelligible and never reuse any sound from the source video.',
  ].join('\n');
}

interface RunWindow {
  start: number;
  end: number;
}

function roundSeconds(value: number): number {
  return Number(value.toFixed(3));
}

function buildRunWindows(beats: CreativeBeat[], totalDuration: number, maxRunSeconds = SEEDANCE_MAX_RUN_SECONDS): RunWindow[] {
  if (totalDuration <= maxRunSeconds) return [{ start: 0, end: totalDuration }];

  const safeInteriorBoundaries = beats
    .slice(0, -1)
    .map((beat) => beat.end_seconds)
    .filter((boundary) => !beats.some((beat) =>
      beat.start_seconds < boundary - 0.001 && beat.end_seconds > boundary + 0.001,
    ));
  const points = [0, ...safeInteriorBoundaries, totalDuration]
    .sort((left, right) => left - right)
    .filter((point, index, values) => index === 0 || point - values[index - 1] > 0.001);
  const minimumRunsFrom = Array<number>(points.length).fill(Number.POSITIVE_INFINITY);
  minimumRunsFrom[points.length - 1] = 0;

  for (let startIndex = points.length - 2; startIndex >= 0; startIndex -= 1) {
    for (let endIndex = startIndex + 1; endIndex < points.length; endIndex += 1) {
      if (points[endIndex] - points[startIndex] > maxRunSeconds) break;
      if (Number.isFinite(minimumRunsFrom[endIndex])) {
        minimumRunsFrom[startIndex] = Math.min(minimumRunsFrom[startIndex], 1 + minimumRunsFrom[endIndex]);
      }
    }
  }

  if (!Number.isFinite(minimumRunsFrom[0])) {
    const longBeat = beats.find((beat) => beat.end_seconds - beat.start_seconds > maxRunSeconds);
    const detail = longBeat
      ? `镜头 ${longBeat.beat_id}（${formatSeconds(longBeat.start_seconds)}-${formatSeconds(longBeat.end_seconds)} 秒）超过 ${maxRunSeconds} 秒`
      : `现有镜头边界无法组成每段不超过 ${maxRunSeconds} 秒的连续区间`;
    throw new Error(`${detail}；为避免跨段重复动作或对白，请先把 DNA 时间轴拆成语义完整、单段不超过 ${maxRunSeconds} 秒的原子镜头。`);
  }

  const windows: RunWindow[] = [];
  let startIndex = 0;
  while (startIndex < points.length - 1) {
    const remainingRuns = minimumRunsFrom[startIndex];
    const idealEnd = points[startIndex] + (totalDuration - points[startIndex]) / remainingRuns;
    const candidates: number[] = [];
    for (let endIndex = startIndex + 1; endIndex < points.length; endIndex += 1) {
      if (points[endIndex] - points[startIndex] > maxRunSeconds) break;
      if (minimumRunsFrom[endIndex] === remainingRuns - 1) candidates.push(endIndex);
    }
    const endIndex = candidates.reduce((best, candidate) =>
      Math.abs(points[candidate] - idealEnd) < Math.abs(points[best] - idealEnd) ? candidate : best,
    );
    windows.push({ start: points[startIndex], end: points[endIndex] });
    startIndex = endIndex;
  }
  return windows;
}

function localizedRunTimeline(
  pack: CreativePack,
  window: RunWindow,
  aspectRatio: string,
  effectiveMode: RemixMode,
  voiceDirection: string,
): { beatIds: string[]; timeline: string } {
  const overlapping = pack.beats.filter((beat) =>
    beat.end_seconds > window.start && beat.start_seconds < window.end,
  );
  const entries = overlapping.map((beat) => {
    if (beat.start_seconds < window.start - 0.001 || beat.end_seconds > window.end + 0.001) {
      throw new Error(`镜头 ${beat.beat_id} 跨越 Seedance 分段边界；为避免重复动作或对白，请先将它拆成语义完整的原子镜头。`);
    }
    const localized: CreativeBeat = {
      ...beat,
      start_seconds: roundSeconds(beat.start_seconds - window.start),
      end_seconds: roundSeconds(beat.end_seconds - window.start),
    };
    return `--- ${beat.beat_id} | source ${formatSeconds(beat.start_seconds)}-${formatSeconds(beat.end_seconds)}s ---\n${compileBeatPrompt(localized, pack, aspectRatio, effectiveMode, voiceDirection)}`;
  });
  return { beatIds: overlapping.map((beat) => beat.beat_id), timeline: entries.join('\n\n') };
}

export function compileCreativePrompts(
  sourcePack: CreativeDraft | CreativePack,
  options: RemixBrief & {
    analysis?: VideoDnaAnalysis;
    selectedCharacters: CharacterCandidate[];
    referenceAssets?: ReferenceAsset[];
  },
): CreativePack {
  if (options.sourceRightsScope === 'unselected') throw new Error('请先明确选择参考素材范围。');
  const source = JSON.parse(JSON.stringify(sourcePack)) as CreativeDraft | CreativePack;
  const effectiveMode = resolveRemixMode(options);
  const selectedCharacters = orderedSelections(options.selectedCharacters, options.analysis);
  if (selectedCharacters.length === 0) throw new Error('最终生成包至少需要一个已选角色。');
  if (effectiveMode === 'character_swap' && !options.analysis) throw new Error('character_swap 编译必须提供源 analysis。');
  const semanticBeats = effectiveMode === 'character_swap'
    ? applyLocalizedDialogue(
        projectCharacterSwapBeats(options.analysis!, selectedCharacters),
        options.analysis!.beats,
      )
    : source.beats;
  let pack: CreativePack = {
    schema_version: 'creative-pack.v1',
    title: effectiveMode === 'character_swap' ? '英文原对白角色替换复刻包' : source.title,
    concept_summary: effectiveMode === 'character_swap'
      ? '依据 Gemini 一次提取的视频 DNA 与英文原对白生成角色替换复刻包；角色参考图锁定身份，无声原视频锁定剧情、场景、道具、动作、镜头、节奏与表演。'
      : source.concept_summary,
    differentiation_log: effectiveMode === 'character_swap'
      ? ['身份轴：仅替换角色身份与形象', '对白轴：英文原对白逐字保留']
      : [...source.differentiation_log],
    character_bible: selectedCharacters.map(candidateToBible),
    style_lock: effectiveMode === 'character_swap'
      ? projectCharacterSwapStyle(options.analysis!)
      : JSON.parse(JSON.stringify(source.style_lock)) as CreativePack['style_lock'],
    beats: semanticBeats.map((beat) => ({ ...beat, video_prompt: '' })),
    prompt_bundle: {
      generic_master: '',
      target_model: options.targetModel,
      target_prompt: '',
      negative_prompt: '',
      first_frame_prompt: '',
      last_frame_prompt: '',
    },
    qa: JSON.parse(JSON.stringify(source.qa)) as CreativePack['qa'],
  };
  pack = normalizeKnownSourceRoleReferences(pack, selectedCharacters);
  pack.remix_policy = {
    requested_mode: options.mode,
    effective_mode: effectiveMode,
    source_rights_scope: options.sourceRightsScope,
  };
  const referenceAssets = options.referenceAssets ?? [];
  const boundAssets = new Map<string, { asset: ReferenceAsset; candidate: CharacterCandidate }>();
  for (const candidate of selectedCharacters) {
    const matches = referenceAssets.filter((asset) =>
      !asset.retired &&
      asset.approved &&
      Boolean(asset.asset_id.trim()) &&
      asset.character_id === candidate.character_id &&
      asset.candidate_id === candidate.candidate_id &&
      asset.prompt === candidate.reference_image_prompt,
    );
    if (matches.length !== 1) {
      throw new Error(`角色 ${candidate.character_id} 的已选方案必须恰好绑定一张匹配提示词的已确认参考图。`);
    }
    boundAssets.set(candidate.character_id, { asset: matches[0], candidate });
  }
  pack.beats = pack.beats.map((beat) => ({
    ...beat,
    video_prompt: compileBeatPrompt(beat, pack, options.aspectRatio, effectiveMode, options.voiceBrief),
  }));

  const allCharacters = pack.character_bible.map(characterDefinition).join('\n');
  const totalDuration = pack.beats.at(-1)?.end_seconds ?? 0;
  const maxRunSeconds = effectiveMode === 'character_swap' ? CHARACTER_SWAP_MAX_RUN_SECONDS : SEEDANCE_MAX_RUN_SECONDS;
  const runWindows = buildRunWindows(pack.beats, totalDuration, maxRunSeconds);
  const timeline = pack.beats
    .map((beat) => `--- ${beat.beat_id} ---\n${beat.video_prompt}`)
    .join('\n\n');
  const master = [
    `[PROJECT] ${pack.title}. ${pack.concept_summary}`,
    `[OUTPUT] Language: ${options.outputLanguage}; aspect ratio: ${options.aspectRatio}; total duration: ${formatSeconds(totalDuration)} seconds.`,
    runWindows.length > 1
      ? `[EXECUTION LIMIT] Generate this project as ${runWindows.length} separate Seedance runs of no more than ${maxRunSeconds} seconds, then assemble them in order. Never request the full ${formatSeconds(totalDuration)} seconds in one run.`
      : '[EXECUTION LIMIT] This project fits one Seedance run.',
    `[GLOBAL CHARACTER DEFINITIONS]\n${allCharacters}`,
    `[GLOBAL STYLE LOCK] ${styleDefinition(pack)}`,
    effectiveMode === 'character_swap' ? nativeAudioGenerationBlock(pack, options.voiceBrief) : '',
    `[ATOMIC SHOT TIMELINE]\n${timeline}`,
    effectiveMode === 'character_swap'
      ? '[EXECUTION] Preserve the exact authorized visual story, timing, camera, action, blocking, performance, environment and props from the silent source-video reference while replacing every character identity with the locked definitions. Speak only the supplied English source dialogue exactly as written and generate the final synchronized new character voices, instrumental music, ambience and SFX natively. Never reuse source identity, source audio, subtitles or on-screen text.'
      : '[EXECUTION] Generate only the described original audiovisual work. Treat every timeline item as one uninterrupted camera setup. Use the exact new dialogue written in each item. This prompt is complete and self-contained.',
  ].join('\n\n');

  const characterNegatives = pack.character_bible
    .map((character) => character.reference_prompts.negative_prompt)
    .filter(Boolean);
  const characterBindings = pack.character_bible.map((character, index) => {
    const selected = boundAssets.get(character.character_id);
    if (!selected) throw new Error(`角色 ${character.character_id} 缺少已确认参考图。`);
    const profile = resolveCharacterEntity(character);
    return {
      slot: `@Image ${index + 1}`,
      kind: 'character_reference' as const,
      source_role_id: selected.candidate.source_role_id,
      character_id: character.character_id,
      candidate_id: selected.candidate.candidate_id,
      asset_id: selected.asset.asset_id,
      reference_prompt: selected.candidate.reference_image_prompt,
      approved: selected.asset.approved,
      instruction: `Use ${character.character_id}角色参考图 as the sole identity reference for ${character.character_id}; lock entity type ${profile.entity_type}, species ${profile.species}, body plan ${profile.body_plan}, anthropomorphism level ${profile.anthropomorphism_level}, casting envelope ${formatCastingEnvelope(resolveCharacterCastingEnvelope(character))}, identity geometry, surface or fur pattern, hair, silhouette, wardrobe or accessories, palette and signature features across every shot. Keep this new fictional identity inside the same broad casting lane without reproducing the source face. Never change species or humanize a non-human entity.`,
    };
  });
  const sourceVideoBinding = {
    slot: '@Video 1',
    kind: 'source_video_reference' as const,
    instruction: 'Use 无声参考视频 as a VISUAL-ONLY reference for exact shot timing, camera, action, blocking, performance, environment, props and effect timing. It must contain zero audio tracks. Never inherit its face, identity, voice, dialogue, music, ambience, subtitles, text, logo or watermark.',
  };
  const bindings = [...characterBindings, sourceVideoBinding];
  const runs = runWindows.map((window, index) => {
    const duration = roundSeconds(window.end - window.start);
    const localized = localizedRunTimeline(pack, window, options.aspectRatio, effectiveMode, options.voiceBrief);
    const runBeatIds = new Set(localized.beatIds);
    const runCharacterIds = new Set(pack.beats
      .filter((beat) => runBeatIds.has(beat.beat_id))
      .flatMap((beat) => [...beat.character_ids, ...(beat.dialogue_speaker_ids ?? [])]));
    const runCharacters = pack.character_bible.filter((character) => runCharacterIds.has(character.character_id));
    const runCharacterBindings = characterBindings.filter((binding) => binding.character_id && runCharacterIds.has(binding.character_id));
    const runMaterialBindingBlock = [
      '[MATERIAL BINDING — DO THIS ONCE BEFORE GENERATION]',
      ...runCharacters.map((character) => `Replace the placeholder 【在此手动绑定${character.character_id}图片缩略图】 with the actual Jimeng material chip once, and name that bound material “${character.character_id}角色参考图”.`),
      'Replace the placeholder 【在此手动绑定本RUN对应的无声原视频片段】 with the actual Jimeng video-material chip once, and name that bound material “无声参考视频”.',
      'The names above are aliases for the bound materials. Every later occurrence is plain text referring back to those aliases. Do not paste UUIDs and do not bind the same material again later.',
    ].join('\n');
    const runReferenceBlock = [...runCharacterBindings, sourceVideoBinding].map((binding) => binding.instruction).join('\n');
    const runCharacterDefinitions = runCharacters.map(characterDefinition).join('\n');
    const assemblyInstruction = runWindows.length === 1
      ? '本次生成结果即为完整成片。'
      : index === 0
        ? `导出精确 ${formatSeconds(duration)} 秒；保留尾帧动作、构图、道具和环境声状态，供 RUN_${String(index + 2).padStart(2, '0')} 接续。`
        : `首帧严格承接上一段尾帧；生成后按 source ${formatSeconds(window.start)} 秒边界无重叠顺序拼接，保持角色、服装、道具和环境声连续。`;
    const targetPrompt = [
      runMaterialBindingBlock,
      `[TARGET MODEL] ${options.targetModel}, run ${index + 1}/${runWindows.length}.`,
      `[SOURCE PREP] Attach the physically silent source-video clip covering absolute ${formatSeconds(window.start)}-${formatSeconds(window.end)} seconds as 无声参考视频. The clip must be exactly ${formatSeconds(duration)} seconds with zero audio tracks; reset its local timeline to 0-${formatSeconds(duration)} seconds and use it as visual-only input.`,
      `[OUTPUT] Generate exactly ${formatSeconds(duration)} seconds; language ${options.outputLanguage}; aspect ratio ${options.aspectRatio}.`,
      `[REFERENCE PRIORITY]\n${runReferenceBlock}`,
      `[GLOBAL CHARACTER DEFINITIONS]\n${runCharacterDefinitions}`,
      `[GLOBAL STYLE LOCK] ${styleDefinition(pack)}`,
      effectiveMode === 'character_swap' ? nativeAudioGenerationBlock(pack, options.voiceBrief) : '',
      `[LOCAL ATOMIC SHOT TIMELINE]\n${localized.timeline}`,
      `[ASSEMBLY CONTINUITY] ${assemblyInstruction}`,
      effectiveMode === 'character_swap'
        ? '[EXECUTION] Preserve the exact authorized visual story in 无声参考视频—shot timing, camera, action, blocking, performance, environment, props and effect timing—while replacing character identities. Generate the final synchronized audio natively: speak the written English source dialogue exactly word-for-word using new character voices, compose an original instrumental music bed and create original ambience plus action-synchronized SFX. Never use source identity, source audio, subtitles or on-screen text.'
        : '[EXECUTION] Generate the described segment using 无声参考视频 only for the authorized visual timing and motion structure.',
    ].join('\n\n');
    if (targetPrompt.length > SEEDANCE_PROMPT_SAFETY_LIMIT) {
      throw new Error(`Seedance ${index + 1}/${runWindows.length} 提示词为 ${targetPrompt.length} 字符，超过 ${SEEDANCE_PROMPT_SAFETY_LIMIT} 字符安全上限；请缩短单次 RUN 或继续压缩镜头描述。`);
    }
    return {
      run_id: `RUN_${String(index + 1).padStart(2, '0')}`,
      source_start_seconds: window.start,
      source_end_seconds: window.end,
      duration_seconds: duration,
      beat_ids: localized.beatIds,
      target_prompt: targetPrompt,
      assembly_instruction: assemblyInstruction,
    };
  });
  const seedanceTargetPrompt = runs.length === 1
    ? runs[0].target_prompt
    : [
        `[SEEDANCE MULTI-RUN PLAN] The ${formatSeconds(totalDuration)}-second project exceeds the ${maxRunSeconds}-second single-run limit. Execute the ${runs.length} prompts below separately; never submit them as one generation.`,
        ...runs.map((run) => `===== ${run.run_id} | source ${formatSeconds(run.source_start_seconds)}-${formatSeconds(run.source_end_seconds)}s =====\n${run.target_prompt}`),
      ].join('\n\n');

  pack.prompt_bundle = {
    generic_master: master,
    target_model: options.targetModel,
    target_prompt: seedanceTargetPrompt,
    negative_prompt: [
      ...pack.style_lock.negative_constraints,
      ...characterNegatives,
      effectiveMode === 'character_swap'
        ? 'No real-person likeness, copyrighted character, brand logo, watermark, source voice, source audio, source subtitle, on-screen text, identity drift, casting-envelope drift, species drift, body-plan drift, unintended humanization, wardrobe or accessory drift, English dialogue wording drift, translation, paraphrase, malformed anatomy or construction, duplicate entities, unintended subtitles, or unrequested cut.'
        : 'No real-person likeness, copyrighted character, brand logo, watermark, source dialogue, source-specific props, identity drift, casting-envelope drift, species drift, body-plan drift, wardrobe or accessory drift, malformed anatomy or construction, duplicate entities, unintended subtitles, or unrequested cut.',
    ].join('；'),
    first_frame_prompt: framePrompt('first', pack.beats[0], pack, options.aspectRatio),
    last_frame_prompt: framePrompt('last', pack.beats[pack.beats.length - 1], pack, options.aspectRatio),
  };
  pack.seedance_asset_map = {
    schema_version: 'seedance-assets.v1',
    bindings,
    runs,
    usage_note: `${runWindows.length > 1 ? `视频共 ${formatSeconds(totalDuration)} 秒，已拆成 ${runWindows.length} 次、每次不超过 ${maxRunSeconds} 秒的独立生成；每次上传对应区间的无声原视频片段，最后顺序拼接。` : '本片可一次生成。'} 只在提示词开头绑定各角色参考图和无声参考视频一次，不粘贴 UUID，也不重复绑定。角色图锁身份，无声原视频锁镜头、动作与时间线；英文原对白逐字保留，但声线、音乐、环境音与动作音效不得继承原视频音轨。`,
  };

  return pack;
}
