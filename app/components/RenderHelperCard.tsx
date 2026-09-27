'use client';
import { useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { useAccountConfig } from './AccountWorkspace';

export function RenderHelperCard() {
  const { helperDownloads } = useAccountConfig();
  const downloads = helperDownloads || { light: 'https://github.com/Teminuosi/JingGan/releases', offline: 'https://github.com/Teminuosi/JingGan/releases', lightReady: false, offlineReady: false };
  const [message, setMessage] = useState('首次使用？下载并启动助手，再一键准备 Blender。');
  const [checking, setChecking] = useState(false);
  const setup = 'http://127.0.0.1:43128/setup';
  const check = async () => {
    setChecking(true);
    try {
      const response = await fetch('http://127.0.0.1:43128/health', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const health = await response.json() as { ready: boolean; environment?: { message: string } };
      setMessage(health.ready ? '助手已连接，渲染环境已就绪，可以开始生成预演。' : health.environment?.message || '助手已启动，请打开助手设置准备 Blender。');
    } catch { setMessage('暂未连接助手。请先启动；云端网站首次连接需在助手设置中授权网址，并允许浏览器的本地网络访问。'); }
    finally { setChecking(false); }
  };
  return <section className="mb-6 rounded-2xl border border-emerald-200/15 bg-emerald-200/[0.035] p-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="font-semibold text-emerald-50">本机渲染助手</h3><p role="status" className="mt-2 max-w-3xl text-sm leading-6 text-emerald-50/65">{message}</p></div><button type="button" onClick={() => void check()} disabled={checking} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-200/20 px-4 text-sm text-emerald-100 disabled:opacity-50"><RefreshCw size={15} className={checking ? 'animate-spin' : ''} />{checking ? '正在检查…' : '检查助手'}</button></div>
    <div className="mt-4 flex flex-wrap gap-3"><a href={downloads.light} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-300 px-4 text-sm font-medium text-emerald-950"><Download size={16} />{downloads.lightReady ? '下载 Windows 助手' : '查看助手发布页'}</a><a href={setup} target="_blank" rel="noopener noreferrer" onClick={event => { event.currentTarget.href = `${setup}?site=${encodeURIComponent(window.location.origin)}`; }} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-200/20 px-4 text-sm text-emerald-100"><ExternalLink size={16} />打开助手设置</a></div>
    {!downloads.lightReady && <p className="mt-3 text-xs leading-5 text-amber-100/70">助手安装包尚未公开发布。已有助手可直接连接；新用户可先使用分析、角色设计和分镜提示词功能。</p>}
    <p className="mt-3 text-xs leading-5 text-emerald-50/45">解压后双击“启动镜感助手”。助手自带运行环境；缺少 Blender 时下载官方兼容版，原有安装不受影响。首次约 400MB，需要至少 3GB 空间。下载受阻可查看 <a href={downloads.offline} target="_blank" rel="noopener noreferrer" className="text-emerald-200 underline underline-offset-4">{downloads.offlineReady ? '完整离线包' : '离线包发布页'}</a>。</p>
  </section>;
}
