'use client';

// 工作台的主轴：把五个步骤串成一条看得见的流程。
//
// 为什么是竖排、且不另加顶部流程条：
// 左栏本来就是竖排五项，加上状态点和连接线，它本身就是流程图。
// 再起一条顶部导航等于两套导航并存——正是「页面看起来很乱」的来源。
// 竖排在中文里也更好读：每一项能带一行说明，横排塞不下。
//
// 编号和连接线不是装饰：这五步**确实**是一个序列，前一步的产出是后一步的输入。

import type { LucideIcon } from 'lucide-react';

/** 一步的状态。用形状而不只用颜色承载信息，色觉障碍也分得清。 */
export type StepState = 'done' | 'active' | 'todo' | 'attention';

export interface FlowStep {
  id: string;
  /** 步骤名。动词开头，说清这一步「做什么」，不是「这里有什么」。 */
  label: string;
  /** 一行状态说明。已完成写产出了什么，未开始写还缺什么。 */
  hint: string;
  state: StepState;
  icon: LucideIcon;
  /** 不可进入的原因。为空表示可进入。 */
  blockedReason?: string;
}

const DOT: Record<StepState, string> = {
  done: 'border-emerald-300/70 bg-emerald-300',
  // 进行中是全页唯一的非用户触发动效。只有一个在动，才抓得住注意力。
  active: 'border-emerald-300 bg-emerald-300/25 animate-pulse',
  todo: 'border-white/20 bg-transparent',
  attention: 'border-[#d9b76c]/70 bg-[#d9b76c]/25',
};

const LABEL: Record<StepState, string> = {
  done: 'text-white/70',
  active: 'text-white/90',
  todo: 'text-white/35',
  attention: 'text-[#e8d5a4]',
};

export function FlowRail({ steps, activeId, onSelect, disabled }: {
  steps: FlowStep[];
  activeId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <nav aria-label="复刻流程" className="mt-5">
      <ol className="flex gap-2 overflow-x-auto lg:block lg:space-y-0">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const current = step.id === activeId;
          const last = index === steps.length - 1;
          const blocked = Boolean(step.blockedReason);
          return (
            <li key={step.id} className="relative min-w-[145px] shrink-0 lg:min-w-0">
              {/* 连接线画到下一个点，把五项串成一条。最后一项不画。 */}
              {!last && (
                <span
                  aria-hidden
                  className={`hidden lg:block absolute left-[15px] top-[30px] h-[calc(100%-18px)] w-px ${step.state === 'done' ? 'bg-emerald-300/25' : 'bg-white/8'}`}
                />
              )}
              <button
                type="button"
                disabled={disabled || blocked}
                aria-current={current ? 'step' : undefined}
                title={step.blockedReason}
                onClick={() => onSelect(step.id)}
                className={`flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition
                  ${current ? 'bg-emerald-300/[0.07]' : 'hover:bg-white/[0.025]'}
                  ${blocked ? 'cursor-not-allowed opacity-45 hover:bg-transparent' : ''}`}
              >
                <span className={`relative z-10 mt-0.5 grid h-[31px] w-[31px] shrink-0 place-items-center rounded-full border-2 bg-[#07120f] ${DOT[step.state]}`}>
                  <Icon size={13} className={step.state === 'done' ? 'text-[#062017]' : step.state === 'todo' ? 'text-white/30' : 'text-emerald-100'} />
                </span>
                <span className="min-w-0 pt-1">
                  <span className={`flex items-baseline gap-1.5 text-xs font-medium ${LABEL[step.state]}`}>
                    <span className="tabular-nums text-white/25">{index + 1}</span>
                    {step.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] leading-4 text-white/25">
                    {step.blockedReason || step.hint}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
