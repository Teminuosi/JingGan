'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

export function CharacterTaskStatus({ job }: { job: {
  status: string; phase: 'design' | 'images' | 'recovery'; startedAt: number;
  lastSignalAt?: number; expectedCount: number; completedImages: string[]; progress: number;
} }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (job.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job.status, job.startedAt]);
  if (job.status !== 'running') return null;
  const seconds = Math.max(0, Math.floor((now - job.startedAt) / 1000));
  if (job.phase === 'images' && job.expectedCount > 0) return <div className="mt-3">
    <p className="mb-2 text-sm">参考图已保存 {job.completedImages.length}/{job.expectedCount} 张</p>
    <progress aria-label="参考图保存进度" className="h-2 w-full accent-emerald-300" max={job.expectedCount} value={job.completedImages.length} />
  </div>;
  return <div className="mt-3 space-y-2 text-sm leading-6 text-white/70">
    <p className="flex items-center gap-2"><LoaderCircle size={16} className="animate-spin" />{job.phase === 'recovery' ? '检查已缓存结果' : '文字方案处理中，尚未开始生成图片'} · 已等待 {Math.floor(seconds / 60)} 分 {seconds % 60} 秒</p>
    <p className="text-xs text-white/55">{job.lastSignalAt ? `最近一次收到中转响应：${new Date(job.lastSignalAt).toLocaleTimeString('zh-CN')}` : '尚未收到可确认的模型结果。'} 不显示估算百分比。</p>
    {seconds >= 90 && <p className="text-sm text-amber-100">等待时间较长；请保持页面打开。中转响应不代表生成成功，收到完整方案并保存后才会显示候选。</p>}
  </div>;
}
