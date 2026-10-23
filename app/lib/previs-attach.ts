/**
 * 出片时这一段要不要附带本段 3D 预演作参考视频。
 *
 * 纯函数：只看模型、故事模式、预演状态、本段有没有匹配镜头和用户开关，
 * 给出「能不能带、这次带不带、带不了为什么、能不能一键去补」。界面、提示词、请求指纹都以它为准。
 */
export type PrevisAttachAction = 'go-previs';
export interface PrevisAttachInput {
  /** 当前模型收不收参考视频（referenceStyle === 'omni'）。 */
  omni: boolean;
  /** 保留原剧情模式；重写新故事时原片预演对不上新剧情。 */
  preserve: boolean;
  /** 有没有读到做好的预演（浏览器版或本机助手版）。 */
  previsReady: boolean;
  /** 预演做完后分析又改过。 */
  stale: boolean;
  /** 本段在预演里找到了对应镜头。 */
  matched: boolean;
  /** 本浏览器能导出的格式；不知道就是 undefined（到提交时再说）。 */
  exportFormat?: 'mp4' | 'webm';
  /** 用户这一段的选择；没选过 = undefined = 默认开。 */
  choice?: boolean;
}
export interface PrevisAttachState { attachable: boolean; on: boolean; reason: string; action?: PrevisAttachAction }

export const PREVIS_ATTACH_REASONS = {
  model: '这个模型不收参考视频',
  rewrite: '重写新故事模式下预演和新剧情对不上',
  missing: '这一段还没做预演',
  stale: '预演做完后分析改过，请重新生成预演',
  webm: '当前浏览器只能导出 WebM',
} as const;

export function resolvePrevisAttach(input: PrevisAttachInput): PrevisAttachState {
  const off = (reason: string, action?: PrevisAttachAction): PrevisAttachState => ({ attachable: false, on: false, reason, ...(action ? { action } : {}) });
  if (!input.omni) return off(PREVIS_ATTACH_REASONS.model);
  if (!input.preserve) return off(PREVIS_ATTACH_REASONS.rewrite);
  if (!input.previsReady) return off(PREVIS_ATTACH_REASONS.missing, 'go-previs');
  if (input.stale) return off(PREVIS_ATTACH_REASONS.stale, 'go-previs');
  if (!input.matched) return off(PREVIS_ATTACH_REASONS.missing, 'go-previs');
  if (input.exportFormat === 'webm') return off(PREVIS_ATTACH_REASONS.webm);
  return { attachable: true, on: input.choice ?? true, reason: '' };
}

// 每个项目分别记住；只是本机的使用习惯，不跟项目走。
export const previsAttachKey = (projectId: string) => `mirror:previs-attach:${projectId}`;
export function loadPrevisAttach(projectId: string): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(previsAttachKey(projectId)) || '{}'); } catch { return {}; }
}
export function savePrevisAttach(projectId: string, value: Record<string, boolean>) {
  try { localStorage.setItem(previsAttachKey(projectId), JSON.stringify(value)); } catch { /* 存不下本次仍然生效 */ }
}
