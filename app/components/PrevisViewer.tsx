'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, LoaderCircle, Pause, Play, Rotate3d, Video } from 'lucide-react';
import { FPS, type Film, type FilmShot } from '../lib/previs/film';
import type { ExportRange } from '../lib/previs/export';

type Span = { shot: FilmShot; first: number; last: number };
const button = 'inline-flex min-h-10 items-center gap-2 rounded-lg border border-emerald-200/25 px-3.5 text-sm text-emerald-100 hover:bg-emerald-200/10 disabled:cursor-not-allowed disabled:opacity-40';

function spansFor(ranges: ExportRange[]): Span[] {
  return ranges.map(({ shot, from, to }) => {
    const first = from === undefined ? 1 : Math.min(shot.frames, Math.max(1, Math.ceil(from * FPS - 1e-6) + 1));
    const last = to === undefined ? shot.frames : Math.max(first, Math.min(shot.frames, Math.ceil(to * FPS - 1e-6)));
    return { shot, first, last };
  });
}
function locate(spans: Span[], index: number) {
  let rest = index;
  for (const span of spans) {
    const count = span.last - span.first + 1;
    if (rest < count) return { shot: span.shot, local: (span.first - 1 + rest) / FPS };
    rest -= count;
  }
  const last = spans.at(-1)!;
  return { shot: last.shot, local: (last.last - 1) / FPS };
}
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

/**
 * 在页面里实时播放预演（WebGL），可拖进度、切自由视角，并按需导出视频。
 * ranges 不传就是整片；传某镜（可带镜内起止秒）就只播那一段。
 */
export function PrevisViewer({ film, ranges, downloadName, className = '' }: { film: Film; ranges?: ExportRange[]; downloadName: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const spans = useMemo(() => spansFor(ranges ?? film.shots.map(shot => ({ shot }))), [film, ranges]);
  const total = spans.reduce((sum, span) => sum + span.last - span.first + 1, 0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [free, setFree] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState<number | null>(null);
  const frameRef = useRef(0);
  const playingRef = useRef(false);
  const freeRef = useRef(false);
  const draw = useRef<() => void>(() => {});
  // 只在画面真的要变时重画：暂停、看不见（面板被隐藏/滚出屏幕）时不占 CPU 和显卡。
  const dirty = useRef(true);
  const exportAbort = useRef<AbortController | null>(null);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  useEffect(() => {
    let disposed = false, raf = 0;
    let cleanup = () => {};
    (async () => {
      try {
        const [{ createPrevisScene, createRenderer }, THREE, { OrbitControls }] = await Promise.all([
          import('../lib/previs/scene'), import('three'), import('three/examples/jsm/controls/OrbitControls.js'),
        ]);
        if (disposed || !host.current) return;
        frameRef.current = 0; setFrame(0); setPlaying(false); dirty.current = true;
        // 每次重建都用新画布：被强制释放过上下文的旧画布不能再拿来建 WebGL。
        const element = document.createElement('canvas');
        element.width = film.width; element.height = film.height;
        element.setAttribute('aria-label', '3D 预演画面');
        element.className = 'mx-auto block max-h-[620px] w-auto max-w-full';
        element.style.aspectRatio = `${film.width} / ${film.height}`;
        host.current.replaceChildren(element);
        const renderer = createRenderer(element, film.width, film.height);
        // 先登记释放，后面任何一步出错也不会留下占着的 3D 上下文。
        cleanup = () => { renderer.dispose(); renderer.forceContextLoss(); element.remove(); };
        element.addEventListener('webglcontextlost', event => {
          event.preventDefault();
          if (!disposed) setError('3D 画面被浏览器回收了（同时打开的 3D 画面太多）。收起其他镜头的预演，再刷新页面。');
        });
        let onScreen = true;
        const observer = new IntersectionObserver(entries => { onScreen = entries.some(entry => entry.isIntersecting); if (onScreen) dirty.current = true; });
        observer.observe(element);
        const stage = createPrevisScene();
        const orbit = new THREE.PerspectiveCamera(45, film.width / film.height, .1, 500);
        orbit.up.set(0, 0, 1);
        const controls = new OrbitControls(orbit, element);
        controls.enableDamping = true;
        controls.enabled = false;
        controls.addEventListener('change', () => { dirty.current = true; });
        let lastFree = false;
        draw.current = () => {
          const { shot, local } = locate(spans, frameRef.current);
          const cam = stage.pose(shot.plan, local, film);
          if (freeRef.current && !lastFree) {
            // 进入自由视角时从当前镜头机位出发，便于对照。
            orbit.position.copy(stage.camera.position);
            controls.target.set(cam.target[0], cam.target[1], cam.target[2]);
            orbit.fov = stage.camera.fov; orbit.updateProjectionMatrix();
            controls.update();
          }
          lastFree = freeRef.current;
          controls.enabled = freeRef.current;
          renderer.render(stage.scene, freeRef.current ? orbit : stage.camera);
        };
        let previous = performance.now(), carry = 0;
        const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          if (playingRef.current) {
            carry += (now - previous) / 1000 * FPS;
            const step = Math.floor(carry);
            if (step > 0) {
              carry -= step;
              const next = frameRef.current + step;
              if (next >= total) { frameRef.current = total - 1; setPlaying(false); } else frameRef.current = next;
              setFrame(frameRef.current);
              dirty.current = true;
            }
          } else carry = 0;
          previous = now;
          if (!onScreen) return;
          // 自由视角拖动后的惯性也要画完。
          if (freeRef.current && controls.update()) dirty.current = true;
          if (!dirty.current) return;
          dirty.current = false;
          draw.current();
        };
        raf = requestAnimationFrame(tick);
        cleanup = () => { cancelAnimationFrame(raf); observer.disconnect(); controls.dispose(); stage.dispose(); renderer.dispose(); renderer.forceContextLoss(); element.remove(); };
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? `3D 预览无法启动：${cause.message}` : '3D 预览无法启动，请换用最新版 Chrome 或 Edge。');
      }
    })();
    return () => { disposed = true; cleanup(); draw.current = () => {}; exportAbort.current?.abort(); };
  }, [film, spans, total]);

  const seek = (value: number) => { frameRef.current = value; setFrame(value); dirty.current = true; };
  const toggleFree = () => { freeRef.current = !freeRef.current; setFree(freeRef.current); dirty.current = true; };
  const download = async () => {
    const controller = new AbortController(); exportAbort.current = controller;
    setExporting(0); setError('');
    try {
      const { exportFilm, saveBlob } = await import('../lib/previs/export');
      const result = await exportFilm(film, ranges ?? film.shots.map(shot => ({ shot })), { onProgress: setExporting, signal: controller.signal });
      saveBlob(result.blob, `${downloadName}.${result.extension}`);
      if (result.extension !== 'mp4') setError('这个浏览器只能导出 WebM。即梦等平台可能需要 MP4，建议换用 Chrome 或 Edge 再导出。');
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '导出失败');
    } finally { setExporting(null); exportAbort.current = null; }
  };
  const seconds = total / FPS;
  const current = locate(spans, frame);

  return <div className={className}>
    <div className="relative overflow-hidden rounded-xl bg-black">
      <div ref={host} className="min-h-40" />
      {free && <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white/80">自由视角：拖动旋转，滚轮缩放</span>}
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" className={button} onClick={() => { if (frame >= total - 1) seek(0); setPlaying(!playing); }} aria-label={playing ? '暂停' : '播放'}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? '暂停' : '播放'}</button>
      <input type="range" min={0} max={Math.max(0, total - 1)} value={frame} onChange={event => { setPlaying(false); seek(Number(event.target.value)); }} aria-label="预演进度" className="min-w-40 flex-1 accent-emerald-300" />
      <span className="text-xs tabular-nums text-white/60">{clock(frame / FPS)} / {clock(seconds)}{film.shots.length > 1 && !ranges ? ` · 第 ${current.shot.index + 1} 镜` : ''}</span>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={button} onClick={toggleFree} aria-pressed={free}>{free ? <Video size={15} /> : <Rotate3d size={15} />}{free ? '回到镜头视角' : '自由视角'}</button>
      {exporting === null
        ? <button type="button" className={button} onClick={() => void download()}><Download size={15} />下载视频</button>
        : <button type="button" className={button} onClick={() => exportAbort.current?.abort()}><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />正在导出 {Math.round(exporting * 100)}% · 点此取消</button>}
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-amber-100">{error}</p>}
  </div>;
}

/** 列表里每镜一个：默认不建 WebGL（浏览器同时能开的 3D 画面有限），点开才渲染；下载不必先打开。 */
export function PrevisClip({ film, range, name, buttonClass = button }: { film: Film; range: ExportRange; name: string; buttonClass?: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<number | null>(null);
  const [error, setError] = useState('');
  const clipAbort = useRef<AbortController | null>(null);
  useEffect(() => () => clipAbort.current?.abort(), []);
  // 按值记忆：父组件每次渲染都会新建 range 对象，不能因此重建 3D 画面。
  const { shot, from, to } = range;
  const ranges = useMemo(() => [{ shot, from, to }], [shot, from, to]);
  const download = async () => {
    const controller = new AbortController(); clipAbort.current = controller;
    setExporting(0); setError('');
    try {
      const { exportFilm, saveBlob } = await import('../lib/previs/export');
      const result = await exportFilm(film, ranges, { onProgress: setExporting, signal: controller.signal });
      saveBlob(result.blob, `${name}.${result.extension}`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { if (clipAbort.current === controller) clipAbort.current = null; setExporting(null); }
  };
  return <div>
    {open ? <PrevisViewer film={film} ranges={ranges} downloadName={name} />
      : <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={() => setOpen(true)}><Play size={15} />播放 3D 预演</button>
        <button type="button" className={buttonClass} onClick={() => exporting === null ? void download() : clipAbort.current?.abort()}>{exporting === null ? <Download size={15} /> : <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />}{exporting === null ? '下载 3D 视频' : `正在导出 ${Math.round(exporting * 100)}% · 点此取消`}</button>
      </div>}
    {error && <p role="alert" className="mt-2 text-sm text-amber-100">{error}</p>}
  </div>;
}
