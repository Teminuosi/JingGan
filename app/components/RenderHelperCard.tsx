'use client';
import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronRight, CircleAlert, Download, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { useAccountConfig } from './AccountWorkspace';

type HelperStatus = 'ready' | 'setup' | 'unavailable' | 'outdated';
// 新版助手（1.0.2 起）在 /health 里报这个值；旧版报的是数字 1（整片一次编排、非流式、不能续跑）。
export const CURRENT_PLANNING = 'library+per-shot';
const HELPER = 'http://127.0.0.1:43128';

/** 前置条件清单里每一行的状态点。用形状而不只是颜色区分，色弱也分得清。 */
export function CheckDot({ state }: { state: 'ok' | 'todo' | 'busy' }) {
  if (state === 'busy') return <LoaderCircle size={18} className="shrink-0 animate-spin text-emerald-200/70 motion-reduce:animate-none" aria-label="检查中" />;
  if (state === 'ok') return <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-emerald-300 text-[#082018]" aria-label="已就绪"><Check size={12} strokeWidth={3} /></span>;
  return <CircleAlert size={18} className="shrink-0 text-amber-200" aria-label="未就绪" />;
}

/**
 * 「渲染助手」这一条前置条件，渲染成清单里的一行。
 *
 * 以前它是页面上最大的一块，而且不管助手在不在都长一个样：「下载 Windows 助手」是全页
 * 唯一的实心绿按钮，助手早已就绪的人第一眼看到的仍是安装说明；真正该点的「检查助手」
 * 缩在角落，不点它页面甚至不知道助手活着。
 *
 * 现在：一行状态 + 当下该点的那一个按钮；安装说明默认收起，只在真连不上时自动展开。
 * active 时自动检查一次——只是读本机 /health，不花钱。默认不自动查：这个组件也挂在首页的
 * 折叠区里，一打开首页就去连本机，线上站会莫名其妙弹出浏览器的「访问本地网络」授权框。
 */
export function RenderHelperCard({ active = false, onStatusChange }: { active?: boolean; onStatusChange?: (status: HelperStatus) => void } = {}) {
  const { helperDownloads } = useAccountConfig();
  const downloads = helperDownloads || { light: 'https://github.com/Teminuosi/JingGan/releases', offline: 'https://github.com/Teminuosi/JingGan/releases', lightReady: false, offlineReady: false };
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [detail, setDetail] = useState('');
  const [remoteSite, setRemoteSite] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showInstall, setShowInstall] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    let next: HelperStatus;
    try {
      const response = await fetch(`${HELPER}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const health = await response.json() as { ready: boolean; planningCalls?: unknown; environment?: { message?: string; version?: string } };
      // 旧助手照样能连上、照样报 ready，但会走整片一次编排，碰上 524 就整单作废。
      // 不拦下来的话，用户在新页面上点「开始」，跑的却是旧逻辑，报错也对不上页面的说法。
      next = health.planningCalls !== CURRENT_PLANNING ? 'outdated' : health.ready ? 'ready' : 'setup';
      setDetail(next === 'outdated' ? '版本过旧，需要换成新版' : health.ready
        ? `已就绪${health.environment?.version ? ` · Blender ${health.environment.version}` : ''}`
        : health.environment?.message || '助手在运行，但 3D 渲染环境还没准备好');
    } catch {
      next = 'unavailable';
      setDetail('未连接');
    }
    // 线上站第一次连本机助手要多两步授权，本机站不用——提示只说用户眼下真要做的事。
    setRemoteSite(!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));
    setStatus(next);
    setShowInstall(next === 'unavailable' || next === 'outdated');
    onStatusChange?.(next);
    setChecking(false);
  }, [onStatusChange]);

  useEffect(() => {
    if (!active || status !== null) return;
    const timer = setTimeout(() => void check(), 0);
    return () => clearTimeout(timer);
  }, [active, status, check]);

  const openSetup = (event: React.MouseEvent<HTMLAnchorElement>) => { event.currentTarget.href = `${HELPER}/setup?site=${encodeURIComponent(window.location.origin)}`; };
  const linkClass = 'inline-flex min-h-11 items-center gap-2 rounded-lg border border-emerald-200/25 px-4 text-sm text-emerald-100 hover:bg-emerald-200/10';

  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <CheckDot state={checking || (active && status === null) ? 'busy' : status === 'ready' ? 'ok' : 'todo'} />
        <span className="w-20 shrink-0 text-sm font-medium text-white/85">渲染助手</span>
        <span role="status" className="min-w-0 flex-1 text-sm text-emerald-50/70">{checking ? '正在检查…' : detail || '还没检查'}</span>
        {status === 'setup' && <a href={`${HELPER}/setup`} target="_blank" rel="noopener noreferrer" onClick={openSetup} className={linkClass}><ExternalLink size={15} />去准备渲染环境</a>}
        <button type="button" onClick={() => void check()} disabled={checking} className={`${linkClass} disabled:opacity-50`}>
          <RefreshCw size={15} className={checking ? 'animate-spin motion-reduce:animate-none' : ''} />{status ? '重新检查' : '检查助手'}
        </button>
      </div>

      {status === 'unavailable' && (
        <p className="mt-3 max-w-[66ch] text-xs leading-5 text-amber-100/80 sm:ml-[34px]">
          助手是装在你电脑上的一个小程序，负责用 Blender 把预演渲染出来。它可能没在运行，或浏览器没允许本页访问它。先启动助手，再点「重新检查」。
          {remoteSite && ' 用线上网站第一次连接时，还要在「助手设置」里授权本网址，并在浏览器弹窗里允许访问本地网络。'}
        </p>
      )}
      {status === 'outdated' && (
        <p className="mt-3 max-w-[66ch] text-xs leading-5 text-amber-100/80 sm:ml-[34px]">
          这台电脑上运行的是旧版助手：它会一次编排整片，容易碰上 524 超时，失败后也不能从断点继续。请先退出旧助手（任务管理器里结束 node.exe，或重启电脑），再从下方下载新版、解压后双击启动。注意：旧助手还开着的时候，新版启动脚本会直接沿用它。
        </p>
      )}
      {status === 'setup' && (
        <p className="mt-3 max-w-[66ch] text-xs leading-5 text-emerald-50/60 sm:ml-[34px]">助手已经连上了，还差一步：在助手设置里一键准备 Blender（约 400MB，只需一次），弄好后回来点「重新检查」。</p>
      )}

      {status !== 'ready' && (
        <div className="mt-3 sm:ml-[34px]">
          <button type="button" aria-expanded={showInstall} onClick={() => setShowInstall(!showInstall)} className="inline-flex min-h-9 items-center gap-1.5 text-xs text-emerald-200/80 hover:text-emerald-100">
            <ChevronRight size={14} className={`transition-transform ${showInstall ? 'rotate-90' : ''}`} />{status === 'outdated' ? '下载新版助手' : '还没装助手？'}
          </button>
          {showInstall && (
            <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex flex-wrap gap-3">
                {downloads.lightReady && <a href={downloads.light} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-medium text-[#082018] hover:bg-emerald-200"><Download size={16} />下载 Windows 助手</a>}
                <a href={`${HELPER}/setup`} target="_blank" rel="noopener noreferrer" onClick={openSetup} className={linkClass}><ExternalLink size={15} />打开助手设置</a>
              </div>
              {downloads.lightReady
                ? <p className="text-xs leading-5 text-emerald-50/55">解压后双击「启动镜感助手」。第一次启动会自动下载并校验 FFmpeg（约 99MB）；电脑上没有 Blender 时会下载官方兼容版（约 400MB），不影响你原有的安装。需要至少 3GB 空间。{downloads.offlineReady && <> 下载受阻可以用 <a href={downloads.offline} target="_blank" rel="noopener noreferrer" className="text-emerald-200 underline underline-offset-4">完整离线包</a>。</>}</p>
                : <p className="text-xs leading-5 text-amber-100/70">助手安装包还没公开发布。已经装了助手的可以直接连接；没有的话，这一步可以先跳过，提示词照样能导出。</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
