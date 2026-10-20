'use client';

import { useEffect, useMemo, useRef } from 'react';

/**
 * 预演旁边的原片，跟着预演的进度走（静音、不单独操作），方便逐帧对照走位和运镜。
 * time 是原片里的秒数；playing 时只在偏差较大时校正，避免每帧 seek 卡顿。
 */
export function SourcePlayer({ source, time, playing, className = '' }: { source: Blob; time: number; playing: boolean; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const url = useMemo(() => URL.createObjectURL(source), [source]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    const element = video.current;
    if (!element || element.readyState < 1) return;
    const target = Math.min(time, Math.max(0, (element.duration || time) - .01));
    if (!playing) {
      if (!element.paused) element.pause();
      if (Math.abs(element.currentTime - target) > .04) element.currentTime = target;
      return;
    }
    if (element.paused || Math.abs(element.currentTime - target) > .3) element.currentTime = target;
    if (element.paused) void element.play().catch(() => {});
  }, [time, playing]);

  return <video ref={video} src={url} muted playsInline preload="auto" aria-label="原片"
    onLoadedMetadata={event => { event.currentTarget.currentTime = time; }}
    className={className} />;
}

/** 原片｜预演 并排；没有原片时只放预演。 */
export function CompareFrame({ source, label, children, sourceView }: { source?: Blob | null; label: string; children: React.ReactNode; sourceView: React.ReactNode }) {
  if (!source) return <>{children}</>;
  return <div className="grid grid-cols-2 gap-2 sm:gap-3">
    <figure className="relative min-w-0 overflow-hidden rounded-xl bg-black">
      {sourceView}
      <figcaption className="absolute left-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white/85">原片</figcaption>
    </figure>
    <figure className="relative min-w-0 overflow-hidden rounded-xl bg-black">
      {children}
      <figcaption className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white/85">{label}</figcaption>
    </figure>
  </div>;
}
