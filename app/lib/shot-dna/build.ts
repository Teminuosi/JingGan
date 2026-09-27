// 从老项目的 video-dna.v1 投影出 Shot DNA。
//
// 为什么要这一层：现有 5 个项目的分析结果都是 video-dna.v1。
// 如果 Shot DNA 只能靠重新分析产出，那老项目要享受新管线就得每条再花 4 万 token 重跑一遍。
// 投影是本地免费的——能从旧数据推出来的字段就推，推不出来的老老实实留空，
// 绝不拿默认值假装有数据（那会让质检把编出来的景别当成真值去比对）。
//
// 投影是有损的：旧分析没有屏幕位置、没有入画时机、没有焦距。
// 这些字段留空后，validateShotDna 会报 warning，后台能看见「哪些镜需要补」。

import type { BeatActorBlocking, BeatBlocking, CreativeBeat, DialogueAnalysis, VideoBeat, VideoDnaAnalysis } from '../types';
import {
  SHOT_DNA_VERSION,
  type ActionFrame, type CameraAngle, type CameraMovement, type ExpressionFrame,
  type ScreenDirection, type ShotDna, type ShotSize,
} from './types';

/** 中英混写的景别说法都要能认出来。认不出就是 unknown，不猜。 */
const SIZE_PATTERNS: Array<[RegExp, ShotSize]> = [
  [/极特写|大特写|extreme close|\bECU\b/i, 'ECU'],
  [/特写|close[- ]?up|\bCU\b/i, 'CU'],
  [/近景|medium close|\bMCU\b/i, 'MCU'],
  [/中全景|medium long|\bMLS\b/i, 'MLS'],
  [/中景|medium shot|\bMS\b/i, 'MS'],
  [/大远景|极远景|extreme (long|wide)|\bELS\b/i, 'ELS'],
  [/全景|远景|long shot|wide shot|\bLS\b/i, 'LS'],
];

const ANGLE_PATTERNS: Array<[RegExp, CameraAngle]> = [
  [/过肩|over[- ]?shoulder/i, 'over_shoulder'],
  [/主观|第一人称|\bPOV\b/i, 'pov'],
  [/顶拍|俯视|overhead|top[- ]?down|bird/i, 'overhead'],
  [/俯拍|高机位|high angle/i, 'high'],
  [/仰拍|低机位|low angle/i, 'low'],
  [/斜角|荷兰角|dutch/i, 'dutch'],
  [/平视|水平|eye[- ]?level/i, 'eye_level'],
];

const MOVE_PATTERNS: Array<[RegExp, CameraMovement]> = [
  [/推近|推镜|dolly in|push in/i, 'dolly_in'],
  [/拉远|拉镜|dolly out|pull (out|back)/i, 'dolly_out'],
  [/环绕|orbit|arc/i, 'orbit'],
  [/横移|平移|truck|track/i, 'truck'],
  [/摇臂|升降|crane|jib/i, 'crane'],
  [/手持|晃动|handheld|shaky/i, 'handheld'],
  [/变焦|zoom/i, 'zoom'],
  [/摇摄|左右摇|\bpan\b/i, 'pan'],
  [/俯仰|上下摇|\btilt\b/i, 'tilt'],
  [/固定|静止|不动|static|locked|fixed/i, 'static'],
];

const DIRECTION_PATTERNS: Array<[RegExp, ScreenDirection]> = [
  [/从左(向|到|往)右|左往右|left to right/i, 'left_to_right'],
  [/从右(向|到|往)左|右往左|right to left/i, 'right_to_left'],
  [/走向镜头|冲向镜头|靠近镜头|toward camera/i, 'toward_camera'],
  [/远离镜头|背向镜头|away from camera/i, 'away_from_camera'],
];

function match<T>(patterns: Array<[RegExp, T]>, text: string, fallback: T): T {
  for (const [re, value] of patterns) if (re.test(text)) return value;
  return fallback;
}

function depthOfField(text: string): ShotDna['camera']['depth_of_field'] {
  if (/浅景深|虚化|散景|bokeh|shallow/i.test(text)) return 'shallow';
  if (/深景深|全清晰|deep focus/i.test(text)) return 'deep';
  if (/中景深|medium (depth|focus)/i.test(text)) return 'medium';
  return 'unknown';
}

function interiorExterior(text: string): ShotDna['environment']['interior_exterior'] {
  const inside = /室内|屋内|房间|办公室|车内|indoor|interior|\bINT\b/i.test(text);
  const outside = /室外|户外|街道|野外|天台|indoors?|outdoor|exterior|\bEXT\b/i.test(text);
  if (inside && outside) return 'mixed';
  if (inside) return 'interior';
  if (outside) return 'exterior';
  return 'unknown';
}

/** 从描述里抠出时间：分析里常写「黄昏，光线渐暗」。抠不出就留空。 */
function timeOfDay(text: string): string {
  const m = text.match(/清晨|早晨|上午|正午|中午|下午|黄昏|傍晚|日落|夜晚|深夜|凌晨|dawn|morning|noon|afternoon|dusk|sunset|night|midnight/i);
  return m?.[0] ?? '';
}

export interface BuildShotDnaOptions {
  projectId: string;
  /** 缺省用 beat_id；有真实 shots 行时传进来。 */
  shotId?: string;
  idx: number;
  sceneId?: string;
  /**
   * 角色 ID 映射。源分析里是 ROLE_*，创作层换成 CHAR_*。
   * 不传就原样保留 —— 分析阶段的 Shot DNA 用 ROLE_*，投影后的用 CHAR_*，两种都合法。
   */
  mapCharacterId?: (roleId: string) => string;
}

type AnyBeat = VideoBeat | CreativeBeat;
type LooseBeat = Partial<VideoBeat> & Partial<CreativeBeat>;

/** 从 blocking 里找某个角色的站位。id 可能已经被映射成 CHAR_*，两种写法都要能匹配上。 */
function blockingOf(
  blocking: BeatBlocking | undefined,
  mappedId: string,
  mapId: (id: string) => string,
): BeatActorBlocking | undefined {
  return blocking?.actors?.find((a) => mapId(a.role_id) === mappedId || a.role_id === mappedId);
}

function beatText(beat: AnyBeat): string {
  const v = beat as LooseBeat;
  return [v.visual_action, v.action, v.framing, v.camera_motion, v.composition,
    v.environment, v.continuity_in, v.continuity_out, v.continuity].filter(Boolean).join(' ');
}

/**
 * 投影一个 beat 成 Shot DNA。
 * 同时吃 VideoBeat（分析层）和 CreativeBeat（创作层）——两者字段高度重合，
 * 分开写两份只会让它们慢慢跑偏。
 */
export function buildShotDna(beat: AnyBeat, analysis: VideoDnaAnalysis, opts: BuildShotDnaOptions): ShotDna {
  const v = beat as LooseBeat;
  const mapId = opts.mapCharacterId ?? ((id: string) => id);
  const text = beatText(beat);
  const start = beat.start_seconds;

  const characterIds = (v.role_ids ?? v.character_ids ?? []).map(mapId);
  const style = analysis.style_dna;

  // 秒数从「相对整片」换算成「相对本镜」：下游（Blender 时间轴、视频模型的分镜表）
  // 都以镜头自己的 0 点为基准，混用两套基准是最容易出错的地方。
  const actionTimeline: ActionFrame[] = (v.action_beats ?? []).map((step) => ({
    at: +Math.max(0, step.at_seconds - start).toFixed(3),
    actor_ids: step.actor_ids.map(mapId),
    action: step.action,
    toward_ids: step.toward_ids?.map(mapId),
    reaction: step.reaction,
    consequence: step.consequence,
  }));

  // 表情/视线时间轴：旧分析没有独立字段，但逐拍动作里的 reaction 往往就是表情反应。
  // 能推出来的推出来，推不出来不编。
  const expressionTimeline: ExpressionFrame[] = (v.action_beats ?? [])
    .filter((step) => Boolean(step.reaction?.trim()) && Boolean(step.toward_ids?.length))
    .flatMap((step) => (step.toward_ids ?? []).map((id) => ({
      at: +Math.max(0, step.at_seconds - start).toFixed(3),
      character_id: mapId(id),
      expression: step.reaction ?? '',
      gaze: step.actor_ids.map(mapId).join('、'),
    })));

  // dialogue 在两层的形状不同：分析层是结构体，创作层是一行字符串。
  // 两个 Partial 相交后 TS 会把它算成 never，所以这里显式还原成联合类型。
  const dialogue = v.dialogue as DialogueAnalysis | string | undefined;
  const structured = typeof dialogue === 'string' ? undefined : dialogue;
  const dialogueText = typeof dialogue === 'string' ? dialogue : (structured?.source_text ?? '');
  const dialogueSpeaker = typeof dialogue === 'string'
    ? (v.dialogue_speaker_ids ?? []).map(mapId)[0] ?? ''
    : mapId(structured?.speaker_role ?? '');

  return {
    schema_version: SHOT_DNA_VERSION,
    shot_id: opts.shotId ?? beat.beat_id,
    project_id: opts.projectId,
    idx: opts.idx,
    start_time: start,
    end_time: beat.end_seconds,
    scene_id: opts.sceneId ?? '',
    narrative_function: v.narrative_function ?? v.story_function ?? '',
    summary: v.visual_action ?? v.action ?? '',
    camera: {
      // blocking.camera 是模型直接给的枚举，比从散文里猜可靠得多；没有才退回文本匹配。
      shot_size: v.blocking?.camera?.shot_size
        ?? match(SIZE_PATTERNS, `${v.framing ?? ''} ${v.composition ?? ''}`, 'unknown'),
      angle: v.blocking?.camera?.angle
        ?? match(ANGLE_PATTERNS, `${v.framing ?? ''} ${v.composition ?? ''} ${v.camera_motion ?? ''}`, 'unknown'),
      movement: v.blocking?.camera?.movement
        ?? match(MOVE_PATTERNS, v.camera_motion ?? '', 'unknown'),
      movement_detail: v.camera_motion ?? '',
      // 焦距和主体距离旧分析里没有，留空。Blender 用得到，
      // 但编一个假值比留空危险得多：留空能被看见，假值会被当成真值用。
      depth_of_field: depthOfField(`${v.composition ?? ''} ${v.framing ?? ''}`),
      screen_direction: v.blocking?.camera?.screen_direction
        ?? match(DIRECTION_PATTERNS, text, 'unknown'),
      subject_distance_m: v.blocking?.camera?.subject_distance_m,
      composition_notes: [v.framing, v.composition].filter(Boolean).join('\n'),
    },
    // 有 blocking 就用真实空间数据；没有（旧 DNA）才退回全部居中。
    // 这两条路的差别是决定性的：没有位置数据时 3D 预演会把所有人摆在原点，
    // 渲出来是几个叠在一起的柱子，喂给视频模型的空间描述还会写成「相距 0.0 米」。
    actors: characterIds.map((id) => {
      const b = blockingOf(v.blocking, id, mapId);
      return {
        character_id: id,
        role_in_shot: b?.entry_at !== undefined ? '中途入画' : '',
        screen_position: b?.screen_position ?? 'center',
        depth_layer: b?.depth_layer ?? 'midground',
        facing: b?.facing ?? '',
        wardrobe: '',
        props_held: [],
        // 秒数换算成相对本镜开头，与 action_timeline 同一个基准
        ...(b?.entry_at !== undefined ? { entry_at: +Math.max(0, b.entry_at - start).toFixed(3) } : {}),
        ...(b?.exit_at !== undefined ? { exit_at: +Math.max(0, b.exit_at - start).toFixed(3) } : {}),
      };
    }),
    objects: (v.props ?? []).map((name, i) => ({
      object_id: `OBJ_${i + 1}`,
      name,
      screen_position: 'center' as const,
      depth_layer: 'midground' as const,
      state: '',
      persistent: false,
    })),
    environment: {
      location_id: '',
      location: v.environment ?? '',
      interior_exterior: interiorExterior(`${v.environment ?? ''} ${text}`),
      time_of_day: timeOfDay(`${v.environment ?? ''} ${v.lighting ?? ''} ${text}`),
      weather: '',
      set_dressing: v.props ?? [],
    },
    lighting: {
      key_light: v.lighting ?? '',
      fill: '',
      practicals: [],
      mood: style?.visual?.atmosphere ?? '',
      color_temperature: '',
      direction: '',
    },
    action_timeline: actionTimeline,
    expression_timeline: expressionTimeline,
    continuity: {
      from_previous: v.continuity_in ?? '',
      to_next: v.continuity_out ?? v.continuity ?? '',
      // 服装/道具/位置状态旧分析没有逐镜记录。留空，由后台补或重新分析产出。
      wardrobe_state: {},
      prop_state: {},
      position_state: {},
    },
    visual_style: {
      medium: style?.visual?.medium ?? '',
      palette: style?.visual?.palette ?? [],
      texture: (style?.visual?.textures ?? []).join('、'),
      grade: v.color ?? '',
      atmosphere: style?.visual?.atmosphere ?? '',
    },
    complexity: { score: 0, factors: {}, needs_blender: false, reasons: [] },
    dialogue: {
      speaker_id: dialogueSpeaker,
      text: dialogueText,
      delivery: structured?.delivery ?? '',
    },
    sound: v.sound ?? '',
    transition_in: v.transition_in ?? '',
    corrected_by_user: Boolean(v.corrected_by_user),
    revision: 1,
  };
}

/** 投影整条分析。序号即数组下标，时间轴顺序由上游保证。 */
export function buildShotDnaList(analysis: VideoDnaAnalysis, projectId: string, opts?: Partial<BuildShotDnaOptions>): ShotDna[] {
  return analysis.beats.map((beat, idx) => buildShotDna(beat, analysis, { projectId, idx, ...opts }));
}
