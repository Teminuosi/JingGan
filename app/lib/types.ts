export type MediaResolutionSetting = 'default' | 'high';

export interface AnalysisSettings {
  model: string;
  fps: 1 | 2 | 4;
  mediaResolution: MediaResolutionSetting;
  transcribeDialogue: boolean;
}

export interface LocalVideoMetadata {
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface UsageStats {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface GeminiResult<T> {
  data: T;
  usage: UsageStats;
  modelVersion: string;
  remoteFileDeleted: boolean;
}

export type ProgressStage =
  | 'uploading'
  | 'processing'
  | 'analyzing'
  | 'cleaning'
  | 'restoring'
  | 'saving'
  | 'remixing'
  | 'done';

export interface DialogueAnalysis {
  speaker_role: string;
  speaker_on_screen: boolean;
  source_text: string;
  semantic_intent: string;
  delivery: string;
  approx_characters: number;
}

export type EntityType =
  | 'human'
  | 'animal'
  | 'anthropomorphic_animal'
  | 'anthropomorphic_object'
  | 'creature'
  | 'robot'
  | 'unknown';

export type AnthropomorphismLevel = 'none' | 'partial' | 'full' | 'unknown';

export interface EntityProfile {
  entity_type?: EntityType;
  species?: string;
  body_plan?: string;
  anthropomorphism_level?: AnthropomorphismLevel;
}

export interface CastingEnvelope {
  apparent_age_band: string;
  gender_expression: string;
  regional_visual_context: string;
  build_silhouette: string;
  hair_grooming: string;
  wardrobe_function: string;
  visual_medium: string;
}

export interface SourceRole extends EntityProfile {
  role_id: string;
  casting_envelope?: CastingEnvelope;
  narrative_function: string;
  generalized_appearance: string;
  silhouette: string;
  wardrobe_logic: string;
  performance_traits: string[];
  continuity_anchors: string[];
  identity_risk: 'none' | 'real_person' | 'celebrity_or_ip' | 'uncertain';
}

export interface TimelineException {
  kind: 'gap' | 'overlap';
  duration_seconds: number;
  reason: string;
}

/**
 * 一个不间断机位里的一次「动作—反应—后果」。
 * 拆条规则管的是机位，不管机位内部的回合：19.5 秒的固定镜头里可能有六七次交锋，
 * 全压进 visual_action 一句话就会丢掉因果（谁看向谁、谁因为看到谁才退让）。
 */
export interface ActionBeat {
  /** 相对整片的绝对秒数，落在所属 beat 区间内，递增。 */
  at_seconds: number;
  /** 发起者，源分析里是 ROLE_*，投影到创作层后是 CHAR_*。 */
  actor_ids: string[];
  action: string;
  /** 动作指向、看向或指着谁。 */
  toward_ids?: string[];
  reaction?: string;
  /** 这一拍造成什么：谁退让、谁拿到势、力量关系怎么变。 */
  consequence?: string;
}

/**
 * 一个角色在这一镜里的空间位置。
 *
 * 为什么必须结构化而不是塞进 composition 那段散文里：
 * 3D 预演要按它摆人、连续性引擎要按它查越轴、提示词要按它写「谁在画面左边」。
 * 散文描述这三样都用不了——「三人呈三角站位」这句话摆不出坐标。
 */
export interface BeatActorBlocking {
  role_id: string;
  /** 画面左右位置。相机视角，不是角色自己的左右。 */
  screen_position: 'left' | 'center_left' | 'center' | 'center_right' | 'right' | 'offscreen';
  /** 前后景层次。决定遮挡关系。 */
  depth_layer: 'foreground' | 'midground' | 'background';
  /** 朝向：面向镜头 / 背对镜头 / 侧身朝左 / 侧身朝右。 */
  facing: string;
  /** 中途才入画的，写绝对秒数；一开始就在画面里的留空。 */
  entry_at?: number;
  /** 中途出画的绝对秒数。 */
  exit_at?: number;
}

/** 这一镜的机位参数。枚举值，可被程序直接消费。 */
export interface BeatCameraBlocking {
  shot_size: 'ECU' | 'CU' | 'MCU' | 'MS' | 'MLS' | 'LS' | 'ELS' | 'unknown';
  angle: 'eye_level' | 'high' | 'low' | 'overhead' | 'dutch' | 'over_shoulder' | 'pov' | 'unknown';
  movement: 'static' | 'pan' | 'tilt' | 'dolly_in' | 'dolly_out' | 'truck' | 'crane' | 'handheld' | 'zoom' | 'orbit' | 'unknown';
  /** 主体或镜头的运动方向。越轴检查靠它。 */
  screen_direction: 'left_to_right' | 'right_to_left' | 'toward_camera' | 'away_from_camera' | 'static' | 'unknown';
  /** 相机到主体的估计距离（米）。拿不准就留空，别编。 */
  subject_distance_m?: number;
}

/**
 * 这一镜的空间信息。
 * 旧 DNA 没有这个字段，所有下游都要能在缺失时退回原行为。
 */
export interface BeatBlocking {
  actors: BeatActorBlocking[];
  camera: BeatCameraBlocking;
}

export interface VideoBeat {
  beat_id: string;
  start_seconds: number;
  end_seconds: number;
  role_ids: string[];
  narrative_function: string;
  visual_action: string;
  /** 本镜内部的逐拍交锋；旧 DNA 没有这个字段，下游一律要能退回只用 visual_action。 */
  action_beats?: ActionBeat[];
  /**
   * 结构化空间信息：谁站在画面哪儿、机位是什么。
   * 3D 预演、越轴检查、提示词的站位段全靠它。旧 DNA 没有，下游要能退回。
   */
  blocking?: BeatBlocking;
  /**
   * 这一镜被人工改过。
   * 分析层是证据层，默认只读；但模型看不清的地方（瞬时手势、后景角色）必须允许看过片的人纠正，
   * 否则一份读错的 DNA 会往下污染故事、角色和成片，而唯一出路是花钱重跑再赌一次。
   * 允许改的代价是必须永远带着这个标记：导出的 JSON 里也在，谁都能看出哪几镜是人写的。
   */
  corrected_by_user?: boolean;
  environment?: string;
  props?: string[];
  framing: string;
  camera_motion: string;
  composition: string;
  lighting: string;
  color: string;
  sound: string;
  dialogue: DialogueAnalysis;
  transition_in: string;
  continuity_in: string;
  continuity_out: string;
  confidence: number;
  timeline_exception?: TimelineException;
}

export interface VideoDnaAnalysis {
  schema_version: 'video-dna.v1';
  source: {
    duration_seconds: number;
    aspect_ratio: string;
    language: string;
    format_type: string;
    one_line_summary: string;
    rights_risks: string[];
  };
  style_dna: {
    hook_pattern: string;
    narrative_arc: string[];
    pacing: {
      description: string;
      average_shot_seconds: number;
      energy_curve: string[];
      cut_pattern: string;
    };
    cinematography: {
      framing_pattern: string[];
      camera_motion_pattern: string[];
      lens_feel: string;
      composition_rules: string[];
      continuity_rules: string[];
    };
    visual: {
      medium: string;
      palette: string[];
      lighting_logic: string;
      textures: string[];
      atmosphere: string;
    };
    performance: {
      energy: string;
      gesture_language: string;
      facial_language: string;
      blocking_pattern: string;
    };
    audio: {
      dialogue_delivery: string;
      music_logic: string;
      sound_effects: string[];
      beat_sync: string;
    };
  };
  source_roles: SourceRole[];
  beats: VideoBeat[];
  preserve_recommendations: string[];
  replace_recommendations: string[];
  originality_risks: string[];
  uncertainties: string[];
  /** 拆解时同时产出的英文版，用来拼英文提示词。旧分析没有。 */
  english?: EnglishDna;
}

export interface EnglishDna {
  medium: string;
  visual: string;
  performance: string;
  sound: string;
  roles: Array<{ role_id: string; description: string }>;
  beats: Array<{
    beat_id: string;
    action: string;
    action_beats: Array<{ action: string; reaction: string; consequence: string }>;
    environment: string;
    props: string[];
    framing: string;
    camera_motion: string;
    lighting: string;
    sound: string;
  }>;
}

export type DnaLockKey =
  | 'pacing'
  | 'camera'
  | 'lighting'
  | 'performance'
  | 'sound'
  | 'narrative';

export type RemixMode = 'character_swap' | 'light_remix' | 'full_original';

export type SourceRightsScope = 'unselected' | 'owned_or_authorized' | 'third_party_reference';

export interface RemixBrief {
  roleDesigns?: Record<string, RoleDesignSettings>;
  workflow?: 'same-type-original';
  /** rewrite=重写新故事（默认）；preserve=保留原剧情与镜头，只换角色并把对白译成目标语言。 */
  storyMode?: 'rewrite' | 'preserve';
  storyDraft?: CreativeDraft;
  storyConfirmed?: boolean;
  storyJobId?: string;
  mode: RemixMode;
  sourceRightsScope: SourceRightsScope;
  newConcept: string;
  characterBrief: string;
  dialogueBrief: string;
  voiceBrief: string;
  settingBrief: string;
  targetModel: string;
  aspectRatio: string;
  outputLanguage: string;
  /**
   * 保留原剧情时，「翻译」选的是语种还是「无」。
   * true=把原片台词译成 outputLanguage；缺省/false=做成没有对白的片子——
   * 台词不写进草稿，编译器据此在提示词里禁止任何配音。默认「无」，不花钱也不会凭空多出人声。
   * outputLanguage 始终保持一个真实语种，不塞 'none' 之类的哨兵值进提示词。
   */
  translateDialogue?: boolean;
  /** 每镜最长秒数上限；缺省时按 min(10, 目标视频模型单次上限) 推导，用户可在故事页改。 */
  maxShotSeconds?: number;
  /** 每个角色出几套候选方案；缺省 4。少一点省钱，多一点好挑。 */
  candidateCount?: number;
  locks: Record<DnaLockKey, boolean>;
}

export type AudioReferenceKind =
  | 'dialogue_audio_reference'
  | 'music_audio_reference'
  | 'ambience_audio_reference';

export interface CharacterBible extends EntityProfile {
  character_id: string;
  casting_envelope?: CastingEnvelope;
  role_function: string;
  identity_anchors: string[];
  appearance: string;
  wardrobe: string;
  palette: string[];
  performance: string;
  continuity_lock: string[];
  reference_prompts: {
    turnaround_sheet: string;
    expression_sheet: string;
    hero_portrait: string;
    negative_prompt: string;
  };
}

export interface CharacterCandidate extends CharacterBible {
  design_settings?: RoleDesignSettings;
  design_mode?: 'source_match' | 'style_variant';
  candidate_id: string;
  source_role_id: string;
  design_name: string;
  design_rationale: string;
  reference_image_prompt: string;
}

export interface CharacterProposalSet {
  source_role_id: string;
  role_function: string;
  candidates: CharacterCandidate[];
}

export interface CharacterProposals {
  archived_role_sets?: CharacterProposalSet[];
  schema_version: 'character-proposals.v1';
  role_sets: CharacterProposalSet[];
}

export interface RoleDesignSettings {
  entity_type?: EntityType;
  species?: string;
  body_plan?: string;
  gender_expression?: string;
  apparent_age_band?: string;
  build_silhouette?: string;
  wardrobe_function?: string;
  visual_medium?: string;
  prompt?: string;
}

export interface ReferenceAsset {
  asset_id: string;
  project_id: string;
  character_id: string;
  candidate_id: string;
  kind: 'identity_sheet';
  uri: string;
  mime_type: string;
  prompt: string;
  approved: boolean;
  retired?: boolean;
  uploading?: boolean;
  created_at: string;
}

export interface SeedanceAssetBinding {
  slot: string;
  kind: 'character_reference' | 'source_video_reference' | AudioReferenceKind;
  source_role_id?: string;
  character_id?: string;
  candidate_id?: string;
  asset_id?: string;
  reference_prompt?: string;
  approved?: boolean;
  instruction: string;
}

export interface SeedanceRun {
  run_id: string;
  source_start_seconds: number;
  source_end_seconds: number;
  duration_seconds: number;
  beat_ids: string[];
  target_prompt: string;
  assembly_instruction: string;
}

/** 覆盖整条新故事时间轴的单次生成提示词；分段 runs 仍保留，用于测试或模型不支持该时长时回退。 */
export interface SeedanceFullRun extends SeedanceRun {
  character_limit: number;
  within_character_limit: boolean;
}

export interface CreativeBeat {
  beat_id: string;
  start_seconds: number;
  end_seconds: number;
  story_function: string;
  character_ids: string[];
  action: string;
  /** 从 VideoBeat 投影下来的逐拍交锋，ROLE_* 已换成 CHAR_*；旧数据没有，下游要能退回只用 action。 */
  action_beats?: ActionBeat[];
  /** 投影下来的空间信息，role_id 已换成 CHAR_*。 */
  blocking?: BeatBlocking;
  performance: string;
  environment: string;
  props: string[];
  framing: string;
  camera_motion: string;
  lighting: string;
  continuity: string;
  dialogue: string;
  dialogue_speaker_ids?: string[];
  sound: string;
  video_prompt: string;
  timeline_exception?: TimelineException;
}

export interface CreativePack {
  schema_version: 'creative-pack.v1';
  title: string;
  concept_summary: string;
  differentiation_log: string[];
  remix_policy?: {
    requested_mode: RemixMode;
    effective_mode: RemixMode;
    source_rights_scope: SourceRightsScope;
  };
  character_bible: CharacterBible[];
  style_lock: {
    pacing: string;
    camera: string;
    visual: string;
    performance: string;
    sound: string;
    negative_constraints: string[];
  };
  beats: CreativeBeat[];
  prompt_bundle: {
    generic_master: string;
    target_model: string;
    target_prompt: string;
    negative_prompt: string;
    first_frame_prompt: string;
    last_frame_prompt: string;
  };
  qa: {
    timing_valid: boolean;
    variables_applied: boolean;
    originality_pass: boolean;
    source_identity_leakage: boolean;
    source_dialogue_leakage: boolean;
    notes: string[];
  };
  seedance_asset_map?: {
    schema_version: 'seedance-assets.v1';
    bindings: SeedanceAssetBinding[];
    runs?: SeedanceRun[];
    full_run?: SeedanceFullRun;
    usage_note: string;
  };
}

export type CreativeDraftBeat = Omit<CreativeBeat, 'video_prompt'>;

export interface CreativeDraft {
  schema_version: 'creative-draft.v1';
  title: string;
  concept_summary: string;
  differentiation_log: string[];
  style_lock: CreativePack['style_lock'];
  beats: CreativeDraftBeat[];
  qa: CreativePack['qa'];
}

export type ProjectStage = 'analysis' | 'characters' | 'references' | 'output';

export interface SavedVideoProject {
  id: string;
  title: string;
  sourceName: string;
  createdAt: string;
  updatedAt: string;
  stage: ProjectStage;
  analysis: VideoDnaAnalysis;
  brief: RemixBrief;
  proposals: CharacterProposals | null;
  selections: Record<string, string>;
  referenceAssets: ReferenceAsset[];
  creativePack: CreativePack | null;
  modelVersion: string;
  usage: UsageStats;
}

export interface SavedVideoProjectSummary {
  id: string;
  title: string;
  sourceName: string;
  createdAt: string;
  updatedAt: string;
  stage: ProjectStage;
  durationSeconds: number;
  aspectRatio: string;
}

export const DEFAULT_SETTINGS: AnalysisSettings = {
  model: 'gemini-3.7-flash',
  fps: 2,
  mediaResolution: 'high',
  transcribeDialogue: true,
};

export const DEFAULT_LOCKS: Record<DnaLockKey, boolean> = {
  pacing: true,
  camera: true,
  lighting: true,
  performance: true,
  sound: true,
  narrative: true,
};
