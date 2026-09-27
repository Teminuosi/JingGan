// 自动质检。
//
// 规格第十七章。要解决的是这条产品链上最贵的一个问题：
// **视频模型有相当比例的产出是废的，但用户得看完才知道。**
// 一条 12 镜的片子如果有 3 镜废了，用户看到的是「花了钱、等了半小时、成片不能用」。
//
// 质检的作用不是判美丑，是判「这一镜有没有违反 Shot DNA 里写死的东西」——
// 时长对不对、该出现的人在不在、形象有没有漂、动作有没有演、有没有 pop-in。
// 这些都是可判定的，不需要审美。
//
// 分两层：
//  1. 结构检查（本文件）—— 不花钱，看元数据和 DNA 就能判，先跑。
//  2. 视觉检查（visual.ts）—— 抽帧交给多模态模型，要花钱，只在结构检查过了之后跑。
//
// 顺序是刻意的：结构检查能拦掉的（时长不对、文件损坏）没必要再花一次视觉检查的钱。

import { shotCharacterIds, shotDuration, type ShotDna } from '../shot-dna/types';
import type { FailureClass } from '../task/states';

export type QaVerdict = 'pass' | 'warn' | 'fail';

export interface QaFinding {
  code: string;
  verdict: QaVerdict;
  message: string;
  /** 判定为 fail 时必须给出失败分类，重试引擎据此决定换什么打法。 */
  failureClass?: FailureClass;
  /** 0–1，越高越确定。低置信度的 fail 会降级成 warn，避免误杀要重跑要花钱。 */
  confidence: number;
}

export interface QaReport {
  shotId: string;
  verdict: QaVerdict;
  score: number;
  findings: QaFinding[];
  /** 整体判定为 fail 时，最该归咎的那一类。重试引擎只看它。 */
  primaryFailure?: FailureClass;
}

/** 成片的客观元数据。由 FFmpeg 探测得到，不是猜的。 */
export interface ClipProbe {
  durationSeconds: number;
  width: number;
  height: number;
  bytes: number;
  frameRate?: number;
  /** 有没有音轨。要求出声的镜头没音轨就是废的。 */
  hasAudio?: boolean;
}

export interface StructuralQaInput {
  dna: ShotDna;
  probe: ClipProbe;
  /** 目标分辨率，用于判断上游有没有偷偷降档。 */
  expectedResolution?: { width: number; height: number };
  /** 时长容差（秒）。视频模型给的秒数常有零点几秒出入，不该判废。 */
  toleranceSeconds?: number;
}

/**
 * 结构检查。不花钱，先跑。
 *
 * 这一层的判定全部基于客观事实（文件元数据 vs DNA），没有任何模型参与，
 * 所以 confidence 一律给 1——它说时长不对，那就是真不对。
 */
export function structuralQa(input: StructuralQaInput): QaReport {
  const { dna, probe } = input;
  const findings: QaFinding[] = [];
  const expected = shotDuration(dna);
  const tolerance = input.toleranceSeconds ?? 0.6;

  // ---- 文件本身 ----
  if (probe.bytes < 1024) {
    findings.push({
      code: 'empty_file', verdict: 'fail', confidence: 1,
      failureClass: 'provider_unavailable',
      message: `成片只有 ${probe.bytes} 字节，基本可以断定是空文件或下载被截断`,
    });
  }
  if (!(probe.durationSeconds > 0)) {
    findings.push({
      code: 'no_duration', verdict: 'fail', confidence: 1,
      failureClass: 'provider_unavailable',
      message: '成片探测不到时长，文件多半损坏',
    });
  }

  // ---- 时长 ----
  // 时长不对是最要命的：拼接时会整条错位，后面每一镜都对不上。
  const delta = +(probe.durationSeconds - expected).toFixed(2);
  if (probe.durationSeconds > 0 && Math.abs(delta) > tolerance) {
    findings.push({
      code: 'duration_mismatch',
      // 短了比长了严重：短了拼不满，长了还能裁。
      verdict: delta < 0 ? 'fail' : 'warn',
      confidence: 1,
      failureClass: 'provider_rejected',
      message: `要求 ${expected} 秒，实际 ${probe.durationSeconds} 秒（${delta > 0 ? '多' : '少'} ${Math.abs(delta)} 秒）`,
    });
  }

  // ---- 分辨率 ----
  if (input.expectedResolution) {
    const { width, height } = input.expectedResolution;
    if (probe.width && probe.height && (probe.width < width || probe.height < height)) {
      findings.push({
        code: 'resolution_downgrade', verdict: 'warn', confidence: 1,
        message: `要的是 ${width}×${height}，拿到 ${probe.width}×${probe.height}，上游可能降了档`,
      });
    }
    // 画幅比错了不能靠缩放救，构图整个是错的
    const wantRatio = width / height;
    const gotRatio = probe.width && probe.height ? probe.width / probe.height : wantRatio;
    if (Math.abs(wantRatio - gotRatio) > 0.05) {
      findings.push({
        code: 'aspect_mismatch', verdict: 'fail', confidence: 1,
        failureClass: 'provider_rejected',
        message: `画幅比不对：要 ${wantRatio.toFixed(2)}，拿到 ${gotRatio.toFixed(2)}。缩放救不回构图`,
      });
    }
  }

  // ---- 声音 ----
  if (dna.dialogue.text.trim() && probe.hasAudio === false) {
    findings.push({
      code: 'missing_audio', verdict: 'warn', confidence: 1,
      message: '这一镜有对白，但成片没有音轨',
    });
  }

  return finalize(dna.shot_id, findings);
}

/** 视觉检查的输入：由多模态模型看抽帧后给出的结构化判断。 */
export interface VisualQaInput {
  dna: ShotDna;
  /** 模型对每个角色是否在画面里的判断。 */
  charactersPresent: Record<string, boolean>;
  /** 与参考图的形象一致度，0–1。没有参考图时不传。 */
  identityMatch?: Record<string, number>;
  /** 模型判断的实际景别，用来和 DNA 里写的对照。 */
  observedShotSize?: string;
  /** 逐拍动作有没有演到。键是 action_timeline 的下标。 */
  actionsPerformed?: Record<number, boolean>;
  /** 有没有角色凭空出现。 */
  popInDetected?: boolean;
  /** 明显瑕疵（多手、穿模、文字水印）。 */
  artifacts?: string[];
  /** 模型自己对这份判断的把握，0–1。它不确定时我们也不该确定。 */
  modelConfidence?: number;
}

/**
 * 视觉检查。
 *
 * 关键设计：**模型的判断一律带 confidence，低置信度的 fail 降级成 warn**。
 * 因为每一次误判 fail 都意味着重跑一次，重跑就是真金白银。
 * 宁可放过一个可疑的，也不要把一个好镜头判死再花一份钱重来。
 */
export function visualQa(input: VisualQaInput): QaReport {
  const { dna } = input;
  const findings: QaFinding[] = [];
  const conf = input.modelConfidence ?? 0.8;

  // ---- 该在的人在不在 ----
  for (const id of shotCharacterIds(dna)) {
    if (input.charactersPresent[id] === false) {
      findings.push({
        code: 'character_missing', verdict: 'fail', confidence: conf,
        failureClass: 'motion_wrong',
        message: `${id} 应该在这一镜里，但画面中没有`,
      });
    }
  }

  // ---- 形象漂移 ----
  for (const [id, match] of Object.entries(input.identityMatch ?? {})) {
    if (match < 0.5) {
      findings.push({
        code: 'identity_drift', verdict: 'fail', confidence: conf,
        failureClass: 'identity_drift',
        message: `${id} 与参考图相似度只有 ${(match * 100).toFixed(0)}%，形象崩了`,
      });
    } else if (match < 0.7) {
      findings.push({
        code: 'identity_weak', verdict: 'warn', confidence: conf,
        message: `${id} 与参考图相似度 ${(match * 100).toFixed(0)}%，偏低`,
      });
    }
  }

  // ---- 景别 ----
  if (input.observedShotSize && dna.camera.shot_size !== 'unknown'
      && input.observedShotSize !== dna.camera.shot_size) {
    findings.push({
      code: 'framing_wrong', verdict: 'warn', confidence: conf * 0.8,
      failureClass: 'camera_wrong',
      message: `要的是 ${dna.camera.shot_size}，画面看起来是 ${input.observedShotSize}`,
    });
  }

  // ---- 动作有没有演 ----
  const missed = Object.entries(input.actionsPerformed ?? {})
    .filter(([, done]) => !done)
    .map(([i]) => Number(i));
  if (missed.length) {
    const half = missed.length >= Math.max(1, dna.action_timeline.length / 2);
    findings.push({
      code: 'action_missing',
      // 漏一两拍还能忍，漏一半就是没照剧本演
      verdict: half ? 'fail' : 'warn',
      confidence: conf,
      failureClass: 'motion_wrong',
      message: `第 ${missed.map((i) => i + 1).join('、')} 拍动作没演出来（共 ${dna.action_timeline.length} 拍）`,
    });
  }

  // ---- pop-in ----
  if (input.popInDetected) {
    findings.push({
      code: 'popin', verdict: 'fail', confidence: conf,
      failureClass: 'popin',
      message: '有角色在画面中凭空出现，没有入画过程',
    });
  }

  // ---- 瑕疵 ----
  if (input.artifacts?.length) {
    findings.push({
      code: 'artifacts', verdict: 'warn', confidence: conf,
      failureClass: 'minor_artifact',
      message: `画面瑕疵：${input.artifacts.join('、')}`,
    });
  }

  return finalize(dna.shot_id, findings);
}

/** 合并结构检查与视觉检查。任一为 fail 即 fail。 */
export function mergeReports(shotId: string, reports: QaReport[]): QaReport {
  return finalize(shotId, reports.flatMap((r) => r.findings));
}

/**
 * 汇总。
 *
 * 置信度低于 0.6 的 fail 降级成 warn —— 这条规则是整个质检层最重要的一行：
 * 没有它，一个爱说「不确定」的模型会把用户的钱一次次烧在重跑上。
 */
function finalize(shotId: string, raw: QaFinding[]): QaReport {
  const findings = raw.map((f) =>
    f.verdict === 'fail' && f.confidence < 0.6
      ? { ...f, verdict: 'warn' as const, message: `${f.message}（模型把握不足，降级为提醒而非重跑）` }
      : f);

  const fails = findings.filter((f) => f.verdict === 'fail');
  const warns = findings.filter((f) => f.verdict === 'warn');
  const verdict: QaVerdict = fails.length ? 'fail' : warns.length ? 'warn' : 'pass';

  // 分数只用于排序和展示，不参与判定——判定看 verdict。
  const score = Math.max(0, +(1 - fails.length * 0.4 - warns.length * 0.1).toFixed(2));

  // 最该归咎的那一类：取置信度最高的 fail。
  const primary = [...fails].sort((a, b) => b.confidence - a.confidence)[0];

  return { shotId, verdict, score, findings, primaryFailure: primary?.failureClass };
}
