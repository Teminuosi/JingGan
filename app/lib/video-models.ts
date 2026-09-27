// HeyRoute 视频模型能力表。
// 数据来自官方文档 /help?collection=models-capabilities&page=video-model 的逐档参数表（2026-09-09 逐个核对）。
// 模型列表仍然按 Key 从 /v1/models 拉取（分组由 Key 决定）；这里只记录“这一档收哪些参数、上限是多少”，
// 因为 /v1/models 只返回模型名，不返回能力。拉到列表里但这里没登记的模型按最保守的能力处理。

export type VideoResolution = '480p' | '720p' | '1080p';

/**
 * 这一条参数的说法从哪来。界面上必须逐项显示，否则用户没法分辨
 * 「这个值是真的试过」和「这个值是照文档抄的」——两者出错时的处理方式完全不同。
 * 'verified'   本机真发过请求、被上游的返回证实过；
 * 'documented' 中转官方参数表这么写，但本机没实测；
 * 'assumed'    文档没写清或自相矛盾，这里是保守推断，不保证正确。
 */
export type ParamSource = 'verified' | 'documented' | 'assumed';

export const PARAM_SOURCE_LABEL: Record<ParamSource, string> = {
  verified: '实测',
  documented: '据文档',
  assumed: '未验证',
};
export const PARAM_SOURCE_HINT: Record<ParamSource, string> = {
  verified: '本机真发过请求，上游的返回证实了这一条。',
  documented: '中转官方参数表这么写，本机还没实测过。用「探测真实限制」可以验证。',
  assumed: '文档没写清楚或自相矛盾，这是保守推断，可能不对。撞上报错请反馈。',
};
export type ReferenceStyle =
  | 'none'            // 不收任何参考素材
  | 'single'          // 只收一个参考素材，传数组直接报错
  | 'first_frame'     // 收一个图片链接：第一张当首帧，其余当参考，不做按序转场
  | 'ordered_list'    // 收数组，按顺序依次转场
  | 'omni';           // 数组按序转场，另外还支持 images/videos/audios 三类 reference_* 素材

export interface VideoModelCapability {
  id: string;
  label: string;
  /** 固定时长的档位（seedance-2.0 只出 15 秒）；有值时 seconds 不能传别的。 */
  fixedSeconds?: number;
  /** 只接受这几个离散值（grok-video 只有 6/10/15，且必须显式传）。 */
  allowedSeconds?: number[];
  minSeconds?: number;
  maxSeconds: number;
  /** 省略 seconds 时上游按几秒出片；undefined 表示必须显式传。 */
  defaultSeconds?: number;
  /**
   * 传这个值表示"时长交给模型自己定"。MiniMax-H3 的上游报错里写明了这一条：
   * `duration must be between 4 and 15, or -1 to let the model choose`。
   * 代价是出多长事先不知道，估价只能按上限算。
   */
  autoSeconds?: number;
  /** 空数组表示这一档不认 resolution（画质写在模型名里）。 */
  resolutions: VideoResolution[];
  defaultResolution?: VideoResolution;
  ratios: string[];
  /** ratio 传了也不被上游兑现（minimax-h3-* 实测固定画幅）。 */
  ratioHonored: boolean;
  referenceStyle: ReferenceStyle;
  maxReferenceImages: number;
  maxReferenceVideos: number;
  maxReferenceAudios: number;
  /** 图片+视频+音频合计上限；seedance-2.0 是一起算 15，minimax-h3-original-* 是一次只收一个素材。 */
  maxReferenceTotal?: number;
  /**
   * 参考素材接受什么形式的地址。角色图存在本机 /api/assets，上游访问不到，
   * 只有能收 base64 data URI 的档才用得上；只收链接的档必须先把图放到公网 https。
   * 'verified' = 上游自己的报错里写明收 data: URI（实测）；'documented' = 文档明写支持；
   * 'url-only' = 已被上游明确拒绝 data URI；'unverified' = 文档没写、也还没实测。
   */
  referenceUri: 'verified' | 'documented' | 'url-only' | 'unverified';
  /** 首帧/尾帧与 reference_* 素材不能混着传，一次请求只能是其中一种。 */
  exclusiveReferenceScenes?: boolean;
  supportsEditExtend: boolean;
  supportsShots: boolean;
  supportsNegativePrompt: boolean;
  supportsGenerateAudio: boolean;
  /** 不传 generate_audio 时上游怎么处理：'on' 默认出声、'off' 默认哑片、'upstream' 用上游自己的默认、'none' 不认这个字段。 */
  audioDefault: 'on' | 'off' | 'upstream' | 'none';
  /**
   * seed 各档规则完全不同，不能一概而论：
   * 'rejected' 传了会被上游拒（grok 两档）、'none' 不认这个字段、
   * 'int' 整数且 -1 表示随机（2.5）、'range' 有取值区间且不接受 -1（2.0 两档）、
   * 'forwarded' 会转发但是否生效未经证实（minimax 各档）。
   */
  seed: 'rejected' | 'none' | 'int' | 'range' | 'forwarded';
  seedRange?: [number, number];
  /** 是否认 size（宽x高）；与 ratio 同时传时以 ratio 为准。 */
  supportsSize: boolean;
  /** 认 output_format 的档（只有 2.5 的编辑/延长写法用得上）。 */
  outputFormats?: string[];
  /** 站内积分单价。unit='second' 时是每秒，unit='clip' 时是每条固定时长。 */
  price: { unit: 'second' | 'clip'; credits: Partial<Record<VideoResolution, number>> & { flat?: number } };
  /**
   * 这一档各个参数的说法来源，按参数键登记。没登记的按 sourceDefault 处理。
   * 只有真发过请求被返回证实的才能写 'verified'——照文档抄的一律 'documented'，
   * 自己推断的一律 'assumed'。宁可标得保守，也不许把没试过的说成试过。
   */
  sources?: Partial<Record<string, ParamSource>>;
  /** 没单独登记的参数默认算什么来源。整张表是照官方参数表录的，所以默认 'documented'。 */
  sourceDefault?: ParamSource;
  notes: string[];
}

/** 这一档在某个参数上的说法来源。 */
export function paramSource(model: VideoModelCapability, key: string): ParamSource {
  return model.sources?.[key] ?? model.sourceDefault ?? 'documented';
}

const GROK_RATIOS = ['auto', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'];
// 'adaptive' 是探测时上游自己报出来的合法值（"expected one of 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / adaptive"），
// 原来照文档抄的这张表漏了它。'auto' 不在上游那份清单里，但实测能过校验，所以保留。
const WIDE_RATIOS = ['auto', 'adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const MINIMAX_RATIOS = ['auto', '21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'];

export const VIDEO_MODELS: VideoModelCapability[] = [
  {
    id: 'seedance-2.5',
    label: 'seedance-2.5 · 30张图 · 30秒 · 全能档',
    minSeconds: 4, maxSeconds: 30, defaultSeconds: 4,
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p',
    ratios: WIDE_RATIOS, ratioHonored: true,
    // 实测：上游报错原话 `reference #1: must be an http(s) URL or a "data:" URI`，收 base64。
    referenceUri: 'verified',
    seed: 'int', supportsSize: true, outputFormats: ['mp4', 'mov'],
    referenceStyle: 'omni',
    maxReferenceImages: 30, maxReferenceVideos: 10, maxReferenceAudios: 10,
    audioDefault: 'on',
    supportsEditExtend: true, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: true,
    price: { unit: 'second', credits: { '480p': 4.59, '720p': 7.65, '1080p': 19.89 } },
    // 收不收 base64 已实测（见 referenceUri），但 30 张这个上限仍然只有文档背书。
    sources: { reference_images: 'documented' },
    notes: [
      '全站唯一支持对已有视频做编辑（edit）和延长（extend）的一档。',
      '时长上限最高（30 秒）、参考图上限最高（30 张）；单价也是全站最高。',
      '480p 比 720p 便宜 40%，1080p 是 720p 的 2.6 倍；三档背后是不同供给线。',
      '编辑与延长模式的画幅跟随源视频，一律按 720p 单价计费。',
    ],
  },
  {
    id: 'seedance-2.0',
    label: 'seedance-2.0 · 15张图 · 固定15秒',
    fixedSeconds: 15, maxSeconds: 15,
    resolutions: ['480p', '720p'], defaultResolution: '480p',
    ratios: WIDE_RATIOS, ratioHonored: true,
    referenceUri: 'documented',
    seed: 'range', seedRange: [0, 2147483647], supportsSize: true,
    referenceStyle: 'ordered_list',
    maxReferenceImages: 15, maxReferenceVideos: 15, maxReferenceAudios: 15, maxReferenceTotal: 15,
    audioDefault: 'off',
    supportsEditExtend: false, supportsShots: true, supportsNegativePrompt: true, supportsGenerateAudio: true,
    price: { unit: 'clip', credits: { flat: 22.5 } },
    notes: [
      '只出 15 秒，写别的 seconds 会被拒；不足 15 秒的段落也按整条计费。',
      '只有 2.0 两档支持 shots 分镜表和 negative_prompt。',
      'shots 每段是 {"prompt","duration"}，2–15 段，所有 duration 之和必须正好 15。',
      '参考素材图片、视频、音频合计最多 15 个（不是各 15 个），链接必须是 https 或 base64 data URI，明文 http 会被拒。',
      '480p 与 720p 同价。generate_audio 默认关——不显式传 true 就是哑片，本页一律显式传。',
    ],
  },
  {
    id: 'seedance-2.0-fast',
    label: 'seedance-2.0-fast · 15张图 · 固定15秒',
    fixedSeconds: 15, maxSeconds: 15,
    resolutions: ['480p', '720p'], defaultResolution: '480p',
    ratios: WIDE_RATIOS, ratioHonored: true,
    referenceUri: 'documented',
    seed: 'range', seedRange: [0, 2147483647], supportsSize: true,
    referenceStyle: 'ordered_list',
    maxReferenceImages: 15, maxReferenceVideos: 15, maxReferenceAudios: 15, maxReferenceTotal: 15,
    audioDefault: 'off',
    supportsEditExtend: false, supportsShots: true, supportsNegativePrompt: true, supportsGenerateAudio: true,
    price: { unit: 'clip', credits: { flat: 22.5 } },
    notes: ['与 seedance-2.0 同价同参数，出片更快。'],
  },
  {
    id: 'MiniMax-H3',
    label: 'MiniMax-H3 · 9张参考图 · 出片快',
    minSeconds: 4, maxSeconds: 15, defaultSeconds: 4, autoSeconds: -1,
    // 1080p 是探测时上游自己说的（"expected one of 480p / 720p / 1080p"），文档的价格表只列了 480p/720p。
    // 能选，但中转没登记它的单价，所以估不出积分——这一点在提交前会明确警告，而不是悄悄按 0 算。
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '480p',
    ratios: WIDE_RATIOS, ratioHonored: true,
    // 实测：上游报错原话 `image #1: url must be an http(s) URL or a "data:" URI`，收 base64。
    referenceUri: 'verified',
    seed: 'forwarded', supportsSize: true,
    referenceStyle: 'ordered_list',
    maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
    exclusiveReferenceScenes: true,
    audioDefault: 'upstream',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: true,
    price: { unit: 'second', credits: { '480p': 0.75, '720p': 1.275 } },
    sources: { reference_images: 'documented' },
    notes: [
      '参考图最多 9 张、支持首帧/尾帧；出片比四个 minimax-h3-* 快得多。',
      '1080p 上游校验能过，但中转价格表只登记了 480p / 720p 的单价，选它估不出积分，实际扣多少要自己看使用日志。',
      '首帧/尾帧与 reference_* 素材不能混着传，一次请求只能是其中一种；音频不能单独用。',
      '注意：它与名字相似的四个 minimax-h3-* 是两家完全不同的上游——那四档一次只收 1 张参考图、出片要十几分钟、且只收 http/https 链接。别选错。',
    ],
  },
  {
    id: 'grok-imagine-video',
    label: 'grok-imagine-video · 仅1张图 · 便宜',
    minSeconds: 1, maxSeconds: 15, defaultSeconds: 8,
    resolutions: ['480p', '720p'], defaultResolution: '480p',
    ratios: GROK_RATIOS, ratioHonored: true,
    referenceUri: 'documented',
    seed: 'rejected', supportsSize: true,
    referenceStyle: 'first_frame',
    maxReferenceImages: 1, maxReferenceVideos: 0, maxReferenceAudios: 0,
    audioDefault: 'on',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: true,
    price: { unit: 'second', credits: { '480p': 1.0, '720p': 1.4 } },
    // 参考图那一条文档自相矛盾（取值列写 1 个、说明列写多个），这里取保守的 1 张，属于推断不是文档。
    sources: { reference_images: 'assumed' },
    notes: [
      '时长 1–15 秒任意可调，默认带音轨；与 1.5 档是全站仅有的能出 1–3 秒短片的两档。',
      '参考图：文档取值列写「一个图片链接或 data URI」，说明列却写「第一张当首帧，其余当参考素材」，两者矛盾。这里按保守的 1 张处理，避免多传被拒；想试多张可以「复制 API 请求体」后自己改 input_reference 为数组。不收参考视频。',
      '写 1080p 会被压回 720p，要 1080p 换 grok-imagine-video-1.5。seed 传了会被拒。',
    ],
  },
  {
    id: 'grok-imagine-video-1.5',
    label: 'grok-imagine-video-1.5 · 仅1张图 · 能出1080p',
    minSeconds: 1, maxSeconds: 15, defaultSeconds: 8,
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '480p',
    ratios: GROK_RATIOS, ratioHonored: true,
    referenceUri: 'documented',
    seed: 'rejected', supportsSize: true,
    referenceStyle: 'first_frame',
    maxReferenceImages: 1, maxReferenceVideos: 0, maxReferenceAudios: 0,
    audioDefault: 'on',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: true,
    price: { unit: 'second', credits: { '480p': 1.5, '720p': 2.625, '1080p': 4.6875 } },
    // 与 grok-imagine-video 同一套参考图写法，文档同样自相矛盾，同样按保守的 1 张处理。
    sources: { reference_images: 'assumed' },
    notes: ['同样是 1080p，它只要 seedance-2.5 的四分之一价。seed 传了会被拒。'],
  },
  {
    id: 'grok-video',
    label: 'grok-video · 不收参考图 · 每秒最便宜',
    allowedSeconds: [6, 10, 15], maxSeconds: 15,
    resolutions: [], ratios: [], ratioHonored: false,
    referenceUri: 'url-only',
    seed: 'none', supportsSize: false,
    referenceStyle: 'none',
    maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0,
    audioDefault: 'none',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: false,
    price: { unit: 'second', credits: { flat: 0.2 } },
    notes: [
      '每秒单价最低，但只认 model / prompt / seconds 三个字段，其余一律不支持。',
      'seconds 必须显式传，且只能是 6 / 10 / 15。',
      '不收参考图——角色一致性只能靠文字描述，这一档不适合本项目的角色锁定流程。',
    ],
  },
  {
    id: 'minimax-h3-quantized-768p',
    label: 'minimax-h3 量化 768p · 仅1张图 · 最便宜但慢',
    minSeconds: 4, maxSeconds: 10, defaultSeconds: 4,
    resolutions: [], ratios: MINIMAX_RATIOS, ratioHonored: false,
    referenceUri: 'url-only',
    seed: 'forwarded', supportsSize: true,
    referenceStyle: 'single',
    maxReferenceImages: 1, maxReferenceVideos: 0, maxReferenceAudios: 0,
    audioDefault: 'none',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: false,
    price: { unit: 'second', credits: { flat: 0.28 } },
    // ratio 不兑现、参考素材只收 http/https 都是被上游的返回打回来才知道的，不是文档写的。
    sources: { ratio: 'verified', reference_images: 'verified' },
    notes: [
      '每秒最便宜的可调档，直接给 768p；代价是出片十几分钟、时长上限只有 10 秒。',
      '一次只收一个参考素材，传数组直接报错；且不收参考视频和参考音频。',
      '画质写在模型名里，resolution 传了要与模型名一致；ratio 上游不兑现。',
    ],
  },
  {
    id: 'minimax-h3-original-768p',
    label: 'minimax-h3 原版 768p · 仅1张图 · 慢十几分钟',
    minSeconds: 4, maxSeconds: 15, defaultSeconds: 4,
    resolutions: [], ratios: MINIMAX_RATIOS, ratioHonored: false,
    referenceUri: 'url-only',
    seed: 'forwarded', supportsSize: true,
    referenceStyle: 'single',
    maxReferenceImages: 1, maxReferenceVideos: 1, maxReferenceAudios: 1, maxReferenceTotal: 1,
    audioDefault: 'none',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: false,
    price: { unit: 'second', credits: { flat: 0.7 } },
    sources: { ratio: 'verified', reference_images: 'verified' },
    notes: ['出片十几分钟，一次只收一个参考素材（图/视频/音频三选一）。ratio 上游不兑现。'],
  },
  {
    id: 'minimax-h3-original-1080p',
    label: 'minimax-h3 原版 1080p · 仅1张图 · 慢十几分钟',
    minSeconds: 4, maxSeconds: 15, defaultSeconds: 4,
    resolutions: [], ratios: MINIMAX_RATIOS, ratioHonored: false,
    referenceUri: 'url-only',
    seed: 'forwarded', supportsSize: true,
    referenceStyle: 'single',
    maxReferenceImages: 1, maxReferenceVideos: 1, maxReferenceAudios: 1, maxReferenceTotal: 1,
    audioDefault: 'none',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: false,
    price: { unit: 'second', credits: { flat: 1.05 } },
    sources: { ratio: 'verified', reference_images: 'verified' },
    notes: ['固定画幅，传 ratio 改不了。出片十几分钟，一次只收一个参考素材。'],
  },
  {
    id: 'minimax-h3-original-cf-2k',
    label: 'minimax-h3 原版 2K · 仅1张图 · 慢十几分钟',
    minSeconds: 4, maxSeconds: 15, defaultSeconds: 4,
    resolutions: [], ratios: MINIMAX_RATIOS, ratioHonored: false,
    referenceUri: 'url-only',
    seed: 'forwarded', supportsSize: true,
    referenceStyle: 'single',
    maxReferenceImages: 1, maxReferenceVideos: 1, maxReferenceAudios: 1, maxReferenceTotal: 1,
    audioDefault: 'none',
    supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: false,
    price: { unit: 'second', credits: { flat: 1.05 } },
    sources: { ratio: 'verified', reference_images: 'verified' },
    notes: ['2K，与 1080p 档同价。出片十几分钟，一次只收一个参考素材。'],
  },
];

/** 拉到列表里但没登记的模型按最保守能力处理：不敢假设它收参考图或长时长。 */
export const UNKNOWN_VIDEO_MODEL = (id: string): VideoModelCapability => ({
  id,
  label: `${id}（未登记能力）`,
  minSeconds: 4, maxSeconds: 15, defaultSeconds: 4,
  resolutions: [], ratios: [], ratioHonored: false,
  referenceUri: 'unverified',
  audioDefault: 'none',
  seed: 'none',
  supportsSize: false,
  referenceStyle: 'none',
  maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0,
  supportsEditExtend: false, supportsShots: false, supportsNegativePrompt: false, supportsGenerateAudio: false,
  price: { unit: 'second', credits: {} },
  // 这一档根本没登记过，所有数字都是兜底猜的，一项也不许显示成"据文档"。
  sourceDefault: 'assumed',
  notes: ['本地没有登记这一档的能力，按最保守方式处理：只发文字，不带参考图，不估价。请对照官方参数表确认。'],
});

export function videoModel(id: string): VideoModelCapability {
  return VIDEO_MODELS.find((model) => model.id === id) ?? UNKNOWN_VIDEO_MODEL(id);
}

export function creditsPerSecond(model: VideoModelCapability, resolution?: VideoResolution): number | undefined {
  const table = model.price.credits;
  if (typeof table.flat === 'number') return table.flat;
  const key = resolution ?? model.defaultResolution;
  return key ? table[key] : undefined;
}

/** 估算一段的积分。固定时长档不足也按整条算。 */
export function estimateCredits(model: VideoModelCapability, seconds: number, resolution?: VideoResolution): number | undefined {
  if (model.price.unit === 'clip') return model.price.credits.flat;
  const rate = creditsPerSecond(model, resolution);
  if (rate === undefined) return undefined;
  const billed = model.fixedSeconds ?? seconds;
  return Number((rate * billed).toFixed(2));
}

export interface SecondsPlan {
  /** 实际提交的秒数；固定时长档为 undefined（不能传 seconds）。 */
  seconds?: number;
  /** 计费按几秒算，用于估价。 */
  billedSeconds: number;
  /** 比设计时长多出的秒数，需要在剪辑时裁掉。 */
  padded: number;
  /** 比设计时长少的秒数：手填时长比这一段的内容短时，后半段演不完。 */
  short?: number;
  blocked?: string;
}

/**
 * 段落时长和这一档的可选时长几乎不会正好相等，所以要有明确的取舍规则，而不是一律拦下：
 * - 短于下限：向上垫到下限（差零点几秒就拦掉太蠢），多出的部分剪辑时裁掉；
 * - 长于上限：这是真的装不下，只能拦，由调用方给出换档或重新分段的出路；
 * - 离散档位（grok-video 只有 6/10/15）：取第一个装得下的值，同样按垫处理；
 * - 固定时长档：不传 seconds，装不下就拦，装得下按整条计费。
 */
export function resolveSeconds(model: VideoModelCapability, wanted: number): SecondsPlan {
  const rounded = Math.round(wanted * 1000) / 1000;
  if (model.fixedSeconds !== undefined) {
    if (rounded > model.fixedSeconds + 0.001) {
      return { billedSeconds: model.fixedSeconds, padded: 0, blocked: `${model.id} 固定出 ${model.fixedSeconds} 秒，这一段 ${rounded} 秒装不下。` };
    }
    return { billedSeconds: model.fixedSeconds, padded: Number((model.fixedSeconds - rounded).toFixed(3)) };
  }
  if (model.allowedSeconds) {
    const fit = model.allowedSeconds.find((value) => value >= rounded - 0.001);
    if (fit === undefined) {
      return { billedSeconds: model.maxSeconds, padded: 0, blocked: `${model.id} 的时长只能是 ${model.allowedSeconds.join(' / ')} 秒，这一段 ${rounded} 秒都装不下。` };
    }
    return { seconds: fit, billedSeconds: fit, padded: Number((fit - rounded).toFixed(3)) };
  }
  if (rounded > model.maxSeconds + 0.001) {
    return { billedSeconds: model.maxSeconds, padded: 0, blocked: `${model.id} 单次最长 ${model.maxSeconds} 秒，这一段 ${rounded} 秒超了。` };
  }
  const floor = model.minSeconds ?? 1;
  const seconds = Math.max(floor, Math.ceil(rounded));
  return { seconds, billedSeconds: seconds, padded: Number((seconds - rounded).toFixed(3)) };
}

/**
 * 参数表里手填的时长优先于按分镜推导的时长。
 * 超范围要在本地就拦下：等提交上去被上游拒，用户已经等过一轮排队了。
 * 手填的值对所有段一视同仁，所以必须同时算出"比这一段多/少几秒"，让人看得见节奏会被改成什么样。
 */
export function applySecondsOverride(
  model: VideoModelCapability,
  auto: SecondsPlan,
  override: number | undefined,
  wanted: number,
): SecondsPlan {
  if (override === undefined || !Number.isFinite(override)) return auto;
  // 固定时长档压根不能传 seconds，手填无效，照旧走自动。
  if (model.fixedSeconds !== undefined) return auto;
  // "让模型自己定"：出多长事先不知道，所以计费一律按这一档的上限估，宁可报高也不报低。
  if (model.autoSeconds !== undefined && override === model.autoSeconds) {
    return { seconds: override, billedSeconds: model.maxSeconds, padded: 0 };
  }
  if (model.allowedSeconds) {
    if (!model.allowedSeconds.some((value) => Math.abs(value - override) < 0.001)) {
      return { billedSeconds: override, padded: 0, blocked: `手填时长 ${override} 秒不在 ${model.id} 的可选值（${model.allowedSeconds.join(' / ')} 秒）里。` };
    }
  } else {
    const floor = model.minSeconds ?? 1;
    if (override < floor - 0.001 || override > model.maxSeconds + 0.001) {
      return { billedSeconds: override, padded: 0, blocked: `手填时长 ${override} 秒超出 ${model.id} 的 ${floor}–${model.maxSeconds} 秒范围。` };
    }
  }
  return {
    seconds: override,
    billedSeconds: override,
    padded: Number(Math.max(0, override - wanted).toFixed(3)),
    short: Number(Math.max(0, wanted - override).toFixed(3)),
  };
}

export interface VideoShot { prompt: string; duration: number }

/**
 * seedance-2.0 固定出 15 秒，且 shots 里所有 duration 之和必须正好是 15。
 * 分段本身不一定是 15 秒，所以按各镜原时长的比例摊到 15 秒上，再把取整余数补给最长的一镜，
 * 保证和精确等于 15（浮点直接相加会差 0.001 而被上游拒）。节奏会被拉伸或压缩，调用方要如实告知。
 */
export function buildShots(
  beats: Array<{ prompt: string; seconds: number }>,
  totalSeconds: number,
): { shots: VideoShot[]; stretched: boolean } | undefined {
  if (beats.length < 2 || beats.length > 15) return undefined;
  const source = beats.reduce((sum, beat) => sum + beat.seconds, 0);
  if (source <= 0) return undefined;
  const raw = beats.map((beat) => (beat.seconds / source) * totalSeconds);
  // 每段至少 1 秒，否则凑不满 2 段以上的有效分镜。
  const durations = raw.map((value) => Math.max(1, Math.floor(value)));
  let drift = totalSeconds - durations.reduce((sum, value) => sum + value, 0);
  // 用最大余数法摊掉取整误差：按小数部分从大到小轮流补 1，而不是把余数全堆给最长的一镜
  // （那样 6 秒 5 镜会摊成 2+2+2+7+2，节奏被一镜吃掉）。
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction)
    .map((item) => item.index);
  for (let step = 0; drift > 0 && step < order.length * totalSeconds; step += 1) {
    durations[order[step % order.length]] += 1;
    drift -= 1;
  }
  for (let step = 0; drift < 0 && step < order.length * totalSeconds; step += 1) {
    const index = order[order.length - 1 - (step % order.length)];
    if (durations[index] > 1) { durations[index] -= 1; drift += 1; }
  }
  if (drift !== 0) return undefined;
  if (durations.reduce((sum, value) => sum + value, 0) !== totalSeconds) return undefined;
  return {
    shots: beats.map((beat, index) => ({ prompt: beat.prompt, duration: durations[index] })),
    stretched: Math.abs(source - totalSeconds) > 0.01,
  };
}

export interface VideoRequestPlan {
  model: string;
  seconds?: number;
  resolution?: VideoResolution;
  ratio?: string;
  prompt: string;
  /** 角色参考图，必须是 https 链接或 data URI；本机 /api/assets 链接上游访问不到。 */
  referenceImages: string[];
  negativePrompt?: string;
  /** 只有 seedance-2.0 两档认；每段 {prompt,duration}，和必须正好等于固定时长。 */
  shots?: VideoShot[];
}

/**
 * 组装可直接 POST /v1/videos 的请求体。
 * 只放这一档真正认的字段：overrides 里多余的键一律丢弃，宁可少发也不要被上游整单拒掉。
 */
export function buildVideoRequest(
  model: VideoModelCapability,
  plan: VideoRequestPlan,
  overrides: Record<string, ParamValue> = {},
): Record<string, unknown> {
  const specs = videoParamSpecs(model);
  const allowed = new Map(specs.filter(isParamEditable).map((spec) => [spec.key, spec]));
  // 区分"没设过"和"明确不发"：没设过用这一档的默认值，设成空串表示用户明确不要这个字段
  // （比如想用 size 而不是 ratio 时，就得能把 ratio 清掉）。
  const pick = (key: string): ParamValue => {
    const spec = allowed.get(key);
    if (!spec) return undefined;
    if (!(key in overrides)) return spec.fallback;
    const chosen = overrides[key];
    return chosen === '' || chosen === undefined ? undefined : chosen;
  };

  const body: Record<string, unknown> = { model: model.id, prompt: plan.prompt };
  // 时长有两个来源：参数表里手填的（对所有段一视同仁）优先，没填才用按分镜推导的。
  // 固定时长档不在 allowed 里，pick 返回 undefined，照旧一个字节都不发。
  const chosenSeconds = pick('seconds');
  const seconds = chosenSeconds === undefined || chosenSeconds === '' ? plan.seconds : Number(chosenSeconds);
  if (model.fixedSeconds === undefined && seconds !== undefined && Number.isFinite(seconds)) body.seconds = String(seconds);

  const resolution = 'resolution' in overrides ? pick('resolution') : (plan.resolution ?? allowed.get('resolution')?.fallback);
  if (allowed.has('resolution') && resolution) body.resolution = resolution;
  const size = pick('size');
  const ratio = pick('ratio');
  // size 与 ratio 同时给时上游以 ratio 为准；这里只在没填 ratio 时才发 size，避免发一个注定被忽略的字段。
  if (allowed.has('ratio') && ratio) body.ratio = ratio;
  else if (allowed.has('size') && size) body.size = size;

  const audio = pick('generate_audio');
  if (allowed.has('generate_audio') && audio !== undefined) body.generate_audio = Boolean(audio);

  const seed = pick('seed');
  if (allowed.has('seed') && seed !== undefined && seed !== '') {
    const value = Number(seed);
    if (Number.isFinite(value)) body.seed = Math.trunc(value);
  }

  const negative = pick('negative_prompt') ?? plan.negativePrompt;
  if (allowed.has('negative_prompt') && negative) body.negative_prompt = String(negative).slice(0, 2500);

  const format = pick('output_format');
  if (allowed.has('output_format') && format) body.output_format = format;

  const wantShots = allowed.has('shots') ? pick('shots') !== false : false;
  if (wantShots && plan.shots && plan.shots.length >= 2 && plan.shots.length <= 15) body.shots = plan.shots;

  const images = plan.referenceImages.slice(0, Math.min(model.maxReferenceImages, model.maxReferenceTotal ?? model.maxReferenceImages));
  if (images.length > 0) {
    // 全能档走 images，其余档统一走 input_reference；单素材档只能给一个。
    //
    // images 曾经按火山原生 API 的 [{url, role}] 发，2026-09-10 探测时被中转当场打回：
    // "images must be a string or an array of strings"。中转的 /v1/videos 用的是它自己归一化过的形状，
    // 不是上游原生形状——照原生文档写的那版等于每一次带角色图的 2.5 提交都必然失败。
    if (model.referenceStyle === 'omni') body.images = images;
    else if (model.referenceStyle === 'single') body.input_reference = images[0];
    else body.input_reference = images.length === 1 ? images[0] : images;
  }
  return body;
}

export interface VideoPlanIssue { level: 'block' | 'warn'; message: string }

/** 提交前逐条核对这一档的硬限制；宁可在本地拦下，也不要提交后被上游拒还照付排队时间。 */
export function checkVideoPlan(model: VideoModelCapability, plan: { seconds: number; referenceImages: number; resolution?: VideoResolution; localImages?: boolean }): VideoPlanIssue[] {
  const issues: VideoPlanIssue[] = [];
  // 角色图存在本机，只能以 base64 data URI 提交；只收链接的档根本用不上，提交前就拦下，
  // 别让人等着上传完再被上游一句 "must contain only http or https URLs" 打回来。
  if (plan.localImages !== false && plan.referenceImages > 0 && model.maxReferenceImages > 0) {
    if (model.referenceUri === 'url-only') {
      issues.push({ level: 'block', message: `${model.id} 的参考素材只收 http/https 链接，不收 base64。角色图存在本机（/api/assets），上游访问不到，这一档没法带角色图提交——换 seedance-2.0 两档或 grok 两档（文档明写支持 data URI），或先把角色图放到公网 https 地址。` });
    } else if (model.referenceUri === 'unverified') {
      issues.push({ level: 'warn', message: `${model.id} 的文档没写是否收 base64 data URI，本地也还没实测。提交后若报 "must contain only http or https URLs"，说明这一档同样只收链接，请换 seedance-2.0 或 grok 两档。` });
    }
  }
  if (model.fixedSeconds !== undefined) {
    if (plan.seconds > model.fixedSeconds + 0.001) {
      issues.push({ level: 'block', message: `${model.id} 固定出 ${model.fixedSeconds} 秒，这一段 ${plan.seconds} 秒装不下；请换 seedance-2.5 或把这一段拆短。` });
    } else if (plan.seconds < model.fixedSeconds - 0.001) {
      issues.push({ level: 'warn', message: `${model.id} 固定出 ${model.fixedSeconds} 秒，这一段只有 ${plan.seconds} 秒，仍按整条 ${model.fixedSeconds} 秒计费。` });
    }
  } else if (model.allowedSeconds) {
    if (!model.allowedSeconds.some((value) => Math.abs(value - plan.seconds) < 0.001)) {
      issues.push({ level: 'block', message: `${model.id} 的时长只能是 ${model.allowedSeconds.join(' / ')} 秒，这一段是 ${plan.seconds} 秒。` });
    }
  } else {
    if (plan.seconds > model.maxSeconds + 0.001) {
      issues.push({ level: 'block', message: `${model.id} 单次最长 ${model.maxSeconds} 秒，这一段 ${plan.seconds} 秒超了；请分段或换时长上限更高的档。` });
    }
    if (model.minSeconds !== undefined && plan.seconds < model.minSeconds - 0.001) {
      issues.push({ level: 'block', message: `${model.id} 单次最短 ${model.minSeconds} 秒，这一段只有 ${plan.seconds} 秒。` });
    }
  }
  const imageCap = Math.min(model.maxReferenceImages, model.maxReferenceTotal ?? model.maxReferenceImages);
  if (plan.referenceImages > imageCap) {
    issues.push({
      level: model.maxReferenceImages === 0 ? 'block' : 'warn',
      message: model.maxReferenceImages === 0
        ? `${model.id} 不收参考图，${plan.referenceImages} 个角色的身份只能靠文字描述，跨镜头一致性没有保障。`
        : `${model.id} 最多收 ${imageCap} 张参考图${model.maxReferenceTotal !== undefined ? `（图片视频音频合计上限 ${model.maxReferenceTotal}）` : ''}，本段有 ${plan.referenceImages} 个角色；只会带前 ${imageCap} 张，其余角色靠文字。`,
    });
  }
  if (plan.resolution && model.resolutions.length > 0 && !model.resolutions.includes(plan.resolution)) {
    issues.push({ level: 'block', message: `${model.id} 不支持 ${plan.resolution}，可选 ${model.resolutions.join(' / ')}。` });
  }
  // 能选但没登记单价的画质（如 MiniMax-H3 的 1080p）：估价会是空的。
  // 与其让人看到一个不显示积分的段落自己猜，不如明说"这一档这个画质估不出价"。
  if (model.price.unit === 'second' && creditsPerSecond(model, plan.resolution) === undefined && model.resolutions.length > 0) {
    issues.push({ level: 'warn', message: `中转的价格表里没有 ${model.id} 在 ${plan.resolution ?? model.defaultResolution} 下的单价，本页估不出这一段要多少积分。提交前请自己确认扣费，或换一个有价的画质。` });
  }
  if (!model.ratioHonored && model.ratios.length > 0) {
    issues.push({ level: 'warn', message: `${model.id} 的上游实测不兑现 ratio，画幅由该档固定，传 9:16 也可能出横幅。` });
  }
  return issues;
}

/**
 * 即梦网页版靠 @ 菜单把图片绑成素材，所以提示词开头有一段绑定说明；
 * 走 API 时图片是当参数传的，那段说明不但没用，还会让模型去找一个不存在的菜单。
 * 这里把绑定段摘掉，换成一句按顺序说明第几张图是谁——参考图数组的顺序就是唯一的对应关系。
 */
export function toApiPrompt(webPrompt: string, castOrder: string[], model: VideoModelCapability): string {
  const blocks = webPrompt.split('\n\n').filter((block) => !block.startsWith('[素材绑定') && !/^CHAR_[A-Z0-9_]+ = 【/.test(block) && !/^\s*3D 参考\s*=/.test(block))
    .map(block => block.replace('绑定本段 3D 预演作为走位、构图与运镜参考；以文字动作和角色图为准，不生成灰模外观。', '只用角色图和以下文字分镜，不需要参考视频。'));
  const cap = Math.min(model.maxReferenceImages, model.maxReferenceTotal ?? model.maxReferenceImages);
  const usable = castOrder.slice(0, cap);
  const mapping = usable.length > 0
    ? [`参考图按顺序对应：${usable.map((id, index) => `第 ${index + 1} 张 = ${id}`).join('；')}。每个角色的形象以对应参考图为唯一依据，全片保持一致。`]
    : [];
  const missing = castOrder.slice(cap);
  if (missing.length > 0) {
    mapping.push(`这一档最多收 ${cap} 张参考图，${missing.join('、')} 没有参考图，只能按下面的文字描述表演，身份一致性无法保证。`);
  }
  return [...mapping, ...blocks].join('\n\n');
}

/** 本机 /api/assets 链接上游访问不到，参考图必须先转成 data URI 再提交。 */
export function isSubmittableImage(uri: string): boolean {
  return uri.startsWith('data:') || /^https:\/\//i.test(uri);
}

export interface RegroupPlan {
  groups: Array<{ beatIds: string[]; seconds: number }>;
  /** 单镜本身就超过这一档上限，怎么组都装不下。 */
  impossible: Array<{ beatId: string; seconds: number }>;
}

/**
 * 按目标模型的时长上限把镜头重新分组。分段是编译时按 Seedance 自身上限切的，
 * 换成 15 秒上限的档就会有段落装不下——这里按所选模型重算一遍，给出"这一档要切成几段"。
 * 镜头边界不动：单镜超上限就是真的没救，如实列出来而不是硬塞。
 */
export function regroupForModel(
  beats: Array<{ beatId: string; seconds: number }>,
  model: VideoModelCapability,
): RegroupPlan {
  const limit = model.fixedSeconds ?? (model.allowedSeconds ? Math.max(...model.allowedSeconds) : model.maxSeconds);
  const impossible = beats.filter((beat) => beat.seconds > limit + 0.001).map((beat) => ({ beatId: beat.beatId, seconds: beat.seconds }));
  // 只有 shots 能明确告诉模型镜头边界在哪；没有它就一次只能给一个连续镜头，
  // 硬把两个镜头合进一次生成，模型做不出中间那个硬切，会糊成一段。
  const canMerge = model.supportsShots;
  const groups: RegroupPlan['groups'] = [];
  let current: { beatIds: string[]; seconds: number } | null = null;
  for (const beat of beats) {
    if (beat.seconds > limit + 0.001) { current = null; continue; }
    if (canMerge && current && current.seconds + beat.seconds <= limit + 0.001) {
      current.beatIds.push(beat.beatId);
      current.seconds = Number((current.seconds + beat.seconds).toFixed(3));
    } else {
      current = { beatIds: [beat.beatId], seconds: beat.seconds };
      groups.push(current);
    }
  }
  return { groups, impossible };
}

// ---- 实测状态：/v1/models 会把分组里根本跑不了的模型也列出来，试过才知道 ----
// 把每一档的实测结果记在本机，避免反复踩同一个坑；这是账号相关的事实，不该写死进能力表。

export type ModelProbe = 'ok' | 'no_channel' | 'url_only' | 'unknown';
export interface ModelStatus { state: ModelProbe; at: number; note: string }

const STATUS_KEY = 'mirror:video-model-status';

export function loadModelStatus(): Record<string, ModelStatus> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); } catch { return {}; }
}

export function rememberModelStatus(modelId: string, state: ModelProbe, note: string, now: number) {
  if (typeof window === 'undefined') return;
  const all = { ...loadModelStatus(), [modelId]: { state, at: now, note } };
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(all)); } catch { /* 存不下不该挡住流程 */ }
}

/** 从一次失败的报错里读出这一档的实测结论；认不出就返回 undefined，不乱猜。 */
export function probeFromError(message: string): { state: ModelProbe; note: string } | undefined {
  if (/渠道不存在|no available channel/i.test(message)) {
    return { state: 'no_channel', note: '这个 Key 的视频分组下没有可用上游线路，换一档或去中转站开通。' };
  }
  if (/only http or https URLs|must be a? ?(https?) URL/i.test(message)) {
    return { state: 'url_only', note: '只收 http/https 链接，不收本机角色图转的 base64。' };
  }
  return undefined;
}

export const PROBE_BADGE: Record<ModelProbe, string> = {
  ok: '✅ 试过能用',
  no_channel: '⛔ 无可用渠道',
  url_only: '⛔ 不收本机角色图',
  unknown: '',
};

// ---- 参数表单：UI 由能力表推导，不在组件里写死任何一档的规则 ----

export type ParamValue = string | number | boolean | undefined;

export interface VideoParamSpec {
  key: string;
  label: string;
  kind: 'enum' | 'bool' | 'int' | 'text';
  options?: string[];
  min?: number;
  max?: number;
  placeholder?: string;
  /** 这一档在这个参数上的坑，直接显示在输入框下面。 */
  hint?: string;
  /** 不填时的取值；undefined 表示不发这个字段。 */
  fallback?: ParamValue;
  /** 这一档能不能填这个参数。false 时仍然显示，但要写清为什么不能填，不许悄悄藏掉。 */
  editable?: boolean;
  /** 这条限制的说法从哪来：实测 / 据文档 / 未验证。必须显示给用户。 */
  source: ParamSource;
  /** 实测过的话，把上游当时的原话带上——这是"没瞎编"的唯一凭据。 */
  evidence?: string;
}

/** 本机探测到的参数事实：把上游的原话记下来，把这一项从"据文档"升级成"实测"。 */
export interface ParamProbe { source: ParamSource; note: string; at: number }

const PARAM_PROBE_KEY = 'mirror:video-param-probe';

export function loadParamProbes(modelId?: string): Record<string, Record<string, ParamProbe>> | Record<string, ParamProbe> {
  if (typeof window === 'undefined') return {};
  try {
    const all = JSON.parse(localStorage.getItem(PARAM_PROBE_KEY) || '{}') as Record<string, Record<string, ParamProbe>>;
    return modelId ? (all[modelId] ?? {}) : all;
  } catch { return {}; }
}

export function rememberParamProbe(modelId: string, key: string, probe: ParamProbe) {
  if (typeof window === 'undefined') return;
  try {
    const all = JSON.parse(localStorage.getItem(PARAM_PROBE_KEY) || '{}') as Record<string, Record<string, ParamProbe>>;
    localStorage.setItem(PARAM_PROBE_KEY, JSON.stringify({ ...all, [modelId]: { ...(all[modelId] ?? {}), [key]: probe } }));
  } catch { /* 存不下不该挡住流程 */ }
}

/**
 * 同一个概念，各家上游的字段名不一样，判定"这条报错说的是不是这个参数"必须认别名。
 * 血的教训：MiniMax-H3 回的是 `duration must be between 4 and 15`，只按字面找 "seconds" 就会
 * 把一条完美的实测证据判成"探不到"，白白退回"据文档"——探测功能等于半废。
 */
const PARAM_ALIASES: Record<string, RegExp> = {
  seconds: /seconds?|duration|时长/i,
  resolution: /resolution|quality|清晰度|分辨率/i,
  ratio: /ratio|画幅|比例/i,
  size: /\bsize\b|width|height|尺寸/i,
  generate_audio: /generate[_\s-]?audio|audio|声音|音轨/i,
  seed: /\bseed\b|种子/i,
  negative_prompt: /negative[_\s-]?prompt|负面/i,
  shots: /\bshots?\b|分镜/i,
  output_format: /output[_\s-]?format|\bformat\b|格式/i,
};

/**
 * 从一次被拒的返回里判断"这次探测算不算证实了这个参数"。
 * 只有上游的原话确实提到了这个字段（或它的别名）才算数——提到别的字段（比如先拦了 prompt）
 * 说明它根本没走到这一步，那就老老实实返回 undefined，保持"据文档"，绝不把猜的说成试过的。
 */
export function probeVerdict(key: string, message: string, at: number): ParamProbe | undefined {
  const pattern = PARAM_ALIASES[key] ?? new RegExp(key.replace(/_/g, '[_\\s-]?'), 'i');
  if (!pattern.test(message)) return undefined;
  return { source: 'verified', note: message.replace(/\s+/g, ' ').trim().slice(0, 400), at };
}

/**
 * 这一档到底认哪些参数、各自的取值范围和坑。加模型或加参数只改这里，界面自动跟着变。
 * probes 是本机探测出来的事实，会把对应项从"据文档"升级成"实测"并附上上游原话。
 */
export function videoParamSpecs(model: VideoModelCapability, probes: Record<string, ParamProbe> = {}): VideoParamSpec[] {
  const specs: VideoParamSpec[] = [];

  // 时长必须摆在第一位：它同时决定成片长度和按秒计费的档收多少钱，是最该让人改的一项。
  // 留空＝按每段分镜自己的时长推导（默认行为）；填了就所有段统一按这个秒数提交。
  if (model.fixedSeconds !== undefined) {
    specs.push({
      key: 'seconds', label: '单段时长（秒）', kind: 'int', editable: false, fallback: model.fixedSeconds,
      hint: `这一档固定出 ${model.fixedSeconds} 秒，写别的值会被上游拒，所以不可填；不足 ${model.fixedSeconds} 秒的段落也按整条计费。`,
      source: paramSource(model, 'seconds'),
    });
  } else if (model.allowedSeconds) {
    specs.push({
      key: 'seconds', label: '单段时长（秒）', kind: 'enum', options: model.allowedSeconds.map(String),
      hint: `这一档只有 ${model.allowedSeconds.join(' / ')} 秒三个值，且必须显式传。留空＝按每段分镜时长自动挑第一个装得下的。`,
      source: paramSource(model, 'seconds'),
    });
  } else {
    const floor = model.minSeconds ?? 1;
    specs.push({
      key: 'seconds', label: '单段时长（秒）', kind: 'int',
      // 有"让模型自己定"这个特殊值时，下限要放到它那里去，否则输入框自己会把它拦掉。
      min: model.autoSeconds !== undefined ? Math.min(model.autoSeconds, floor) : floor,
      max: model.maxSeconds,
      placeholder: `留空＝按每段分镜自动（${floor}–${model.maxSeconds} 秒）`,
      hint: `范围 ${floor}–${model.maxSeconds} 秒${model.defaultSeconds !== undefined ? `，不传时上游按 ${model.defaultSeconds} 秒出片` : '，必须显式传'}。`
        + (model.autoSeconds !== undefined ? `填 ${model.autoSeconds} 表示让模型自己决定长度，但事先不知道出多长，估价只能按上限 ${model.maxSeconds} 秒算。` : '')
        + '填了就所有段统一按这个秒数，画面节奏会和分镜对不上，按秒计费的档也照这个数收费。',
      source: paramSource(model, 'seconds'),
    });
  }

  if (model.resolutions.length > 0) {
    specs.push({
      key: 'resolution', label: '分辨率', kind: 'enum', options: model.resolutions,
      fallback: model.defaultResolution,
      source: paramSource(model, 'resolution'),
      hint: model.id === 'seedance-2.5' ? '三档三个价：480p 比 720p 便宜 40%，1080p 是 720p 的 2.6 倍。'
        : model.id.startsWith('seedance-2.0') ? '480p 与 720p 同价。'
        : '不同档不同价，见下方能力说明。',
    });
  } else {
    specs.push({ key: 'resolution', label: '分辨率', kind: 'enum', options: [], editable: false, source: paramSource(model, 'resolution'), hint: '这一档的画质写在模型名里，不认 resolution 字段。' });
  }
  if (model.ratios.length > 0) {
    specs.push({
      key: 'ratio', label: '画面比例', kind: 'enum', options: model.ratios, fallback: '9:16',
      source: paramSource(model, 'ratio'),
      hint: model.ratioHonored ? undefined : '⚠️ 这一档的上游实测不兑现 ratio，画幅由该档固定，传了也可能出横幅。',
    });
  } else {
    specs.push({ key: 'ratio', label: '画面比例', kind: 'enum', options: [], editable: false, source: paramSource(model, 'ratio'), hint: '这一档不认 ratio，画幅由上游固定。' });
  }
  if (model.supportsSize) {
    specs.push({ key: 'size', label: '尺寸 size', kind: 'text', source: paramSource(model, 'size'), placeholder: '如 720x1280，留空则按比例', hint: '与画面比例同时填时以比例为准。' });
  } else {
    specs.push({ key: 'size', label: '尺寸 size', kind: 'text', editable: false, source: paramSource(model, 'size'), hint: '这一档不认 size 字段。' });
  }
  if (model.supportsGenerateAudio) {
    specs.push({
      key: 'generate_audio', label: '原生生成声音', kind: 'bool', fallback: true,
      source: paramSource(model, 'generate_audio'),
      hint: model.audioDefault === 'off' ? '这一档默认关，不显式传 true 就是哑片。'
        : model.audioDefault === 'upstream' ? '这一档不传时随上游默认，建议显式指定。'
        : '这一档默认开。',
    });
  } else {
    specs.push({ key: 'generate_audio', label: '原生生成声音', kind: 'bool', editable: false, source: paramSource(model, 'generate_audio'), hint: '这一档不认 generate_audio，出来大概率是无声片。' });
  }
  if (model.seed === 'int') {
    specs.push({ key: 'seed', label: '随机种子 seed', kind: 'int', source: paramSource(model, 'seed'), placeholder: '留空即随机；-1 也表示随机', hint: '同一个种子配同一份提示词可复现。' });
  } else if (model.seed === 'range') {
    specs.push({ key: 'seed', label: '随机种子 seed', kind: 'int', min: model.seedRange?.[0], max: model.seedRange?.[1], source: paramSource(model, 'seed'), placeholder: `留空即随机（${model.seedRange?.[0]}–${model.seedRange?.[1]}）`, hint: '这一档不接受 -1。' });
  } else if (model.seed === 'forwarded') {
    specs.push({ key: 'seed', label: '随机种子 seed', kind: 'int', source: paramSource(model, 'seed'), placeholder: '留空即不发', hint: '会照常转发，但这家上游是否真的兑现未经证实。' });
  } else if (model.seed === 'rejected') {
    specs.push({ key: 'seed', label: '随机种子 seed', kind: 'int', editable: false, source: paramSource(model, 'seed'), hint: '这一档传了会被上游直接拒绝，所以不可填。' });
  } else {
    specs.push({ key: 'seed', label: '随机种子 seed', kind: 'int', editable: false, source: paramSource(model, 'seed'), hint: '这一档不认 seed 字段。' });
  }
  if (model.supportsNegativePrompt) {
    specs.push({ key: 'negative_prompt', label: '负面提示词', kind: 'text', source: paramSource(model, 'negative_prompt'), placeholder: '不想出现的东西，如：模糊、字幕、多余的手', hint: '最多 2500 字，只有 seedance-2.0 两档支持。' });
  } else {
    specs.push({ key: 'negative_prompt', label: '负面提示词', kind: 'text', editable: false, source: paramSource(model, 'negative_prompt'), hint: '这一档不认 negative_prompt；不想要的东西只能写进正面提示词里回避。' });
  }
  if (model.supportsShots) {
    specs.push({ key: 'shots', label: '发送 shots 分镜表', kind: 'bool', fallback: true, source: paramSource(model, 'shots'), hint: '把本段各镜写成 {prompt,duration}，模型就不用自己猜在哪切；只有 2.0 两档支持。' });
  } else {
    specs.push({ key: 'shots', label: '发送 shots 分镜表', kind: 'bool', editable: false, source: paramSource(model, 'shots'), hint: '这一档不认 shots，一次请求只能是一个连续镜头，镜头边界要靠分段本身切开。' });
  }
  if (model.outputFormats?.length) {
    specs.push({ key: 'output_format', label: '输出格式', kind: 'enum', options: model.outputFormats, fallback: 'mp4', source: paramSource(model, 'output_format'), hint: '编辑与延长推荐 mov，后期调色更省事；只是看片用 mp4。' });
  } else {
    specs.push({ key: 'output_format', label: '输出格式', kind: 'enum', options: [], editable: false, source: paramSource(model, 'output_format'), hint: '这一档不认 output_format，固定出 mp4。' });
  }
  // 本机探测到的事实优先于文档：把这一项升级成"实测"，并把上游原话带上当凭据。
  return specs.map((spec) => {
    const probe = probes[spec.key];
    return probe ? { ...spec, source: probe.source, evidence: probe.note } : spec;
  });
}

/** 这个参数在这一档上能不能填。不能填的也要显示出来并说明原因，而不是悄悄藏掉。 */
export function isParamEditable(spec: VideoParamSpec): boolean {
  if (spec.editable !== undefined) return spec.editable;
  if (spec.kind === 'enum') return (spec.options?.length ?? 0) > 0;
  return true;
}
