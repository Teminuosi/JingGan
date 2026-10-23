'use client';

/**
 * 需要用户点头的确认。
 *
 * 原来这几处用的是 window.confirm——系统原生弹窗，长得像 2005 年的网页报错，
 * 而它们恰好都出现在最要紧的时刻：即将真实扣费、上次请求可能已扣费要不要再提交一次。
 * 产品在这几秒钟里要显得可信，用系统弹窗是自毁。
 *
 * 这里只做一个「桥」：lib 层（不是 React 组件）也能发起确认，由挂在应用里的 ConfirmHost 负责渲染。
 * 宿主没挂上时退回 window.confirm，宁可难看也不能把付费动作静默放行。
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** 确认按钮文案，写清楚点下去会发生什么，别只写「确定」。 */
  confirmLabel: string;
  cancelLabel?: string;
  /** 会花钱或不可逆时置为 true，按钮走警示配色。 */
  danger?: boolean;
}

type Handler = (request: ConfirmRequest) => Promise<boolean>;
let handler: Handler | null = null;

export function setConfirmHandler(next: Handler | null) {
  handler = next;
}

export async function confirmAction(request: ConfirmRequest): Promise<boolean> {
  if (!handler) return typeof window !== 'undefined' && window.confirm(`${request.title}\n\n${request.message}`);
  return handler(request);
}

/**
 * 多于「是 / 否」的选择（例如 3D 上传失败：重试 / 不带 3D 继续 / 取消提交）。
 * actions 按从左到右的显示顺序给，最后一个是主按钮（默认聚焦）；cancelId 是 Esc、点遮罩、点关闭时返回的那个 id。
 * 宿主没挂上时退回 window.confirm：确定 = 主按钮，取消 = cancelId，中间的选项选不到但绝不误放行。
 */
export interface ChoiceAction { id: string; label: string; danger?: boolean }
export interface ChoiceRequest { title: string; message: string; actions: ChoiceAction[]; cancelId: string }

type ChoiceHandler = (request: ChoiceRequest) => Promise<string>;
let choiceHandler: ChoiceHandler | null = null;

export function setChoiceHandler(next: ChoiceHandler | null) {
  choiceHandler = next;
}

export async function confirmChoice(request: ChoiceRequest): Promise<string> {
  if (choiceHandler) return choiceHandler(request);
  const primary = request.actions[request.actions.length - 1];
  if (!primary || primary.id === request.cancelId || typeof window === 'undefined' || typeof window.confirm !== 'function') return request.cancelId;
  return window.confirm(`${request.title}\n\n${request.message}\n\n确定 = ${primary.label}；取消 = ${request.actions.find(action => action.id === request.cancelId)?.label ?? '取消'}`) ? primary.id : request.cancelId;
}
