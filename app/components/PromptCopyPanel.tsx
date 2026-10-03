'use client';

import { useEffect, useRef, useState } from 'react';
import { buildDraftPromptSet, ORIGINAL_PROMPT_CHARACTER_LIMIT } from '../lib/original-story';
import { videoModel } from '../lib/video-models';
import type { CreativeDraft, RemixBrief, VideoDnaAnalysis } from '../lib/types';

const choiceClass = (on: boolean) => `min-h-10 rounded-lg border px-4 text-sm transition ${on ? 'border-emerald-300/60 bg-emerald-300/10 text-emerald-100' : 'border-white/15 text-white/60 hover:border-white/35'}`;
const copyClass = 'min-h-11 rounded-xl border border-emerald-200/25 px-4 text-sm text-emerald-100 hover:bg-emerald-200/10 disabled:opacity-40';

/**
 * 复制视频提示词：先选用在哪个平台，再选语言，下面只剩要点的复制按钮。
 * 拆解页（原片原样）和改编页（故事草稿）共用。中英文都在本地拼，不调模型、不花钱。
 */
export function PromptCopyPanel({ draft, analysis, brief, videoModelId, disabled = false, title = '复制视频提示词' }: {
  draft: CreativeDraft; analysis: VideoDnaAnalysis; brief: RemixBrief; videoModelId: string; disabled?: boolean; title?: string;
}) {
  const [target, setTarget] = useState<'jimeng' | 'full'>('jimeng');
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [copied, setCopied] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // 即梦就是 seedance：选的是 seedance 档就按它的单次上限切；选了别家模型时按即梦最常见的 15 秒档切。
  const model = videoModel(videoModelId);
  const jimengCap = videoModelId.startsWith('seedance') ? (model.fixedSeconds ?? model.maxSeconds) : 15;
  let prompts: ReturnType<typeof buildDraftPromptSet> | undefined;
  let failure = '';
  try { prompts = buildDraftPromptSet(draft, analysis, brief, jimengCap); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }

  const copy = async (key: string, name: string, text: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch { setNote({ error: true, text: '复制失败，请检查浏览器是否允许访问剪贴板。' }); return; }
    setCopied(key);
    setNote({ text: `已复制${name}，共 ${text.length.toLocaleString()} 字。角色已写成文字描述，不需要参考图。` });
    setTimeout(() => { if (alive.current) setCopied(''); }, 2000);
  };
  const langName = lang === 'en' ? '英文' : '中文';
  const items = prompts ? (target === 'jimeng' ? prompts.segments : [prompts.full]) : [];
  const totalSeconds = prompts ? prompts.full.seconds : 0;

  return (
    <section aria-label={title} className="space-y-5 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
      <h4 className="text-sm font-medium text-white">{title}</h4>
      <div className="grid gap-3 sm:grid-cols-[6rem_1fr] sm:items-center">
        <span className="text-sm text-white/60">用在哪</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={target === 'jimeng'} onClick={() => { setTarget('jimeng'); setNote(undefined); }} className={choiceClass(target === 'jimeng')}>即梦</button>
          <button type="button" aria-pressed={target === 'full'} onClick={() => { setTarget('full'); setNote(undefined); }} className={choiceClass(target === 'full')}>其他 AI（不限字数、能一次出整片）</button>
        </div>
        <span className="text-sm text-white/60">语言</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={lang === 'zh'} onClick={() => { setLang('zh'); setNote(undefined); }} className={choiceClass(lang === 'zh')}>中文</button>
          <button type="button" aria-pressed={lang === 'en'} onClick={() => { setLang('en'); setNote(undefined); }} className={choiceClass(lang === 'en')}>英文</button>
        </div>
      </div>

      <div className="border-t border-white/10 pt-4">
        {failure ? <p className="text-sm leading-6 text-amber-100">{failure}</p>
          : lang === 'en' && prompts!.englishUnavailable ? <p className="text-sm leading-6 text-amber-100">{prompts!.englishUnavailable}</p>
            : <>
              <p className="text-sm leading-6 text-white/65">{target === 'jimeng'
                ? items.length > 1
                  ? `即梦一次最多生成 ${jimengCap} 秒、最多 ${ORIGINAL_PROMPT_CHARACTER_LIMIT.toLocaleString()} 字。这条 ${totalSeconds} 秒，分成 ${items.length} 段：按顺序一段一段生成，再拼起来。每段都能单独粘贴。`
                  : `即梦一次最多生成 ${jimengCap} 秒、最多 ${ORIGINAL_PROMPT_CHARACTER_LIMIT.toLocaleString()} 字。这条 ${totalSeconds} 秒，一段就够。`
                : `整片 ${totalSeconds} 秒写成一条，给字数不受限、能一次生成整片的平台。`}</p>
              {lang === 'en' && !!prompts!.englishMissing.length && <p className="mt-2 text-xs leading-5 text-amber-100/85">{prompts!.englishMissing.join('、')} 你改过内容，英文版里这几镜仍是中文。想要全英文，把改动撤回或重新生成原剧情分镜。</p>}
              <ul className="mt-3 space-y-2">
                {items.map((item, i) => {
                  const text = lang === 'en' ? item.en : item.zh;
                  const key = `${target}${i}${lang}`;
                  const label = target === 'jimeng' && items.length > 1 ? `复制第 ${i + 1} 段（${item.start}–${item.end} 秒）` : `复制${target === 'jimeng' ? '即梦' : '整片'}${langName}提示词`;
                  const name = target === 'jimeng' && items.length > 1 ? `第 ${i + 1} 段${langName}提示词` : `${target === 'jimeng' ? '即梦' : '整片'}${langName}提示词`;
                  return <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <button type="button" className={copyClass} disabled={disabled} onClick={() => void copy(key, name, text)}>{copied === key ? '已复制' : label}</button>
                    <span className="text-xs tabular-nums text-white/50">{text.length.toLocaleString()} 字{target === 'jimeng' && text.length > ORIGINAL_PROMPT_CHARACTER_LIMIT && <span className="text-amber-200"> · 这一镜内容就超过 {ORIGINAL_PROMPT_CHARACTER_LIMIT.toLocaleString()} 字，粘贴到即梦会被截断</span>}</span>
                  </li>;
                })}
              </ul>
            </>}
        {note && <p role="status" aria-live="polite" className={`mt-3 text-xs leading-5 ${note.error ? 'text-amber-100' : 'text-emerald-100/80'}`}>{note.text}</p>}
      </div>
    </section>
  );
}
