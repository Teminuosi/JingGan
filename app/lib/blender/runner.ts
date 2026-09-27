// Blender 执行器。
//
// 两个实现：
//  - MockBlenderRunner：不需要装 Blender，产出占位文件 + 真实的空间描述文字。
//  - SubprocessBlenderRunner：调真的 blender --background --python。
//
// 关键点：**空间描述（blocking / cameraPath）是本地从场景算出来的，不依赖渲染。**
// 也就是说即使没装 Blender，Mock 也能给出真实有效的空间关系文字喂给视频模型——
// 那部分价值是白拿的。渲染出来的图是锦上添花（能当参考图传给模型），不是必需。
//
// TODO_REAL_PROVIDER_INTEGRATION：SubprocessBlenderRunner 未在真实 Blender 上跑过。

import {
  buildFilmScene, buildScene, describeBlocking, describeCameraPath, validateScene,
  type BlenderResult, type BlenderScene,
} from './protocol';
import { generateBlenderPython } from './python';
import type { ShotDna } from '../shot-dna/types';

export interface BlenderRunner {
  readonly name: string;
  render(scene: BlenderScene): Promise<BlenderResult>;
}

/** 渲染一个镜头的完整流程：建场景 → 校验 → 渲染 → 产出描述。 */
export async function previsShot(
  dna: ShotDna,
  runner: BlenderRunner,
  opts: { aspectRatio: string },
): Promise<{ result: BlenderResult; scene: BlenderScene; issues: ReturnType<typeof validateScene> }> {
  const scene = buildScene(dna, { aspectRatio: opts.aspectRatio });
  const issues = validateScene(scene);

  // 场景有硬错误就别渲了——渲染是这条管线里最慢的一步，
  // 拿一个相机在墙外的场景渲十分钟，得到的一定是废图。
  const fatal = issues.filter((i) => i.code === 'camera_outside' || i.code === 'empty_scene' || i.code === 'bad_focal');
  if (fatal.length) {
    throw new Error(`3D 场景不合法，已跳过渲染：${fatal.map((i) => i.message).join('；')}`);
  }

  const result = await runner.render(scene);
  return {
    result: {
      ...result,
      // 描述一律由本地计算覆盖：它是确定的，不该受渲染器实现影响。
      blocking: describeBlocking(scene),
      cameraPath: describeCameraPath(scene),
    },
    scene,
    issues,
  };
}

/**
 * 全片预演：所有镜头拼成一条时间轴，渲成一条 MP4。
 * 与逐镜预演共用同一套摆位和渲染逻辑，只是场景是拼出来的。
 */
export async function previsFilm(
  shots: ShotDna[],
  runner: BlenderRunner,
  opts: { aspectRatio: string },
): Promise<{ result: BlenderResult; scene: BlenderScene; issues: ReturnType<typeof validateScene> }> {
  const scene = buildFilmScene(shots, { aspectRatio: opts.aspectRatio });
  const issues = validateScene(scene);
  const fatal = issues.filter((i) => i.code === 'camera_outside' || i.code === 'empty_scene' || i.code === 'bad_focal');
  if (fatal.length) {
    throw new Error(`全片 3D 场景不合法，已跳过渲染：${fatal.map((i) => i.message).join('；')}`);
  }
  const result = await runner.render(scene);
  return {
    result: { ...result, blocking: describeBlocking(scene), cameraPath: describeCameraPath(scene) },
    scene,
    issues,
  };
}

export interface MockOptions {
  /** 模拟渲染耗时。测试里设 0。 */
  renderMs?: number;
  /** 产物写到哪儿。不传就只返回 key，不落盘。 */
  writeFile?: (key: string, bytes: Uint8Array) => Promise<void>;
}

/**
 * Mock 渲染器。
 *
 * 规格第卅六章：缺真实环境时不能因此停下，要把接口、调用链、重试、计费钩子都做出来。
 * 它产出的是占位 PNG 字节，但 artifacts 清单、key 命名、返回结构与真实渲染完全一致，
 * 所以上层（handler、asset 登记、提示词引用）的代码在换真渲染时一行都不用改。
 */
export class MockBlenderRunner implements BlenderRunner {
  readonly name = 'mock-blender';
  constructor(private readonly opts: MockOptions = {}) {}

  async render(scene: BlenderScene): Promise<BlenderResult> {
    if (this.opts.renderMs) await new Promise((r) => setTimeout(r, this.opts.renderMs));

    const artifacts: BlenderResult['artifacts'] = [];
    for (const output of scene.outputs) {
      const ext = output === 'path_animation' ? 'mp4' : 'png';
      const key = `blender/${scene.shotId}/${output}.${ext}`;
      if (this.opts.writeFile) {
        await this.opts.writeFile(key, new TextEncoder().encode(`MOCK_BLENDER:${scene.shotId}:${output}`));
      }
      artifacts.push({
        kind: output,
        key,
        contentType: ext === 'mp4' ? 'video/mp4' : 'image/png',
      });
    }

    return {
      shotId: scene.shotId,
      artifacts,
      blocking: '',      // 由 previsShot 用本地计算覆盖
      cameraPath: '',
      renderSeconds: 0,
    };
  }
}

export interface SubprocessOptions {
  /** blender 可执行文件路径。 */
  blenderPath: string;
  /** 工作目录，脚本与产物都写在这里。 */
  workDir: string;
  /** 由调用方注入，避免这个文件依赖 node:child_process（它也要能被 Workers 端引用）。 */
  exec: (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  writeFile: (path: string, content: string) => Promise<void>;
  readOutput: (dir: string) => Promise<Array<{ name: string; bytes: Uint8Array }>>;
  /**
   * 把 PNG 序列编成 MP4。
   *
   * Blender 5.x 的 image_settings 里已经没有 FFMPEG 了，原生导视频这条路没了，
   * 所以渲的是 PNG 序列，编码交给外面。这反而更可控：帧率、编码、像素格式都是我们定的，
   * 也不用再担心下一个大版本又把哪个枚举改名。
   */
  encodeFrames: (framesDir: string, fps: number, outPath: string) => Promise<{ bytes: number }>;
  /** 渲染超时（毫秒）。Blender 卡住过就不会自己退。 */
  timeoutMs?: number;
  /** 非致命异常的去处（例如活干完了但退出码异常）。 */
  onWarn?: (message: string) => void;
}

/** 真实渲染器。Node 侧注入 exec/fs 能力，本文件本身不 import 任何 Node API。 */
export class SubprocessBlenderRunner implements BlenderRunner {
  readonly name = 'blender';
  constructor(private readonly opts: SubprocessOptions) {}

  async render(scene: BlenderScene): Promise<BlenderResult> {
    const dir = `${this.opts.workDir}/${scene.shotId}`;
    const scriptPath = `${dir}/previs.py`;
    await this.opts.writeFile(scriptPath, generateBlenderPython(scene, { outputDir: dir }));

    const t0 = Date.now();
    const { code, stdout, stderr } = await this.opts.exec(
      this.opts.blenderPath,
      ['--background', '--python', scriptPath, '--python-exit-code', '1'],
      dir,
    );
    // 成不成功**只看脚本自己留下的完成证据**，不看退出码。
    //
    // 两个方向都栽过：
    //  - 脚本抛了 Python 异常，Blender 仍然返回 0 → 一次「什么都没渲出来」被当成成功；
    //  - 1440 帧全渲完、result.json 也写了，Blender 在退出阶段崩了（Windows 0xC0000142）
    //    → 一次完整的成功被当成失败，整条管线跟着停掉。
    //
    // result.json 是脚本在全部渲染完成后最后写的，它在就说明活干完了。
    // 退出码降级成日志信息：值得记一笔，但不该左右判定。
    const files = await this.opts.readOutput(dir);
    const finished = files.some((f) => f.name === 'result.json') || stdout.includes('BLENDER_DONE');
    if (!finished) {
      const tail = (stderr || stdout).slice(-900);
      throw new Error(`Blender 渲染失败（退出码 ${code}，脚本未跑完）：${tail}`);
    }

    const artifacts: BlenderResult['artifacts'] = [];
    if (code !== 0) {
      // 活干完了但进程退出异常。记下来，别让它悄悄过去——
      // 如果哪天变成「有时候产物也缺」，这行日志就是唯一的线索。
      this.opts.onWarn?.(`Blender 渲染已完成，但进程退出码为 ${code}（产物齐全，按成功处理）`);
    }

    // 有帧序列就先编码成 mp4——这才是要喂给视频模型的那个参考视频。
    // 判断依据是 result.json 里的清单，不是 stdout：进程崩在退出阶段时 stdout 可能是空的。
    const manifest = files.find((f) => f.name === 'result.json');
    const produced = manifest
      ? (() => {
          try { return (JSON.parse(new TextDecoder().decode(manifest.bytes)).artifacts ?? []) as string[]; }
          catch { return []; }
        })()
      : [];
    if (produced.includes('frames/') || stdout.includes('frames/')) {
      const mp4 = `${dir}/previs.mp4`;
      const { bytes } = await this.opts.encodeFrames(`${dir}/frames`, scene.fps, mp4);
      if (!bytes) throw new Error('帧序列编码后是空文件，预演视频没生成出来');
      artifacts.push({
        kind: 'path_animation',
        key: `blender/${scene.shotId}/previs.mp4`,
        contentType: 'video/mp4',
      });
    }

    for (const f of files) {
      if (f.name === 'result.json' || f.name === 'previs.py' || f.name === 'previs.mp4') continue;
      if (!/\.(png|mp4)$/.test(f.name)) continue;
      artifacts.push({
        kind: f.name.replace(/\.(png|mp4)$/, ''),
        key: `blender/${scene.shotId}/${f.name}`,
        contentType: f.name.endsWith('.mp4') ? 'video/mp4' : 'image/png',
      });
    }

    return {
      shotId: scene.shotId,
      artifacts,
      blocking: '',
      cameraPath: '',
      renderSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    };
  }
}
