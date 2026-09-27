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
