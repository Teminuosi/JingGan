// Shot DNA —— 全管线的唯一真相源。
//
// 规格第五章：关键帧、Blender、视频提示词、质检，四条下游都只读这一份数据，
// 谁都不许自己去解析原始分析文本。所以这里的字段必须「可判定」——
// 能被程序比较、能被质检对照，而不是一堆散文。
//
// 与老项目的关系：`video-dna.v1` 的 VideoBeat 是分析层的产物（证据层），
// ShotDna 是执行层的产物。build.ts 负责从前者投影出后者，旧项目不重跑也能升级。

/** 景别。用固定枚举而不是自由文本，质检才能判断「模型给的景别对不对」。 */
export const SHOT_SIZES = ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS', 'unknown'] as const;
export type ShotSize = typeof SHOT_SIZES[number];

export const CAMERA_ANGLES = ['eye_level', 'high', 'low', 'overhead', 'dutch', 'over_shoulder', 'pov', 'unknown'] as const;
export type CameraAngle = typeof CAMERA_ANGLES[number];

export const CAMERA_MOVEMENTS = ['static', 'pan', 'tilt', 'dolly_in', 'dolly_out', 'truck', 'crane', 'handheld', 'zoom', 'orbit', 'unknown'] as const;
export type CameraMovement = typeof CAMERA_MOVEMENTS[number];

/**
 * 运动方向。180 度轴线规则要靠它来判：
 * 同一场戏里角色的运动方向突然反转，观众会以为换了地方。
 */
export const SCREEN_DIRECTIONS = ['left_to_right', 'right_to_left', 'toward_camera', 'away_from_camera', 'static', 'unknown'] as const;
export type ScreenDirection = typeof SCREEN_DIRECTIONS[number];

export const SCREEN_POSITIONS = ['left', 'center_left', 'center', 'center_right', 'right', 'offscreen'] as const;
export type ScreenPosition = typeof SCREEN_POSITIONS[number];

export const DEPTH_LAYERS = ['foreground', 'midground', 'background'] as const;
export type DepthLayer = typeof DEPTH_LAYERS[number];

export interface ShotCamera {
  shot_size: ShotSize;
  angle: CameraAngle;
  movement: CameraMovement;
  /** 运动的具体描述，给视频模型看的自然语言补充。 */
  movement_detail: string;
  /** 等效焦距，Blender 建场景时直接用。不知道就留空，不要编。 */
  lens_mm?: number;
  depth_of_field: 'shallow' | 'medium' | 'deep' | 'unknown';
  /** 主体距离（米）。Blender 摆机位要用。 */
  subject_distance_m?: number;
  screen_direction: ScreenDirection;
  composition_notes: string;
}

export interface ShotActor {
  character_id: string;
  role_in_shot: string;
  screen_position: ScreenPosition;
  depth_layer: DepthLayer;
  /** 朝向：面对镜头 / 侧身向左 / 背对……质检判「人物是不是转错身」用。 */
  facing: string;
  wardrobe: string;
  props_held: string[];
  /**
   * 入画/出画秒数（相对本镜开头）。
   * 规格第十七章的 pop-in 检测完全依赖这两个字段：
   * 一个角色如果不是从第 0 秒就在画面里，提示词必须显式写明他怎么进来的，
   * 否则视频模型会让他凭空出现。
   */
  entry_at?: number;
  exit_at?: number;
}

export interface ShotObject {
  object_id: string;
  name: string;
  screen_position: ScreenPosition;
  depth_layer: DepthLayer;
  /** 这件道具在本镜里状态有没有变（被拿起、被打翻）。跨镜连续性靠它。 */
  state: string;
  persistent: boolean;
}

export interface ShotEnvironment {
  location_id: string;
  location: string;
  /** 室内/室外，Blender 打光和视频模型的氛围词都看它。 */
  interior_exterior: 'interior' | 'exterior' | 'mixed' | 'unknown';
  time_of_day: string;
  weather: string;
  set_dressing: string[];
}

export interface ShotLighting {
  key_light: string;
  fill: string;
  practicals: string[];
  mood: string;
  color_temperature: string;
  /** 主光方向，Blender 直接照着摆灯。 */
  direction: string;
}

/** 一镜内部的一拍交锋。与老项目的 ActionBeat 同源，秒数改成相对本镜开头。 */
export interface ActionFrame {
  at: number;
  actor_ids: string[];
  action: string;
  toward_ids?: string[];
  reaction?: string;
  consequence?: string;
  intensity?: 'low' | 'medium' | 'high';
}

export interface ExpressionFrame {
  at: number;
  character_id: string;
  expression: string;
  /** 视线指向谁或哪。丢了它，因果链就断了——这是老项目栽过的那个坑。 */
  gaze?: string;
  intensity?: 'subtle' | 'moderate' | 'strong';
}

export interface ShotContinuity {
  /** 承接上一镜的什么：位置、手里的东西、情绪。 */
  from_previous: string;
  /** 交给下一镜什么。 */
  to_next: string;
  /** 本镜结束时每个角色的服装状态，键是 character_id。跨镜比对就靠它。 */
  wardrobe_state: Record<string, string>;
  /** 本镜结束时道具在谁手里 / 在哪。 */
  prop_state: Record<string, string>;
  /** 本镜结束时角色的屏幕位置，下一镜跳变太大要报。 */
  position_state: Record<string, ScreenPosition>;
}

export interface ShotVisualStyle {
  medium: string;
  palette: string[];
  texture: string;
  grade: string;
  atmosphere: string;
}

/** 复杂度评分。P1 的 Blender 路由读它，这里先把结构定下来。 */
export interface ShotComplexity {
  score: number;
  factors: Record<string, number>;
  needs_blender: boolean;
  reasons: string[];
  /**
   * 3D 预演算出的空间关系。出片时由 Prompt Compiler 读走写进提示词——
   * 这是 Blender 对成片的唯一实质贡献，渲染图只是附带。
   * 存在 Shot DNA 里而不是任务输出里，是为了不再开一条「从 blender 任务读 output」的旁路：
   * 真相源只能有一个，多一条路就多一处会漏。
   */
  previs?: { blocking: string; camera_path: string; rendered_at: number; reviewed_revision?: number };
}

export interface ShotDna {
  schema_version: 'shot-dna.v1';
  shot_id: string;
  project_id: string;
  idx: number;
  /** 相对整片的绝对秒数，与源片时间轴对齐。 */
  start_time: number;
  end_time: number;
  scene_id: string;
  narrative_function: string;
  /** 整镜概括。细节在 action_timeline 里，这一行只用于人读和兜底。 */
  summary: string;
  camera: ShotCamera;
  actors: ShotActor[];
  objects: ShotObject[];
  environment: ShotEnvironment;
  lighting: ShotLighting;
  action_timeline: ActionFrame[];
  expression_timeline: ExpressionFrame[];
  continuity: ShotContinuity;
  visual_style: ShotVisualStyle;
  complexity: ShotComplexity;
  dialogue: { speaker_id: string; text: string; delivery: string };
  sound: string;
  transition_in: string;
  /** 人工修正标记。沿用老项目的做法：改过就永远带着，导出的 JSON 里也看得见。 */
  corrected_by_user: boolean;
  revision: number;
}

export const SHOT_DNA_VERSION = 'shot-dna.v1' as const;

export function shotDuration(dna: Pick<ShotDna, 'start_time' | 'end_time'>): number {
  return +(dna.end_time - dna.start_time).toFixed(3);
}

/** 本镜里所有出现过的角色（含只在时间轴里露过面的），供连续性引擎和提示词用。 */
export function shotCharacterIds(dna: ShotDna): string[] {
  const ids = new Set<string>(dna.actors.map((a) => a.character_id));
  for (const frame of dna.action_timeline) {
    frame.actor_ids.forEach((id) => ids.add(id));
    (frame.toward_ids ?? []).forEach((id) => ids.add(id));
  }
  for (const frame of dna.expression_timeline) ids.add(frame.character_id);
  return [...ids].filter(Boolean);
}
