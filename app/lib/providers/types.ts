// AI Provider 统一契约。
//
// 规格第十五、廿四章：业务层不许绑定任何一家。Controller 里不许直接调第三方。
// 现状是 relay-client.ts 直接绑死了 HeyRoute 的形状，换一家就要改业务代码——
// 这两天 HeyRoute 渠道全挂的时候，我们只能干等，就是因为没有这一层。
//
// 所有 Provider 都返回归一化结果，成本一律用整数「分」。

export type ProviderKind = 'analysis' | 'image' | 'video';

export interface ProviderCredentials {
  /** 上游基址。绝不硬编码在代码里，必须从配置来。 */
  baseUrl: string;
  apiKey: string;
}

/** 一次调用的可观测记录，落 provider_requests 表。 */
export interface ProviderCall {
  provider: string;
  model: string;
  operation: string;
  upstreamJobId?: string;
  request: unknown;
  response: unknown;
  httpStatus: number;
  latencyMs: number;
  providerCostCents: number;
  error?: string;
}

/**
 * 判别一个错误是不是 ProviderError。
 *
 * 不用 instanceof：同一个类在不同 bundle 里是两个不同的构造函数，
 * 跨模块边界传过来的错误会判成 false，于是「渠道不存在」被当成我们自己的 bug，
 * 既不会 fallback 也不会重试。认 name + kind 两个字段更可靠。
 */
export function isProviderError(err: unknown): err is ProviderError {
  return Boolean(err) && typeof err === 'object'
    && (err as Error).name === 'ProviderError'
    && typeof (err as ProviderError).kind === 'string';
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'rejected'       // 参数不合法，重试无意义
      | 'unavailable'    // 渠道不存在 / 限流 / 5xx，可换线路或退避
      | 'timeout'        // 不知道对面收没收，必须先查再重试
      | 'auth'
      | 'insufficient_balance'
      | 'unknown',
    readonly httpStatus = 0,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ---------- 视频生成 ----------

export interface VideoGenerateInput {
  model: string;
  prompt: string;
  /** 秒。Provider 自己负责校验是否落在本档允许的范围内。 */
  seconds?: number;
  resolution?: string;
  aspectRatio?: string;
  /** 参考图：https 链接或 data URI。顺序即角色顺序。 */
  referenceImages?: string[];
  /**
   * 参考视频：3D 预演片段。https 链接或 data URI。
   *
   * 2026-09-17 实测：OpenRouter 的 input_references 判别器允许
   * ['image_url','audio_url','video_url'] 三种，video_url 确实被接受；
   * 定价里 video_tokens_with_video_input 比不带视频输入还便宜 40%。
   * 它锁的是运镜曲线和走位轨迹——这两样文字描述锁不住。
   */
  referenceVideos?: string[];
  firstFrame?: string;
  lastFrame?: string;
  generateAudio?: boolean;
  seed?: number;
  /** 透传给上游的额外字段。只放这一档确实认的键。 */
  extra?: Record<string, unknown>;
}

export interface VideoJob {
  /** 上游任务 id。必须在提交成功的那一刻就持久化——这是唯一能找回成片的钥匙。 */
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | 'expired';
  videoUrl?: string;
  /** 下载是否需要带上 Authorization 头。OpenRouter 需要，HeyRoute 给的是签名链接不需要。 */
  needsAuthToDownload?: boolean;
  costCents?: number;
  error?: string;
  raw?: unknown;
}

export interface VideoGenerationProvider {
  readonly name: string;
  /** 这一档认哪些参数、范围多少。UI 表单由它推导，不在组件里写死。 */
  capabilities(model: string): VideoCapability | undefined;
  estimateCents(input: VideoGenerateInput): number | undefined;
  generate(input: VideoGenerateInput, creds: ProviderCredentials): Promise<VideoJob>;
  getTaskStatus(jobId: string, creds: ProviderCredentials): Promise<VideoJob>;
  download(job: VideoJob, creds: ProviderCredentials): Promise<ArrayBuffer>;
  cancel?(jobId: string, creds: ProviderCredentials): Promise<void>;
}

/** 参数来源：实测 / 据文档 / 未验证。必须显示给用户，不许把猜的说成试过的。 */
export type ParamSource = 'verified' | 'documented' | 'assumed';

export interface VideoCapability {
  model: string;
  label: string;
  minSeconds?: number;
  maxSeconds: number;
  /** 只接受这几个离散值时用它。 */
  allowedSeconds?: number[];
  /** 传这个值表示时长交给模型决定（MiniMax 的 -1）。 */
  autoSeconds?: number;
  resolutions: string[];
  aspectRatios: string[];
  maxReferenceImages: number;
  /** 能不能收参考视频（3D 预演）。 */
  supportsReferenceVideo?: boolean;
  supportsFirstLastFrame: boolean;
  supportsAudio: boolean;
  supportsSeed: boolean;
  /** 每秒成本，整数分。按条计价的档用 flatCents。 */
  centsPerSecond?: number;
  flatCents?: number;
  sources: Partial<Record<string, ParamSource>>;
  notes: string[];
}

// ---------- 图片 ----------

export interface ImageGenerateInput {
  model: string;
  prompt: string;
  referenceImages?: string[];
  size?: string;
  n?: number;
}

export interface ImageResult {
  images: Array<{ dataUri?: string; url?: string }>;
  costCents?: number;
  raw?: unknown;
}

export interface ImageProvider {
  readonly name: string;
  generate(input: ImageGenerateInput, creds: ProviderCredentials): Promise<ImageResult>;
  estimateCents(input: ImageGenerateInput): number | undefined;
}

// ---------- 视频分析 ----------

export interface AnalysisInput {
  model: string;
  /** 视频：base64 data URI 或已上传的文件引用。 */
  video: { dataUri?: string; fileUri?: string; mimeType: string };
  instruction: string;
  /** 采样参数。实测过：开关之间 prompt tokens 差 5 倍，直接决定分析准不准。 */
  fps?: number;
  mediaResolution?: 'default' | 'high';
  responseSchema?: unknown;
}

export interface AnalysisResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  costCents?: number;
  raw?: unknown;
}

export interface AnalysisProvider {
  readonly name: string;
  analyze(input: AnalysisInput, creds: ProviderCredentials): Promise<AnalysisResult>;
  estimateCents(input: AnalysisInput, durationSeconds: number): number | undefined;
}
