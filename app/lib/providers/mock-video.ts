// Mock 视频 Provider。
//
// 规格第卅六章：缺真实 Key 或接口文档时不能因此停下，要把接口、适配器、调用链、
// 重试、计费钩子都做出来，用 Mock 撑住整条管线。
//
// 它也是测试的主力：不花钱、可控制成功/失败/超时，用来验状态机和计费逻辑。

import {
  ProviderError,
  type ProviderCredentials, type VideoCapability, type VideoGenerateInput,
  type VideoGenerationProvider, type VideoJob,
} from './types';

const CAP: VideoCapability = {
  model: 'mock/video',
  label: 'Mock 视频（不产生真实费用）',
  minSeconds: 1,
  maxSeconds: 60,
  resolutions: ['480p', '720p', '1080p'],
  aspectRatios: ['16:9', '9:16', '1:1'],
  maxReferenceImages: 10,
  supportsFirstLastFrame: true,
  supportsAudio: true,
  supportsSeed: true,
  centsPerSecond: 100,
  sources: {},
  notes: ['Mock，永远不调用外部服务。TODO_REAL_PROVIDER_INTEGRATION'],
};

interface MockJob { status: VideoJob['status']; createdAt: number; seconds: number; failAfter?: number }

/** 进程内状态即可：Mock 不需要跨进程。 */
const jobs = new Map<string, MockJob>();

export interface MockOptions {
  /** 模拟出片耗时，默认 2 秒，测试里通常设 0。 */
  generationMs?: number;
  /** 提示词里包含这个词就让任务失败，用来测重试与失败分类。 */
  failKeyword?: string;
  /**
   * 产出真实可播放的 mp4 字节。由 worker 侧注入（用 ffmpeg 合成一段黑场）。
   *
   * 不传就返回一段占位文本——那对纯逻辑测试够用，但只要下游真的去解析它
   * （质检要 ffprobe 探时长），就会得到 "moov atom not found" 这种
   * 指向完全错误方向的报错。跟 Mock 图片一样：给下游的东西必须是能用的。
   */
  renderBytes?: (seconds: number) => Promise<ArrayBuffer>;
}

export class MockVideoProvider implements VideoGenerationProvider {
  readonly name = 'mock';
  constructor(private readonly opts: MockOptions = {}) {}

  capabilities(model: string): VideoCapability | undefined {
    return model.startsWith('mock/') ? CAP : undefined;
  }

  estimateCents(input: VideoGenerateInput): number {
    return Math.ceil(((CAP.centsPerSecond ?? 0) * (input.seconds ?? 1)) / 100);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Mock 不用凭据，但签名要与接口一致
  async generate(input: VideoGenerateInput, _creds?: ProviderCredentials): Promise<VideoJob> {
    if (!input.prompt?.trim()) throw new ProviderError('prompt 不能为空', 'rejected', 400);
    const jobId = `mock-${crypto.randomUUID()}`;
    jobs.set(jobId, {
      status: 'pending',
      createdAt: Date.now(),
      seconds: input.seconds ?? 1,
      failAfter: this.opts.failKeyword && input.prompt.includes(this.opts.failKeyword) ? 0 : undefined,
    });
    return { jobId, status: 'pending', needsAuthToDownload: false };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同上
  async getTaskStatus(jobId: string, _creds?: ProviderCredentials): Promise<VideoJob> {
    const job = jobs.get(jobId);
    if (!job) throw new ProviderError(`未知任务 ${jobId}`, 'rejected', 404);
    const elapsed = Date.now() - job.createdAt;
    if (job.failAfter !== undefined && elapsed >= job.failAfter) {
      return { jobId, status: 'failed', error: 'mock: 按 failKeyword 触发的失败' };
    }
    if (elapsed < (this.opts.generationMs ?? 2000)) return { jobId, status: 'running' };
    return {
      jobId,
      status: 'completed',
      videoUrl: `mock://video/${jobId}`,
      needsAuthToDownload: false,
      costCents: Math.ceil(((CAP.centsPerSecond ?? 0) * job.seconds) / 100),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同上
  async download(job: VideoJob, _creds?: ProviderCredentials): Promise<ArrayBuffer> {
    if (this.opts.renderBytes) {
      return await this.opts.renderBytes(jobs.get(job.jobId)?.seconds ?? 1);
    }
    // 没注入渲染器时给一段占位文本。纯逻辑测试够用，但别让它流到会解析文件的地方。
    const bytes = new TextEncoder().encode(`MOCK_VIDEO:${job.jobId}`);
    return bytes.buffer as ArrayBuffer;
  }

  async cancel(jobId: string): Promise<void> {
    const job = jobs.get(jobId);
    if (job) job.status = 'canceled';
  }

  /** 测试用：清掉进程内状态。 */
  static reset(): void { jobs.clear(); }
}
