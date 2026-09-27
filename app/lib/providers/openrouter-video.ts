// OpenRouter 视频 Provider。
//
// 这是目前唯一一条实测跑通的出片线路（2026-09-11，四段成片全部出齐）。
// 参数与流程全部来自 OpenRouter 自己的 llms.txt 与实测报错，不是照文档猜的。
//
// 几个踩过的坑，都写进代码而不是留在脑子里：
//  1. 视频模型不在 /api/v1/models，在 /api/v1/videos/models —— 查错表会得出「一个都没有」的错误结论。
//  2. 提交是唯一扣费点，jobId 必须在拿到的那一刻就持久化，否则进程一死就找不回成片。
//  3. 下载地址要带 Authorization 头，浏览器 <video src> 直接播不了，必须服务端代下。
//  4. 文档列出的参数「不等于」该档真的支持：hailuo-3-max 文档写了 input_references，
//     实际提交回 "does not support image input references"。所以能力表只登记实测过的。

import {
  ProviderError,
  type ProviderCredentials, type VideoCapability, type VideoGenerateInput,
  type VideoGenerationProvider, type VideoJob,
} from './types';

const API = '/api/v1/videos';

/** 实测确认的能力。没实测过的一律标 documented/assumed，不许标 verified。 */
const CAPS: Record<string, VideoCapability> = {
  'bytedance/seedance-2.5': {
    model: 'bytedance/seedance-2.5',
    label: 'Seedance 2.5 · 4–30 秒 · 全能档',
    minSeconds: 4,
    maxSeconds: 30,
    resolutions: ['480p', '720p'],
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    maxReferenceImages: 50,
    // 模型页面写的原生上限；OpenRouter 侧不校验数量（实测传 120 张也不拦）
    supportsReferenceVideo: true,   // 2026-09-17 探测：input_references 判别器接受 video_url
    supportsFirstLastFrame: true,
    supportsAudio: true,
    supportsSeed: true,
    centsPerSecond: 1028,             // $0.1028/秒，按「美分×100」存整数，避免浮点做账
    sources: {
      seconds: 'verified',            // 上游原话：Supported durations: 4..30s
      resolution: 'verified',
      aspect_ratio: 'documented',
      reference_images: 'verified',   // 实测五张角色图成片
      seed: 'documented',
      generate_audio: 'documented',
      max_reference_images: 'assumed',// 数量上限 OpenRouter 不校验，字节那边多少不知道
    },
    notes: [
      '实测 10 秒片约 247 秒出片、20 秒片约 361 秒，轮询上限要留足。',
      '没有 shots 分镜表参数：一次生成里做硬切要靠提示词里的 Shot 1:/Shot 2: 标签。',
      '没有 edit/extend：要对已有视频做延长只能走火山官方原生 API。',
    ],
  },
  'minimax/hailuo-3': {
    model: 'minimax/hailuo-3',
    label: 'Hailuo 3 · 5–15 秒 · 2K',
    minSeconds: 5,
    maxSeconds: 15,
    resolutions: ['2K'],
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    maxReferenceImages: 0,            // 未实测，保守按 0；同门的 -max 档实测被拒
    supportsFirstLastFrame: true,
    supportsAudio: true,
    supportsSeed: false,
    centsPerSecond: 1300,
    sources: { seconds: 'verified', resolution: 'documented', reference_images: 'assumed' },
    notes: ['参考图是否可用未实测；同系的 hailuo-3-max 实测明确不支持。没有 seed，结果无法复现。'],
  },
  'minimax/hailuo-3-max': {
    model: 'minimax/hailuo-3-max',
    label: 'Hailuo 3 Max · 5–15 秒 · 768p/480p · 最便宜',
    minSeconds: 5,
    maxSeconds: 15,
    resolutions: ['768p', '480p'],
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    maxReferenceImages: 0,            // 实测：提交即被拒 "does not support image input references"
    supportsFirstLastFrame: false,
    supportsAudio: false,
    supportsSeed: false,
    centsPerSecond: 500,
    sources: { seconds: 'verified', reference_images: 'verified' },
    notes: ['最便宜，但实测不收参考图，锁不住角色形象——本项目用不上。'],
  },
};

interface SubmitResponse { id: string; generation_id?: string; status?: string }
interface StatusResponse {
  id: string;
  status: string;
  unsigned_urls?: string[];
  error?: string;
  usage?: { cost?: number };
}

function classify(status: number, message: string): ProviderError {
  if (status === 401 || status === 403) {
    // 403 有两种：地区限制 / ToS 限制。都不是重试能解决的。
    return new ProviderError(message, /region|Terms Of Service|restricted/i.test(message) ? 'rejected' : 'auth', status);
  }
  if (status === 402 || /insufficient credits/i.test(message)) return new ProviderError(message, 'insufficient_balance', status);
  if (status === 400) return new ProviderError(message, 'rejected', status);
  if (status === 404 || status === 429 || status >= 500) return new ProviderError(message, 'unavailable', status);
  return new ProviderError(message, 'unknown', status);
}

export class OpenRouterVideoProvider implements VideoGenerationProvider {
  readonly name = 'openrouter';

  capabilities(model: string): VideoCapability | undefined {
    return CAPS[model];
  }

  estimateCents(input: VideoGenerateInput): number | undefined {
    const cap = CAPS[input.model];
    if (!cap) return undefined;
    if (cap.flatCents !== undefined) return cap.flatCents;
    if (cap.centsPerSecond === undefined) return undefined;
    const seconds = input.seconds ?? cap.minSeconds ?? 1;
    // centsPerSecond 存的是「美分×100」，除回来得到分
    return Math.ceil((cap.centsPerSecond * seconds) / 100);
  }

  /** 提交前先按能力表拦一道：宁可本地拒，也不要提交后被上游拒还白等一轮排队。 */
  private validate(input: VideoGenerateInput): void {
    const cap = CAPS[input.model];
    if (!cap) return;   // 没登记的档不假设它的限制，直接放行由上游裁决
    const s = input.seconds;
    if (s !== undefined && s !== cap.autoSeconds) {
      if (cap.allowedSeconds && !cap.allowedSeconds.includes(s)) {
        throw new ProviderError(`${input.model} 的时长只能是 ${cap.allowedSeconds.join(' / ')} 秒`, 'rejected');
      }
      if (!cap.allowedSeconds && (s < (cap.minSeconds ?? 1) || s > cap.maxSeconds)) {
        throw new ProviderError(`${input.model} 的时长范围是 ${cap.minSeconds ?? 1}–${cap.maxSeconds} 秒，收到 ${s}`, 'rejected');
      }
    }
    if (input.resolution && cap.resolutions.length && !cap.resolutions.includes(input.resolution)) {
      throw new ProviderError(`${input.model} 不支持 ${input.resolution}，可选 ${cap.resolutions.join(' / ')}`, 'rejected');
    }
    if (input.referenceImages?.length && cap.maxReferenceImages === 0) {
      throw new ProviderError(`${input.model} 不收参考图，角色形象锁不住，请换档`, 'rejected');
    }
  }

  async generate(input: VideoGenerateInput, creds: ProviderCredentials): Promise<VideoJob> {
    this.validate(input);
    const cap = CAPS[input.model];

    const body: Record<string, unknown> = { model: input.model, prompt: input.prompt, ...input.extra };
    if (input.seconds !== undefined) body.duration = input.seconds;
    if (input.resolution) body.resolution = input.resolution;
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
    if (input.referenceImages?.length) {
      body.input_references = input.referenceImages.map((url) => ({ type: 'image_url', image_url: { url } }));
    }
    if (input.referenceVideos?.length && cap?.supportsReferenceVideo) {
      // 参考视频和参考图共用 input_references，类型判别器区分。
      // 预演视频放在最前面：它管的是运镜和走位，优先级高于角色形象参考图。
      body.input_references = [
        ...input.referenceVideos.map((url) => ({ type: 'video_url', video_url: { url } })),
        ...((body.input_references as unknown[]) ?? []),
      ];
    }
    const frames: unknown[] = [];
    if (input.firstFrame) frames.push({ type: 'image_url', image_url: { url: input.firstFrame }, frame_type: 'first_frame' });
    if (input.lastFrame) frames.push({ type: 'image_url', image_url: { url: input.lastFrame }, frame_type: 'last_frame' });
    if (frames.length) body.frame_images = frames;
    if (input.generateAudio !== undefined && cap?.supportsAudio) body.generate_audio = input.generateAudio;
    if (input.seed !== undefined && cap?.supportsSeed) body.seed = input.seed;

    const res = await fetch(creds.baseUrl + API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw classify(res.status, extractMessage(text));

    const json = JSON.parse(text) as SubmitResponse;
    if (!json.id) {
      // 提交成功但没拿到 id：钱已经付了却找不回成片。这是最坏的情况，必须把原文吐出来。
      throw new ProviderError(`提交已发出但返回里没有 job id，可能已计费：${text.slice(0, 800)}`, 'unknown', res.status, text);
    }
    return { jobId: json.id, status: 'pending', needsAuthToDownload: true, raw: json };
  }

  async getTaskStatus(jobId: string, creds: ProviderCredentials): Promise<VideoJob> {
    const res = await fetch(`${creds.baseUrl}${API}/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    const text = await res.text();
    if (!res.ok) throw classify(res.status, extractMessage(text));
    const json = JSON.parse(text) as StatusResponse;
    const map: Record<string, VideoJob['status']> = {
      pending: 'pending', in_progress: 'running', running: 'running',
      completed: 'completed', failed: 'failed', cancelled: 'canceled', canceled: 'canceled', expired: 'expired',
    };
    return {
      jobId,
      status: map[json.status] ?? 'pending',
      videoUrl: json.unsigned_urls?.[0],
      needsAuthToDownload: true,
      // usage.cost 是美元，转成分
      costCents: json.usage?.cost === undefined ? undefined : Math.round(json.usage.cost * 100),
      error: json.error,
      raw: json,
    };
  }

  async download(job: VideoJob, creds: ProviderCredentials): Promise<ArrayBuffer> {
    const res = await fetch(`${creds.baseUrl}${API}/${encodeURIComponent(job.jobId)}/content?index=0`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!res.ok) throw classify(res.status, extractMessage(await res.text()));
    return await res.arrayBuffer();
  }
}

function extractMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    return String(j?.error?.message ?? j?.error ?? j?.message ?? text).slice(0, 600);
  } catch {
    return text.slice(0, 600);
  }
}

export const OPENROUTER_VIDEO_CAPABILITIES = CAPS;
