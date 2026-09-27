// 其余任务类型的 handler。
//
// 出片 handler 在 video.ts 里单独一份，因为它是唯一花大钱的一步，逻辑也最重。
// 这里是另外五类：preprocess / analyze / keyframe / blender / qa / merge。
//
// 共同的设计：**所有外部能力都通过依赖注入进来**（FFmpeg、Provider、对象存储、数据库读写）。
// handler 自己不 import 任何 Node API，也不直接连数据库——
// 这样它们能在测试里用假实现驱动，不需要真的装 FFmpeg 或花钱调模型。

import type { ShotDna } from '../../shot-dna/types';
import type { AnalysisProvider, ImageProvider, ProviderCredentials } from '../../providers/types';
import { isProviderError } from '../../providers/types';
import { compileShotPrompt, type CompileContext } from '../../prompt-compiler';
import { previsFilm, previsShot, type BlenderRunner } from '../../blender/runner';
import { buildScene, describeBlocking, describeCameraPath } from '../../blender/protocol';
import { structuralQa, visualQa, mergeReports, type ClipProbe, type QaReport, type VisualQaInput } from '../../qa/report';
import { TaskFailure, type HandlerContext, type TaskHandler } from '../runtime';
import type { ObjectStore } from '../../storage/object-store';
import { classifyProviderError } from './video';

/** 各 handler 共用的仓储访问。由 worker 进程注入真实实现。 */
export interface PipelineRepo {
  getShotDna(shotId: string): Promise<ShotDna | null>;
  saveShotDna(dna: ShotDna): Promise<void>;
  listShotDna(projectId: string): Promise<ShotDna[]>;
  /** 提示词编译上下文（角色表、风格锁）。 */
  compileContext(projectId: string): Promise<CompileContext>;
  registerAsset(input: {
    projectId: string; shotId?: string; kind: string; key: string;
    contentType: string; bytes: number; duration?: number; meta?: unknown;
  }): Promise<string>;
  /** 按 kind 取某镜已产出的资产。拼接要用它拿全部成片。 */
  assetsOf(projectId: string, kind: string): Promise<Array<{ id: string; shotId: string; key: string; duration: number }>>;
  saveQaReport(report: QaReport): Promise<void>;
  /** 每一镜最新的质检结论。拼接前的闸门要用。 */
  latestQaOutcomes(projectId: string): Promise<Record<string, 'pass' | 'warn' | 'fail'>>;
  /** 某一镜最新的成片。质检自己去取，不靠编排器把 key 转运过来。 */
  latestClip(projectId: string, shotId: string): Promise<{ key: string } | null>;
  /** 记一笔任务输出，供下游读取。 */
  setShotPrompt(shotId: string, prompt: { text: string; template: string; version: string; fingerprint: string }): Promise<void>;
}

/** FFmpeg 能力。Node 侧用 subprocess 实现，测试里用假实现。 */
export interface FfmpegService {
  probe(key: string): Promise<ClipProbe>;
  /** 从源视频切出一个镜头。 */
  cut(sourceKey: string, start: number, end: number, outKey: string): Promise<{ key: string; bytes: number }>;
  /** 抽帧，返回 data URI，给质检和分析用。 */
  extractFrames(key: string, atSeconds: number[]): Promise<string[]>;
  /** 按顺序拼接。 */
  concat(keys: string[], outKey: string): Promise<{ key: string; bytes: number; durationSeconds: number }>;
}

// ---------- preprocess ----------

export interface PreprocessDeps {
  repo: PipelineRepo;
  ffmpeg: FfmpegService;
  /** 项目的源视频对象 key。 */
  sourceKeyOf: (projectId: string) => Promise<string>;
}

/**
 * 预处理：探测源视频元数据。
 *
 * 刻意不在这一步切片：切片要等分析出镜头边界之后才知道切在哪。
 * 老项目在浏览器里用 mediabunny 做这件事，搬到服务端是为了不受浏览器内存限制
 * （一条 10 分钟的源片在浏览器里切会直接把标签页撑崩）。
 */
export function createPreprocessHandler(deps: PreprocessDeps): TaskHandler {
  return {
    type: 'preprocess',
    async run(ctx: HandlerContext) {
      const { projectId } = JSON.parse(ctx.task.input_json || '{}') as { projectId: string };
      const sourceKey = await deps.sourceKeyOf(projectId);
      if (!sourceKey) throw new TaskFailure('项目没有源视频', 'internal');

      const probe = await deps.ffmpeg.probe(sourceKey);
      if (!(probe.durationSeconds > 0)) {
        throw new TaskFailure('源视频探测不到时长，文件可能损坏或格式不支持', 'provider_rejected');
      }
      ctx.log(`源视频 ${probe.durationSeconds}s ${probe.width}×${probe.height}`);
      return { sourceKey, ...probe };
    },
  };
}

// ---------- analyze ----------

export interface AnalyzeDeps {
  repo: PipelineRepo;
  provider: AnalysisProvider;
  creds: ProviderCredentials;
  model: string;
  /** 分析指令与 responseSchema 来自老项目的 prompts.ts / schemas.ts，由调用方传入。 */
  instruction: string;
  responseSchema?: unknown;
  /** 把模型返回的文本解析成 Shot DNA 列表。解析失败必须抛，不许吞。 */
  parse: (text: string, projectId: string) => ShotDna[];
  fps?: number;
  mediaResolution?: 'default' | 'high';
}

/**
 * 分析：源视频 → Shot DNA。
 *
 * 这一步的产物是后面所有东西的输入，所以宁可失败也不许产出半成品：
 * 解析不出来就抛，不要返回一个空的镜头列表让管线继续往下跑——
 * 那会让用户白等半小时最后拿到一条空片。
 */
export function createAnalyzeHandler(deps: AnalyzeDeps): TaskHandler {
  return {
    type: 'analyze',
    async run(ctx: HandlerContext) {
      const input = JSON.parse(ctx.task.input_json || '{}') as { projectId: string; videoDataUri?: string; videoFileUri?: string; mimeType?: string };

      let result;
      try {
        result = await deps.provider.analyze({
          model: deps.model,
          video: { dataUri: input.videoDataUri, fileUri: input.videoFileUri, mimeType: input.mimeType ?? 'video/mp4' },
          instruction: deps.instruction,
          fps: deps.fps,
          mediaResolution: deps.mediaResolution,
          responseSchema: deps.responseSchema,
        }, deps.creds);
      } catch (err) {
        throw new TaskFailure(err instanceof Error ? err.message : String(err), classifyProviderError(err));
      }
      await ctx.heartbeat();

      let shots: ShotDna[];
      try {
        shots = deps.parse(result.text, input.projectId);
      } catch (err) {
        // 模型给了东西但不是我们要的形状。重试有意义（模型有随机性），
        // 但不能当成上游故障——分类成 unknown 让它走正常退避重试。
        throw new TaskFailure(`分析结果解析失败：${err instanceof Error ? err.message : String(err)}`, 'unknown');
      }
      if (!shots.length) throw new TaskFailure('分析没有产出任何镜头', 'unknown');

      for (const dna of shots) await deps.repo.saveShotDna(dna);
      ctx.log(`产出 ${shots.length} 个镜头，用了 ${result.promptTokens ?? '?'} 输入 / ${result.completionTokens ?? '?'} 输出 token`);

      return {
        shotCount: shots.length,
        shotIds: shots.map((s) => s.shot_id),
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        costCents: result.costCents,
      };
    },
  };
}

// ---------- keyframe ----------

export interface KeyframeDeps {
  repo: PipelineRepo;
  provider: ImageProvider;
  creds: ProviderCredentials;
  model: string;
  store: ObjectStore;
  /** 把 data URI 解成字节。Node 与 Workers 的实现不同，注入进来。 */
  decodeDataUri: (uri: string) => { bytes: ArrayBuffer; contentType: string };
  /** 没有 dataUri 只有 url 时用它取回。 */
  fetchUrl?: (url: string) => Promise<{ bytes: ArrayBuffer; contentType: string }>;
  size?: string;
}

/**
 * 关键帧：用 Prompt Compiler 的 keyframe-first 模板出一张首帧图。
 *
 * 这张图有两个用途：给用户预览（便宜，出错早发现），以及作为视频模型的首帧输入。
 * 第二个用途才是重点——首帧钉死了，整镜的形象和构图就稳了一半。
 */
export function createKeyframeHandler(deps: KeyframeDeps): TaskHandler {
  return {
    type: 'keyframe',
    async run(ctx: HandlerContext) {
      const input = JSON.parse(ctx.task.input_json || '{}') as { projectId: string; shotId: string };
      const dna = await deps.repo.getShotDna(input.shotId);
      if (!dna) throw new TaskFailure(`找不到镜头 ${input.shotId} 的 Shot DNA`, 'internal');

      const compiled = compileShotPrompt(dna, await deps.repo.compileContext(input.projectId), {
        templateName: 'keyframe-first',
      });
      if (compiled.dropped.length) {
        // 静默降级等于退款。丢了内容一定要说，而且要说丢了哪些。
        ctx.log(`提示词超长，已丢弃段落：${compiled.dropped.join('、')}`);
      }

      let result;
      try {
        result = await deps.provider.generate({
          model: deps.model,
          prompt: compiled.text,
          size: deps.size,
          n: 1,
        }, deps.creds);
      } catch (err) {
        throw new TaskFailure(err instanceof Error ? err.message : String(err), classifyProviderError(err));
      }

      const image = result.images[0];
      if (!image) throw new TaskFailure('图片模型没有返回任何图', 'provider_unavailable');

      const payload = image.dataUri
        ? deps.decodeDataUri(image.dataUri)
        : await (async () => {
            if (!image.url || !deps.fetchUrl) throw new TaskFailure('图片既没有 dataUri 也取不回 url', 'provider_unavailable');
            return await deps.fetchUrl(image.url);
          })();

      const key = `projects/${input.projectId}/shots/${input.shotId}/keyframe-${compiled.fingerprint}.png`;
      const stored = await deps.store.put(key, payload.bytes, payload.contentType || 'image/png');
      const assetId = await deps.repo.registerAsset({
        projectId: input.projectId, shotId: input.shotId, kind: 'keyframe',
        key: stored.key, contentType: stored.contentType, bytes: stored.bytes,
        meta: { promptFingerprint: compiled.fingerprint, template: `${compiled.template}@${compiled.version}` },
      });

      return { assetId, objectKey: stored.key, promptFingerprint: compiled.fingerprint, costCents: result.costCents ?? 0 };
    },
  };
}

// ---------- blender ----------

export interface BlenderDeps {
  repo: PipelineRepo;
  runner: BlenderRunner;
  store: ObjectStore;
  /**
   * 这个项目的画幅，例如 '9:16'。预演必须按它渲。
   * 拿不到就让任务失败——渲一条画幅不对的参考视频，比不渲更糟：
   * 它会以「已按 3D 预演锁定」的名义把错的构图写进出片请求。
   */
  aspectRatioOf: (projectId: string) => Promise<string | undefined>;
}

/**
 * 3D 预演。
 *
 * 产出两样东西，重要性相反于直觉：
 *  1. 空间关系文字（blocking / cameraPath）—— **这才是主产物**，会写进出片提示词。
 *  2. 渲染图 —— 附加价值，能当参考图，也能给用户看。
 *
 * 所以即使渲染失败，只要场景建起来了，文字描述仍然有效。
 * 但这里选择整体失败：一个渲不出来的场景多半本身就有问题，
 * 带着一份可疑的空间描述往下跑，只会把问题推到更贵的出片那一步。
 */
export function createBlenderHandler(deps: BlenderDeps): TaskHandler {
  return {
    type: 'blender',
    async run(ctx: HandlerContext) {
      const input = JSON.parse(ctx.task.input_json || '{}') as { projectId: string; shotId?: string; mode?: string };

      // 没有 shotId = 全片预演：把所有镜头拼成一条时间轴渲一条 MP4。
      // 这条 MP4 才是要喂给视频模型的参考视频，出片时按镜切段。
      if (!input.shotId) {
        const shots = await deps.repo.listShotDna(input.projectId);
        if (!shots.length) throw new TaskFailure('还没有镜头，无法做全片预演', 'internal');
        const aspect = await deps.aspectRatioOf(input.projectId);
        if (!aspect) throw new TaskFailure('查不到这个项目的画幅，预演不能瞎猜一个比例去渲', 'internal');
        let film;
        try {
          film = await previsFilm(shots, deps.runner, { aspectRatio: aspect });
        } catch (err) {
          throw new TaskFailure(err instanceof Error ? err.message : String(err), 'spatial_wrong');
        }
        await ctx.heartbeat();
        for (const issue of film.issues) ctx.log(`场景提醒：${issue.message}`);
        if (film.scene.framingNote) ctx.log(`机位退让：${film.scene.framingNote}`);

        const assets: string[] = [];
        for (const artifact of film.result.artifacts) {
          assets.push(await deps.repo.registerAsset({
            projectId: input.projectId, kind: 'blender_preview',
            key: artifact.key, contentType: artifact.contentType, bytes: 0,
            meta: { output: artifact.kind, mode: 'full', durationSeconds: film.scene.durationSeconds },
          }));
        }
        // 按镜头写回描述，已复核的同版数据不被规则模板覆盖。
        for (const dna of shots) {
          if (dna.complexity.previs?.reviewed_revision === dna.revision && dna.revision !== undefined) continue;
          const shotScene = buildScene(dna, { aspectRatio: aspect });
          await deps.repo.saveShotDna({
            ...dna,
            complexity: {
              ...dna.complexity, needs_blender: true,
              previs: { blocking: describeBlocking(shotScene), camera_path: describeCameraPath(shotScene), rendered_at: Date.now() },
            },
          });
        }
        ctx.log(`全片预演完成，${shots.length} 镜 / ${film.scene.durationSeconds}s，${film.result.renderSeconds}s 渲完`);
        return {
          mode: 'full', assets, shotCount: shots.length,
          durationSeconds: film.scene.durationSeconds,
          blocking: film.result.blocking, cameraPath: film.result.cameraPath,
          renderSeconds: film.result.renderSeconds, sceneIssues: film.issues,
        };
      }

      const dna = await deps.repo.getShotDna(input.shotId);
      if (!dna) throw new TaskFailure(`找不到镜头 ${input.shotId} 的 Shot DNA`, 'internal');

      if (dna.complexity.previs?.reviewed_revision === dna.revision && dna.revision !== undefined) {
        return { assets: [], reusedReviewedPreview: true, blocking: dna.complexity.previs.blocking, cameraPath: dna.complexity.previs.camera_path };
      }
      const shotAspect = await deps.aspectRatioOf(input.projectId);
      if (!shotAspect) throw new TaskFailure('查不到这个项目的画幅，预演不能瞎猜一个比例去渲', 'internal');
      let previs;
      try {
        previs = await previsShot(dna, deps.runner, { aspectRatio: shotAspect });
      } catch (err) {
        throw new TaskFailure(err instanceof Error ? err.message : String(err), 'spatial_wrong');
      }
      await ctx.heartbeat();

      for (const issue of previs.issues) ctx.log(`场景提醒：${issue.message}`);
      if (previs.scene.framingNote) ctx.log(`机位退让：${previs.scene.framingNote}`);

      const assets: string[] = [];
      for (const artifact of previs.result.artifacts) {
        const id = await deps.repo.registerAsset({
          projectId: input.projectId, shotId: input.shotId, kind: 'blender_preview',
          key: artifact.key, contentType: artifact.contentType, bytes: 0,
          meta: { output: artifact.kind },
        });
        assets.push(id);
      }

      // 把空间描述写回 Shot DNA，出片时 Prompt Compiler 直接读。
      await deps.repo.saveShotDna({
        ...dna,
        complexity: {
          ...dna.complexity,
          needs_blender: true,
          previs: {
            blocking: previs.result.blocking,
            camera_path: previs.result.cameraPath,
            rendered_at: Date.now(),
          },
        },
      });

      ctx.log(`3D 预演完成，${previs.result.renderSeconds}s，产出 ${assets.length} 个文件`);
      return {
        assets,
        blocking: previs.result.blocking,
        cameraPath: previs.result.cameraPath,
        renderSeconds: previs.result.renderSeconds,
        sceneIssues: previs.issues,
      };
    },
  };
}

// ---------- qa ----------

export interface QaDeps {
  repo: PipelineRepo;
  ffmpeg: FfmpegService;
  /** 视觉检查。没有配多模态模型时传 undefined，只做结构检查。 */
  inspect?: (input: { dna: ShotDna; frames: string[] }) => Promise<Omit<VisualQaInput, 'dna'>>;
  expectedResolution?: { width: number; height: number };
  /** 出片任务的产物 key。由编排层通过 input 传入。 */
}

/**
 * 质检。
 *
 * 顺序是刻意的：**先结构后视觉**。
 * 结构检查不花钱，能拦掉时长不对、文件损坏这类硬伤；
 * 只有结构过了才值得再花一次多模态模型的钱去看画面。
 */
export function createQaHandler(deps: QaDeps): TaskHandler {
  return {
    type: 'qa',
    async run(ctx: HandlerContext) {
      const input = JSON.parse(ctx.task.input_json || '{}') as { projectId: string; shotId: string; objectKey?: string };
      const dna = await deps.repo.getShotDna(input.shotId);
      if (!dna) throw new TaskFailure(`找不到镜头 ${input.shotId} 的 Shot DNA`, 'internal');

      // 成片 key 自己去查，而不是要求编排器在出片成功后回填到任务输入里。
      // 回填那条路要多一个组件、多一次写入，漏做的表现是「质检拿不到 key」——
      // 一个看起来像配置错误、实际是编排漏了一步的故障。资产表本来就是真相源，直接读它。
      const objectKey = input.objectKey ?? (await deps.repo.latestClip(input.projectId, input.shotId))?.key;
      if (!objectKey) throw new TaskFailure(`镜头 ${input.shotId} 还没有成片可检`, 'internal');

      const probe = await deps.ffmpeg.probe(objectKey);
      const structural = structuralQa({ dna, probe, expectedResolution: deps.expectedResolution });

      const reports = [structural];
      if (structural.verdict !== 'fail' && deps.inspect) {
        await ctx.heartbeat();
        // 抽三帧：开头、中间、结尾。够判断形象一致性和主要动作有没有演。
        const d = probe.durationSeconds;
        const frames = await deps.ffmpeg.extractFrames(objectKey, [0.5, d / 2, Math.max(0.5, d - 0.5)]);
        reports.push(visualQa({ dna, ...(await deps.inspect({ dna, frames })) }));
      } else if (structural.verdict === 'fail') {
        ctx.log('结构检查已判废，跳过视觉检查以省下这次调用');
      }

      const report = mergeReports(input.shotId, reports);
      await deps.repo.saveQaReport(report);
      ctx.log(`质检 ${report.verdict}，得分 ${report.score}`);

      // 质检本身成功了（它完成了自己的工作），判废与否写在输出里。
      // 不在这里抛失败：抛了就是「质检任务失败」，而真实情况是「出片任务的产物不合格」，
      // 两者该由重试引擎区分对待。
      return {
        verdict: report.verdict,
        score: report.score,
        primaryFailure: report.primaryFailure,
        findings: report.findings,
      };
    },
  };
}

// ---------- merge ----------

export interface MergeDeps {
  repo: PipelineRepo;
  ffmpeg: FfmpegService;
}

/**
 * 拼接成片。
 *
 * 唯一的硬要求：**顺序必须按镜号，不能按完成时间**。
 * 任务是并发跑的，第 7 镜可能比第 2 镜先完成；按完成顺序拼出来的片子是乱的，
 * 而这种错误看一眼成片就发现了，但那时钱已经全花完了。
 */
export function createMergeHandler(deps: MergeDeps): TaskHandler {
  return {
    type: 'merge',
    async run(ctx: HandlerContext) {
      const { projectId } = JSON.parse(ctx.task.input_json || '{}') as { projectId: string };
      const shots = await deps.repo.listShotDna(projectId);
      const clips = await deps.repo.assetsOf(projectId, 'video_result');

      // 每镜只要最新那一份。
      // 重试过的镜头会有好几份成片（第一次判废的那份也还在），
      // 全拼进去的结果是同一个镜头在成片里出现两遍——而这种错一眼就看得出，
      // 但那时钱已经花完了。assetsOf 按 created_at 正序返回，所以后写的覆盖先写的。
      const order = new Map(shots.map((s) => [s.shot_id, s.idx]));
      const latest = new Map<string, typeof clips[number]>();
      for (const c of clips) if (order.has(c.shotId)) latest.set(c.shotId, c);
      const ordered = [...latest.values()]
        .sort((a, b) => (order.get(a.shotId) ?? 0) - (order.get(b.shotId) ?? 0));

      if (!ordered.length) throw new TaskFailure('没有可拼接的成片', 'internal');
      if (ordered.length !== shots.length) {
        // 缺镜头就拼，等于交付一条残片。宁可失败，让用户知道缺了哪几镜。
        const missing = shots.filter((s) => !latest.has(s.shot_id)).map((s) => s.idx + 1);
        throw new TaskFailure(`还缺第 ${missing.join('、')} 镜的成片，不能拼接`, 'internal');
      }

      // 质检闸门。
      //
      // 依赖图本来就该挡住这里——但 qa 任务判废时自身仍是 succeeded
      // （它成功地完成了「判定」这件事），依赖满足了拼接就会往下走。
      // 所以必须在这里独立再查一遍最新结论：这是防止废镜头进成片的最后一道，
      // 而且它不依赖任何依赖边有没有被正确挂上。
      const outcomes = await deps.repo.latestQaOutcomes(projectId);
      const failed = shots.filter((s) => outcomes[s.shot_id] === 'fail');
      if (failed.length) {
        throw new TaskFailure(
          `第 ${failed.map((s) => s.idx + 1).join('、')} 镜没通过质检，不能拼进成片。`
          + '自动重试已用尽或仍在进行中，请在后台处理这几镜后再拼接',
          'internal',
        );
      }

      const outKey = `projects/${projectId}/final.mp4`;
      const result = await deps.ffmpeg.concat(ordered.map((c) => c.key), outKey);
      const assetId = await deps.repo.registerAsset({
        projectId, kind: 'final_video', key: result.key,
        contentType: 'video/mp4', bytes: result.bytes, duration: result.durationSeconds,
      });

      ctx.log(`成片 ${result.durationSeconds}s，${ordered.length} 个镜头`);
      return { assetId, objectKey: result.key, durationSeconds: result.durationSeconds, shotCount: ordered.length };
    },
  };
}

/** 供 worker 判断某个错误要不要换 Provider 重试。 */
export { isProviderError };
