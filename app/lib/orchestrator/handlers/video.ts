// 出片 handler。
//
// 这是整条管线里唯一真正花钱的一步，所以它的顺序是被仔细排过的：
//
//   冻结预估 → 提交上游 → 立刻持久化 jobId → 轮询 → 下载 → 存对象存储
//   → 按真实消耗结算 → 解冻差额
//
// 「立刻持久化 jobId」这一步是血的教训：9 月 11 日跑 RUN_03 时后台进程被杀，
// stdout 缓冲区没刷出来，1.03 美元付了，job id 丢了，成片再也拿不回来
// （/api/v1/activity 只给已完结的 UTC 日、且需要管理密钥，记录里也没有那个 20 位 id）。
// 所以提交成功和写库之间不允许有任何一行可能失败的代码。
//
// 失败时的钱怎么算：
//  - 提交就被拒（参数不合法）→ 上游没建任务，不扣，全额解冻。
//  - 提交成功但生成失败 → OpenRouter 实测「失败的生成不计费」，同样全额解冻。
//    这条是实测结论不是猜测；换 Provider 必须重新验一遍再改这里。
//  - 生成成功 → 按上游返回的真实成本扣，没返回就按预估扣。

import { compileShotPrompt } from '../../prompt-compiler';
import type { VideoGateway } from '../../providers/gateway';
import { isProviderError, type VideoGenerateInput, type VideoJob } from '../../providers/types';
import type { Wallet } from '../../billing/wallet';
import type { FailureClass } from '../../task/states';
import { TaskFailure, type HandlerContext, type TaskHandler } from '../runtime';

/** 上游错误 → 失败分类。队列据此决定重试还是进死信。 */
export function classifyProviderError(err: unknown): FailureClass {
  if (!isProviderError(err)) return 'internal';
  switch (err.kind) {
    case 'rejected': return 'provider_rejected';
    case 'unavailable': return 'provider_unavailable';
    case 'timeout': return 'timeout';
    case 'auth': return 'provider_unavailable';
    case 'insufficient_balance': return 'insufficient_balance';
    default: return 'unknown';
  }
}

export interface VideoTaskInput extends Partial<VideoGenerateInput> {
  projectId: string;
  shotId: string;
  model: string;
  /** 付费用户。byok 模式下为空，此时不走钱包。 */
  userId?: string;
  /** 重试时由重试引擎写进来，提示词会据此加强对应段落。 */
  retryHint?: { failureClass: string; note: string };
  /** 已有的 Blender 预演结果，会作为「空间关系已锁定」段写进提示词。 */
  blenderPreview?: { blocking: string; cameraPath: string };
  /** 提示词字符上限，来自目标模型的能力表。 */
  maxPromptChars?: number;
  /** 预演模式，决定要不要去取参考视频。 */
  previsMode?: 'full' | 'per_shot' | 'off';
}

export interface ObjectStore {
  put(key: string, body: ArrayBuffer, contentType: string): Promise<{ key: string; bytes: number }>;
}

export interface VideoHandlerDeps {
  gateway: VideoGateway;
  wallet?: Wallet;
  store: ObjectStore;
  /**
   * 提示词由 handler 自己编译，而不是由编排器预先算好塞进任务输入。
   * 两个理由：重试时要能带上加强语重新编译；提示词必须对应当前的 Shot DNA 版本，
   * 而 DNA 在排完任务之后还可能被连续性引擎或人工改过。
   * 不传就要求 input.prompt 已经给好（测试和 byok 直连模式用）。
   */
  prompts?: {
    getShotDna: (shotId: string) => Promise<import('../../shot-dna/types').ShotDna | null>;
    compileContext: (projectId: string) => Promise<import('../../prompt-compiler').CompileContext>;
    /** 编译完回写，后台能看到这一次用的到底是哪份提示词。 */
    save?: (shotId: string, p: { text: string; template: string; version: string; fingerprint: string }) => Promise<void>;
  };
  /** 提交成功的那一刻立刻落库，不许延后。 */
  persistJobId: (taskId: string, providerName: string, jobId: string) => Promise<void>;
  /** 出片结果登记为 asset，返回 asset id。 */
  registerAsset: (input: { projectId: string; shotId: string; key: string; bytes: number; seconds: number }) => Promise<string>;
  /**
   * 取这一镜的 3D 预演片段，返回可直接放进 input_references 的 URL 或 data URI。
   * 全片模式下由它负责按镜切段；逐镜模式直接返回那一镜的预演。
   * 不配置就不带参考视频——预演是可选的。
   */
  previsVideoFor?: (input: { projectId: string; shotId: string; startTime: number; endTime: number }) => Promise<string | undefined>;
  /** 轮询间隔与上限。视频实测 6 分钟以上，默认给到 20 分钟。 */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep: (ms: number) => Promise<void>;
}

export function createVideoHandler(deps: VideoHandlerDeps): TaskHandler {
  return {
    type: 'video',
    async run(ctx: HandlerContext) {
      const raw = JSON.parse(ctx.task.input_json || '{}') as VideoTaskInput;

      // 提示词：任务里给了就用给的，没给就现编。
      let prompt = raw.prompt ?? '';
      let negative = raw.extra?.negative_prompt as string | undefined;
      if (!prompt.trim() && deps.prompts) {
        const dna = await deps.prompts.getShotDna(raw.shotId);
        if (!dna) throw new TaskFailure(`找不到镜头 ${raw.shotId} 的 Shot DNA，无法编译提示词`, 'internal');
        const compiled = compileShotPrompt(dna, {
          ...(await deps.prompts.compileContext(raw.projectId)),
          maxChars: raw.maxPromptChars,
          retryHint: raw.retryHint,
          // 预演结果存在 Shot DNA 里，不必让编排器从 blender 任务的 output 里转运一趟。
          blenderPreview: dna.complexity.previs
            ? { blocking: dna.complexity.previs.blocking, cameraPath: dna.complexity.previs.camera_path }
            : raw.blenderPreview,
        });
        if (compiled.dropped.length) {
          // 静默降级等于退款。丢了内容一定要说，而且要说清丢了哪几段。
          ctx.log(`提示词超长，已丢弃段落：${compiled.dropped.join('、')}`);
        }
        prompt = compiled.text;
        negative = compiled.negative || negative;
        await deps.prompts.save?.(raw.shotId, {
          text: compiled.text, template: compiled.template,
          version: compiled.version, fingerprint: compiled.fingerprint,
        });
        ctx.log(`提示词 ${compiled.template}@${compiled.version} ${compiled.charCount} 字，指纹 ${compiled.fingerprint}`);
      }
      if (!prompt.trim()) throw new TaskFailure('提示词为空，且没有配置提示词编译器', 'provider_rejected');

      // 3D 预演片段作为参考视频。它锁的是运镜曲线和走位轨迹——
      // 这两样提示词文字锁不住，而它们恰恰是「复刻」和「另拍一条」的分界线。
      let referenceVideos = raw.referenceVideos;
      if (!referenceVideos?.length && deps.previsVideoFor && raw.previsMode && raw.previsMode !== 'off') {
        const dna = await deps.prompts?.getShotDna(raw.shotId);
        const clip = await deps.previsVideoFor({
          projectId: raw.projectId, shotId: raw.shotId,
          startTime: dna?.start_time ?? 0, endTime: dna?.end_time ?? (raw.seconds ?? 0),
        });
        if (clip) {
          referenceVideos = [clip];
          ctx.log(`已附带 3D 预演参考视频（${raw.previsMode === 'full' ? '全片切段' : '逐镜'}）`);
        } else {
          // 说出来而不是静默跳过：用户选了预演却没带上，他有权知道
          ctx.log('没有找到这一镜的 3D 预演，本次不带参考视频');
        }
      }

      const input: VideoGenerateInput = {
        ...raw,
        model: raw.model,
        prompt,
        referenceVideos,
        extra: negative ? { ...(raw.extra ?? {}), negative_prompt: negative } : raw.extra,
      };
      const estimate = deps.gateway.estimateCents(input) ?? 0;
      // 幂等键绑任务 id 而不是时间：同一个任务重试时不会重复冻结。
      const freezeKey = `task:${ctx.task.id}:freeze`;
      const billing = raw.userId && deps.wallet ? { wallet: deps.wallet, userId: raw.userId } : null;

      if (billing && estimate > 0) {
        try {
          await billing.wallet.freeze(billing.userId, estimate, freezeKey,
            { type: 'task', id: ctx.task.id });
        } catch (err) {
          throw new TaskFailure(err instanceof Error ? err.message : '冻结失败', 'insufficient_balance');
        }
      }

      const releaseAll = async (memo: string) => {
        if (!billing || estimate <= 0) return;
        await billing.wallet.unfreeze(billing.userId, estimate, `${freezeKey}:release`,
          { type: 'task', id: ctx.task.id });
        ctx.log(`已全额解冻 ${(estimate / 100).toFixed(2)}：${memo}`);
      };

      // ---- 提交 ----
      let job: VideoJob;
      let providerName: string;
      try {
        const result = await deps.gateway.generate(input);
        job = result.job;
        providerName = result.binding.provider.name;
      } catch (err) {
        // 没建成任务 = 上游没开始算钱，全额放回。
        await releaseAll('提交被拒，上游未创建任务');
        throw new TaskFailure(err instanceof Error ? err.message : String(err), classifyProviderError(err));
      }

      // 提交成功与写库之间不放任何别的代码。
      await deps.persistJobId(ctx.task.id, providerName, job.jobId);
      ctx.log(`已提交 ${providerName} 任务 ${job.jobId}`);

      // ---- 轮询 ----
      const interval = deps.pollIntervalMs ?? 10_000;
      const deadline = Date.now() + (deps.pollTimeoutMs ?? 20 * 60_000);
      while (job.status === 'pending' || job.status === 'running') {
        if (ctx.shouldStop()) {
          // 不取消上游任务：它已经在跑、钱也已经在花，取消只会两头落空。
          // 让租约到期由回收器放回队列，下次接着轮询同一个 jobId。
          throw new TaskFailure('worker 正在停止，任务放回队列继续轮询', 'timeout');
        }
        if (Date.now() > deadline) {
          throw new TaskFailure(`轮询超过 ${Math.round((deps.pollTimeoutMs ?? 1_200_000) / 60_000)} 分钟仍未出片（${job.jobId}）`, 'timeout');
        }
        await deps.sleep(interval);
        await ctx.heartbeat();
        job = await deps.gateway.status(job.jobId, providerName);
      }

      if (job.status !== 'completed') {
        // 实测：失败的生成不计费。所以这里全额解冻而不是扣款。
        await releaseAll(`上游报告 ${job.status}`);
        throw new TaskFailure(job.error || `上游任务 ${job.status}`, 'provider_unavailable');
      }

      // ---- 取回并存档 ----
      const bytes = await deps.gateway.download(job, providerName);
      const key = `projects/${raw.projectId}/shots/${raw.shotId}/${job.jobId}.mp4`;
      const stored = await deps.store.put(key, bytes, 'video/mp4');
      const assetId = await deps.registerAsset({
        projectId: raw.projectId, shotId: raw.shotId,
        key: stored.key, bytes: stored.bytes, seconds: input.seconds ?? 0,
      });

      // ---- 结算 ----
      // 上游给了真实成本就按真实的扣，没给就按预估。差额解冻。
      const actual = job.costCents ?? estimate;
      if (billing && estimate > 0) {
        await billing.wallet.chargeFrozen(billing.userId, actual, `task:${ctx.task.id}:charge`,
          { type: 'task', id: ctx.task.id });
        if (estimate > actual) {
          await billing.wallet.unfreeze(billing.userId, estimate - actual, `${freezeKey}:remainder`,
            { type: 'task', id: ctx.task.id });
        }
      }

      return {
        provider: providerName,
        jobId: job.jobId,
        assetId,
        objectKey: stored.key,
        bytes: stored.bytes,
        estimateCents: estimate,
        chargedCents: billing ? actual : 0,
      };
    },
  };
}
