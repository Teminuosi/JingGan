// 浏览器预演的数据层：把每镜动作计划拼成一条「片子」，按全片时间或镜内时间取画面状态。
// 计算全部来自 worker/previs/kinematics.mjs（与 Blender 逐帧对照过），这里只做类型和时间换算。
import { preparePlan, objectsAt, cameraAt, frameCount, motionCheck, motionIssues, verticalFov } from '../../../worker/previs/kinematics.mjs';

export const FPS = 24;
export type Vec3 = [number, number, number];
export type Mat3 = number[];
export interface PrevisObject { name: string; shape: string; color: Vec3; position: Vec3; rotation: Mat3; scale: Vec3; visible: boolean }
export interface PrevisCamera { position: Vec3; target: Vec3; roll: number; lens: number }
// 动作计划结构由 worker/previs/contract.mjs 校验，这里不重复声明全部字段。
export type MotionPlan = { duration: number; actors: unknown[]; props: unknown[]; camera: unknown[] } & Record<string, unknown>;
export interface MotionCheck { frames: number; fps: number; nonfinite: number; max_limb_length_change: number; max_unreachable_target_m: number; attachment_count: number; attachment_switches: unknown[] }

export interface FilmShot { index: number; shotIndex: number; beatId: string; start: number; end: number; frames: number; plan: MotionPlan }
export interface Film { shots: FilmShot[]; width: number; height: number }

type Prepared = { plan: unknown };
const prepared = new WeakMap<MotionPlan, Prepared>();
const prep = (plan: MotionPlan) => {
  let value = prepared.get(plan);
  if (!value) { value = { plan: preparePlan(plan) }; prepared.set(plan, value); }
  return value.plan;
};

export const shotFrames = (start: number, end: number) => frameCount(start, end, FPS) as number;
export const filmFrames = (film: Film) => film.shots.reduce((sum, shot) => sum + shot.frames, 0);

/** 第 frame 帧（从 0 起）落在哪一镜、镜内第几秒。与 Blender 每镜 t=(帧号-1)/24 一致。 */
export function locate(film: Film, frame: number) {
  let rest = Math.max(0, Math.min(frame, filmFrames(film) - 1));
  for (const shot of film.shots) {
    if (rest < shot.frames) return { shot, local: rest / FPS };
    rest -= shot.frames;
  }
  const last = film.shots.at(-1)!;
  return { shot: last, local: (last.frames - 1) / FPS };
}

export function stateAt(plan: MotionPlan, local: number) {
  const p = prep(plan);
  return { objects: objectsAt(p, local) as PrevisObject[], camera: cameraAt(p, local) as PrevisCamera };
}

export const fovFor = (lens: number, width: number, height: number) => verticalFov(lens, width, height) as number;

/** 与 Blender 版同口径的本地检查，返回 issues 供界面标「需复看」。 */
export function checkShot(plan: MotionPlan, frames: number) {
  const check = motionCheck(plan, frames, FPS) as MotionCheck;
  return { check, issues: motionIssues(check) as string[] };
}

/** 原片长边缩到 960、取偶数，与本机助手的渲染尺寸规则一致。 */
export function renderSize(width: number, height: number) {
  const scale = 960 / Math.max(width, height);
  const even = (v: number) => Math.max(2, Math.round(v * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}
