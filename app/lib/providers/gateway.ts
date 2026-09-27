// Provider Gateway。
//
// 规格第廿四章：所有 AI 调用统一走这里，支持 Primary / Fallback。
// 业务层只说「我要出一段视频」，不关心背后是 OpenRouter 还是别家。
//
// 这一层存在的理由很具体：9 月 11 日 HeyRoute 的视频渠道整批掉线，
// 因为业务代码直接绑死了那一家，我们除了干等什么都做不了。

import { MockVideoProvider, type MockOptions } from './mock-video';
import { OpenRouterVideoProvider } from './openrouter-video';
import {
  isProviderError,
  type ProviderCall, type ProviderCredentials,
  type VideoGenerateInput, type VideoGenerationProvider, type VideoJob,
} from './types';

export interface ProviderBinding {
  provider: VideoGenerationProvider;
  creds: ProviderCredentials;
}

export interface GatewayOptions {
  /** 每次 Provider 调用的观测记录都交给它落库，Gateway 自己不碰数据库。 */
  onCall?: (call: ProviderCall) => void | Promise<void>;
}

/** 只有「这家不可用」才值得换下一家。参数被拒、余额不足换谁都一样。 */
function shouldFallback(err: unknown): boolean {
  return isProviderError(err) && (err.kind === 'unavailable' || err.kind === 'auth');
}

export class VideoGateway {
  /**
   * @param chain 按优先级排列：第一个是主力，后面的是备份。
   */
  constructor(
    private readonly chain: ProviderBinding[],
    private readonly opts: GatewayOptions = {},
  ) {
    if (chain.length === 0) throw new Error('VideoGateway 至少需要一个 Provider');
  }

  /** 出片。主力不可用时自动落到下一家；最后一家也失败就抛出最后那个错误。 */
  async generate(input: VideoGenerateInput): Promise<{ job: VideoJob; binding: ProviderBinding }> {
    let last: unknown;
    for (const binding of this.chain) {
      const t0 = Date.now();
      try {
        const job = await binding.provider.generate(input, binding.creds);
        await this.record(binding, input, job, 'generate', Date.now() - t0, 200);
        return { job, binding };
      } catch (err) {
        last = err;
        await this.record(binding, input, undefined, 'generate', Date.now() - t0,
          isProviderError(err) ? err.httpStatus : 0, err);
        if (!shouldFallback(err)) throw err;   // 参数问题换家也白搭，立刻抛
      }
    }
    throw last;
  }

  /** 查状态必须回到当初提交的那一家——jobId 是各家自己的命名空间，不通用。 */
  async status(jobId: string, providerName: string): Promise<VideoJob> {
    const binding = this.bindingOf(providerName);
    return await binding.provider.getTaskStatus(jobId, binding.creds);
  }

  async download(job: VideoJob, providerName: string): Promise<ArrayBuffer> {
    const binding = this.bindingOf(providerName);
    return await binding.provider.download(job, binding.creds);
  }

  estimateCents(input: VideoGenerateInput): number | undefined {
    return this.chain[0].provider.estimateCents(input);
  }

  capabilities(model: string) {
    for (const b of this.chain) {
      const cap = b.provider.capabilities(model);
      if (cap) return cap;
    }
    return undefined;
  }

  private bindingOf(name: string): ProviderBinding {
    const found = this.chain.find((b) => b.provider.name === name);
    if (!found) throw new Error(`未配置的 Provider: ${name}`);
    return found;
  }

  private async record(
    binding: ProviderBinding, input: VideoGenerateInput, job: VideoJob | undefined,
    operation: string, latencyMs: number, httpStatus: number, err?: unknown,
  ): Promise<void> {
    if (!this.opts.onCall) return;
    await this.opts.onCall({
      provider: binding.provider.name,
      model: input.model,
      operation,
      upstreamJobId: job?.jobId,
      // 请求体里的参考图是几 MB 的 base64，落库会把表撑爆，只留长度
      request: { ...input, referenceImages: input.referenceImages?.map((s) => `<${s.length} chars>`) },
      response: job?.raw ?? null,
      httpStatus,
      latencyMs,
      providerCostCents: job?.costCents ?? 0,
      error: err instanceof Error ? err.message : err ? String(err) : undefined,
    });
  }
}

/** 从配置构造 Gateway。名字与凭据都来自 system_config，代码里不写死。 */
export function buildVideoGateway(
  config: Array<{ provider: string; baseUrl: string; apiKey: string }>,
  opts: GatewayOptions & { mock?: MockOptions } = {},
): VideoGateway {
  const make = (name: string): VideoGenerationProvider => {
    if (name === 'openrouter') return new OpenRouterVideoProvider();
    if (name === 'mock') return new MockVideoProvider(opts.mock);
    throw new Error(`未知的视频 Provider: ${name}`);
  };
  return new VideoGateway(
    config.map((c) => ({ provider: make(c.provider), creds: { baseUrl: c.baseUrl, apiKey: c.apiKey } })),
    opts,
  );
}
