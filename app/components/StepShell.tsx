'use client';

// 每一步页面的统一骨架，三段：
//
//   做不做   —— 这一步产出什么、花多少、一个主按钮
//   做成什么样 —— 产物本身
//   怎么调   —— 参数与细节，默认收起
//
// 「页面什么都堆在一起」的根子就在于这三件事平铺在同一层。
// 分成三段之后，进页面第一眼永远是「这步该不该做、能不能做」。
//
// 三段用细线分隔，不套三个圆角卡片：它们是同一件事的三个深度，
// 装进三个平级的卡片反而暗示它们是三个并列对象。

import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

export function StepShell({ title, intent, meta, action, status, children, tuning }: {
  /** 步骤名，与左栏一致。同一个动作在全流程里只有一个叫法。 */
  title: string;
  /** 一句话说清这一步产出什么。写给用户，不写实现。 */
  intent: string;
  /** 代价与前提：调用次数、耗时、依赖。没有就不给。 */
  meta?: ReactNode;
  /** 主按钮。每一步只有一个，其余操作一律下沉到「调整」。 */
  action?: ReactNode;
  /** 右上角状态短语，例如「已完成」「2/3 角色」。 */
  status?: ReactNode;
  /** 产物区。这一步做出来的东西本身。 */
  children: ReactNode;
  /** 调整区。默认收起，展开后在同一列内下推，不浮层遮住产物。 */
  tuning?: ReactNode;
}) {
  return (
    <div className="min-w-0 w-full">
      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold tracking-tight text-white/90">{title}</h2>
          {/* 行长压在 80 字符内，中文更短；这里限宽让说明一眼扫完 */}
          <p className="mt-1.5 max-w-[80ch] text-sm leading-6 text-white/65">{intent}</p>
          {meta && <p className="mt-2 text-xs leading-5 text-white/55">{meta}</p>}
        </div>
        {status && <span className="shrink-0 rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/65">{status}</span>}
      </header>

      {action && <div className="mt-5">{action}</div>}

      <hr className="my-6 border-white/10" />

      <div>{children}</div>

      {tuning && (
        <>
          <hr className="my-6 border-white/10" />
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-white/35 hover:text-white/60">
              <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
              调整
            </summary>
            <div className="mt-4">{tuning}</div>
          </details>
        </>
      )}
    </div>
  );
}
