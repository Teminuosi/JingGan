'use client';

import { useEffect, useRef, useState } from 'react';
import type { DraftPrompts } from '../lib/original-story';

export type PromptLang = 'zh' | 'en';

const tabClass = (on: boolean) => `min-h-10 px-4 text-sm transition border-b-2 ${on ? 'border-emerald-300 text-emerald-100' : 'border-transparent text-white/55 hover:text-white/80'}`;
export const copyButtonClass = 'min-h-10 shrink-0 rounded-lg border border-emerald-200/25 px-4 text-sm text-emerald-100 hover:bg-emerald-200/10 disabled:opacity-40';

/** 「中文 / 英文」两个 tab。拆解页和改编页共用同一种切换样式。 */
export function LangTabs({ lang, onChange, label }: { lang: PromptLang; onChange: (lang: PromptLang) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex border-b border-white/10">
      {([['zh', '中文'], ['en', '英文']] as const).map(([id, name]) => <button key={id} type="button" role="tab" aria-selected={lang === id} onClick={() => onChange(id)} className={tabClass(lang === id)}>{name}</button>)}
    </div>
  );
}

/** 复制到剪贴板，按钮上短暂显示「已复制」。 */
export function useCopy() {
  const [copied, setCopied] = useState('');
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setFailed(false); }
    catch { setFailed(true); return; }
    setCopied(key);
    setTimeout(() => { if (alive.current) setCopied(''); }, 2000);
  };
  return { copied, failed, copy };
}

/** 英文版用不了或有镜头保留中文时，说清楚为什么。 */
export function EnglishNotice({ prompts }: { prompts: DraftPrompts }) {
  if (prompts.englishUnavailable) return <p className="text-sm leading-6 text-amber-100">{prompts.englishUnavailable}</p>;
  if (!prompts.englishMissing.length) return null;
  return <p className="text-xs leading-5 text-amber-100/85">{prompts.englishMissing.join('、')} 还没有英文，英文提示词里这几镜暂用中文。在改编故事的英文 tab 里展开这几镜就能填写。</p>;
}

/**
 * 拆解页：中文 / 英文两个 tab，直接显示整片提示词全文，右上角一个复制。
 * 中英文都在本地拼，英文来自拆解时 Gemini 同时给出的英文，不再调模型。
 */
export function PromptTabs({ prompts, error }: { prompts?: DraftPrompts; error?: string }) {
  const [lang, setLang] = useState<PromptLang>('zh');
  const { copied, failed, copy } = useCopy();
  const text = prompts ? (lang === 'en' ? prompts.full.en : prompts.full.zh) : '';
  const blocked = !prompts || (lang === 'en' && !!prompts.englishUnavailable);
  return (
    <section aria-label="原片的视频提示词" className="rounded-2xl border border-white/10 bg-white/[0.025]">
      <div className="flex items-end justify-between gap-3 px-5 pt-3">
        <div className="flex items-end gap-4"><h4 className="pb-2.5 text-sm font-medium text-white">视频提示词</h4><LangTabs lang={lang} onChange={setLang} label="提示词语言" /></div>
        <button type="button" disabled={blocked} onClick={() => void copy(lang, text)} className={`${copyButtonClass} mb-2`}>{copied === lang ? '已复制' : '复制'}</button>
      </div>
      <div className="space-y-3 border-t border-white/10 p-5">
        {error ? <p className="text-sm leading-6 text-amber-100">{error}</p> : prompts && <>
          {lang === 'en' && <EnglishNotice prompts={prompts} />}
          {!blocked && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-white/75">{text}</pre>}
          {failed && <p className="text-xs text-amber-100">复制失败，请检查浏览器是否允许访问剪贴板，或在上面直接选中文字复制。</p>}
        </>}
      </div>
    </section>
  );
}
