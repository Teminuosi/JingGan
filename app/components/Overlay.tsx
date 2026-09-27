'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * 所有弹层的统一外壳。
 *
 * 在这之前六个弹层各写各的：面板底色有 #0c1a16 / #091612 / #091713 三种，遮罩有 black/55、/70、/75，
 * 边框 white/9、/12、/15，z-index 有 50 和 100，关闭按钮有的带边框有的是裸图标。
 * 单看每个都还行，连着开两个就露馅——这类不一致最伤「这是一个成品」的感觉。
 * 这里把这些定死在一处，以后新加弹层只能从这里长出来。
 */

const OVERLAY = 'fixed inset-0 z-50 bg-[#040b09]/80 backdrop-blur-sm';
const PANEL = 'border-white/12 bg-[#0c1a16] text-white/80 shadow-2xl shadow-black/60';
const SIZES = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' } as const;

function Head({ eyebrow, title, description, onClose, titleId }: {
  eyebrow?: string; title: string; description?: ReactNode; onClose: () => void; titleId: string;
}) {
  return <div className="flex items-start justify-between gap-4">
    <div className="min-w-0">
      {eyebrow && <p className="text-[10px] font-semibold tracking-[0.18em] text-emerald-200/50">{eyebrow}</p>}
      <h2 id={titleId} className={`${eyebrow ? 'mt-2 ' : ''}text-xl font-semibold tracking-tight text-white/90`}>{title}</h2>
      {description && <div className="mt-1.5 text-xs leading-5 text-white/45">{description}</div>}
    </div>
    <button type="button" onClick={onClose} aria-label={`关闭${title}`}
      className="shrink-0 rounded-xl border border-white/8 p-2 text-white/45 transition hover:bg-white/5 hover:text-white/90">
      <X size={17} />
    </button>
  </div>;
}

/** 居中弹窗。点遮罩关闭；内容区自己滚动，页面不跟着滚。 */
export function Modal({ open, onClose, title, eyebrow, description, size = 'md', footer, children }: {
  open: boolean; onClose: () => void; title: string; eyebrow?: string; description?: ReactNode;
  size?: keyof typeof SIZES; footer?: ReactNode; children: ReactNode;
}) {
  if (!open) return null;
  const titleId = `modal-${title}`;
  return <div className={`${OVERLAY} grid place-items-center p-4`} role="dialog" aria-modal="true" aria-labelledby={titleId}
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`flex max-h-[90vh] w-full ${SIZES[size]} flex-col rounded-3xl border ${PANEL}`}>
      <div className="shrink-0 p-6 pb-4"><Head eyebrow={eyebrow} title={title} description={description} onClose={onClose} titleId={titleId} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6">{children}</div>
      {footer && <div className="shrink-0 border-t border-white/8 p-6 pt-4">{footer}</div>}
      {!footer && <div className="h-6 shrink-0" />}
    </div>
  </div>;
}

/** 右侧抽屉。用于「随时想看一眼」的内容（项目记录、产出参数），不打断当前这一步。 */
export function Drawer({ open, onClose, title, eyebrow, description, footer, children, dismissible = true }: {
  open: boolean; onClose: () => void; title: string; eyebrow?: string; description?: ReactNode;
  footer?: ReactNode; children: ReactNode;
  /** 加载中等不该被点空白关掉的场景传 false。 */
  dismissible?: boolean;
}) {
  if (!open) return null;
  const titleId = `drawer-${title}`;
  return <div className={`${OVERLAY} flex justify-end`} role="dialog" aria-modal="true" aria-labelledby={titleId}
    onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose(); }}>
    <aside className={`flex h-full w-full max-w-xl flex-col border-l ${PANEL}`}>
      <div className="shrink-0 p-6 pb-4"><Head eyebrow={eyebrow} title={title} description={description} onClose={onClose} titleId={titleId} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6">{children}</div>
      {footer && <div className="shrink-0 border-t border-white/8 p-6 pt-4">{footer}</div>}
      {!footer && <div className="h-6 shrink-0" />}
    </aside>
  </div>;
}

/** 弹层里的主/次按钮。各处按钮尺寸和配色以前也是各写各的。 */
export const overlayButton = {
  primary: 'rounded-xl bg-emerald-300 px-4 py-2.5 text-xs font-semibold text-[#082018] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40',
  secondary: 'rounded-xl border border-white/12 px-4 py-2.5 text-xs text-white/65 transition hover:border-white/25 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40',
  danger: 'rounded-xl border border-rose-300/35 bg-rose-400/10 px-4 py-2.5 text-xs font-semibold text-rose-100 transition hover:bg-rose-400/20 disabled:cursor-not-allowed disabled:opacity-40',
};
