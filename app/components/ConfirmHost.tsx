'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, overlayButton } from './Overlay';
import { setChoiceHandler, setConfirmHandler, type ChoiceRequest, type ConfirmRequest } from '../lib/confirm';

/**
 * 挂一次，全应用的 confirmAction() / confirmChoice() 就有了统一样式的确认框。
 * 挂载期间接管；卸载时注销，让 lib 层退回 window.confirm，绝不静默放行付费动作。
 */
export function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
  const choiceRef = useRef<{ resolve: (id: string) => void; cancelId: string } | null>(null);

  useEffect(() => {
    // 同一时刻只可能有一个确认框；万一前一个还挂着，按「取消」收掉，不让它悬空。
    const dismissAll = () => {
      resolveRef.current?.(false); resolveRef.current = null;
      choiceRef.current?.resolve(choiceRef.current.cancelId); choiceRef.current = null;
    };
    setConfirmHandler((next) => new Promise<boolean>((resolve) => {
      dismissAll();
      resolveRef.current = resolve;
      setChoice(null);
      setRequest(next);
    }));
    setChoiceHandler((next) => new Promise<string>((resolve) => {
      dismissAll();
      choiceRef.current = { resolve, cancelId: next.cancelId };
      setRequest(null);
      setChoice(next);
    }));
    return () => { setConfirmHandler(null); setChoiceHandler(null); dismissAll(); };
  }, []);

  const settle = (value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setRequest(null);
  };
  const choose = (id: string) => {
    choiceRef.current?.resolve(id);
    choiceRef.current = null;
    setChoice(null);
  };

  if (choice) {
    const last = choice.actions.length - 1;
    return <div onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); choose(choice.cancelId); } }}>
      <Modal
        open
        size="sm"
        onClose={() => choose(choice.cancelId)}
        eyebrow="需要选择"
        title={choice.title}
        footer={<div className="flex flex-wrap justify-end gap-2">
          {choice.actions.map((action, index) => <button
            key={action.id}
            type="button"
            className={action.danger ? overlayButton.danger : index === last && action.id !== choice.cancelId ? overlayButton.primary : overlayButton.secondary}
            onClick={() => choose(action.id)}
            autoFocus={index === last}
          >{action.label}</button>)}
        </div>}
      >
        <p className="whitespace-pre-wrap pb-2 text-sm leading-6 text-white/70">{choice.message}</p>
      </Modal>
    </div>;
  }
  if (!request) return null;
  return <Modal
    open
    size="sm"
    onClose={() => settle(false)}
    eyebrow={request.danger ? '需要确认 · 这一步会扣费' : '需要确认'}
    title={request.title}
    footer={<div className="flex justify-end gap-2">
      <button type="button" className={overlayButton.secondary} onClick={() => settle(false)}>{request.cancelLabel ?? '取消'}</button>
      <button type="button" className={request.danger ? overlayButton.danger : overlayButton.primary} onClick={() => settle(true)} autoFocus>{request.confirmLabel}</button>
    </div>}
  >
    <div className="flex gap-3 pb-2">
      {request.danger && <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-200/80" />}
      <p className="whitespace-pre-wrap text-sm leading-6 text-white/70">{request.message}</p>
    </div>
  </Modal>;
}
