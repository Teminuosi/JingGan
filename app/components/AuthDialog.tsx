'use client';
import { useState } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Modal, overlayButton } from './Overlay';
import type { AccountConfig, AccountUser } from '../lib/auth-protocol';
import { submitAccount } from '../lib/account-client';

export function AuthDialog({ mode, config, source, locked, onMode, onClose, onLogin }: {
  mode: 'login' | 'register'; config: AccountConfig; source: string; locked: boolean;
  onMode: (mode: 'login' | 'register') => void; onClose: () => void; onLogin: (user: AccountUser) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const field = 'w-full rounded-xl border border-white/15 bg-[#07120f] px-4 py-3 text-sm text-white outline-none focus:border-emerald-300/60';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === 'register' && password !== confirm) { setError('两次密码不一致。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await submitAccount(mode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, source }), signal: AbortSignal.timeout(30000) });
      const result = await response.json() as { user?: AccountUser; error?: string; verifyEmail?: boolean; message?: string };
      if (!response.ok) throw new Error(result.error || '账号操作未完成，请重试。');
      setPassword(''); setConfirm('');
      if (result.user) onLogin(result.user);
      else { setNotice(result.message || '请到邮箱完成验证后登录。'); onMode('login'); }
    } catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' && cause.name !== 'TypeError' ? cause.message : '连接账号服务失败，请稍后重试。'); }
    finally { setBusy(false); }
  };
  return <Modal open size="sm" title={mode === 'login' ? '登录镜感' : '免费注册'} onClose={() => { if (!busy && !locked) onClose(); }} description="与三月导航共用账号。已有账号直接登录，无需重新注册。">
    {!config.configured && <p role="alert" className="mb-4 rounded-xl border border-amber-200/20 bg-amber-200/5 p-3 text-sm leading-6 text-amber-100">账号服务尚未配置。请在 .env.local 配置 Supabase，并重新启动镜感；详见 docs/account-login.md。</p>}
    {locked && <p className="mb-4 text-sm leading-6 text-amber-100">登录已过期，编辑内容仍保留。请用原账号登录后继续；使用其他账号会切换到该账号的工作区。</p>}
    <form onSubmit={event => void submit(event)} className="space-y-4">
      <label className="block text-sm">邮箱<input name="email" type="email" autoComplete="email" required maxLength={254} className={`${field} mt-2`} placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label className="block text-sm">密码<div className="relative mt-2"><input name="password" type={visible ? 'text' : 'password'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={6} maxLength={128} className={`${field} pr-12`} placeholder="至少 6 位" value={password} onChange={event => setPassword(event.target.value)} /><button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} className="absolute right-3 top-3.5 text-white/50" onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
      {mode === 'register' && <label className="block text-sm">确认密码<input name="confirm" type="password" autoComplete="new-password" required className={`${field} mt-2`} value={confirm} onChange={event => setConfirm(event.target.value)} /></label>}
      {error && <p role="alert" className="text-sm leading-6 text-rose-200">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-emerald-300/10 p-3 text-sm leading-6 text-emerald-100">{notice}</p>}
      <button type="submit" disabled={busy || !config.configured} className={`${overlayButton.primary} w-full justify-center disabled:opacity-40`}>{busy && <LoaderCircle size={16} className="animate-spin" />}{busy ? '正在连接…' : mode === 'register' ? '注册账号' : '登录并开始创作'}</button>
      <div className="flex flex-wrap justify-between gap-3 text-sm"><button type="button" disabled={busy} className="text-emerald-200" onClick={() => { setError(''); setNotice(''); onMode(mode === 'login' ? 'register' : 'login'); }}>{mode === 'login' ? '没有账号？免费注册' : '已有账号？去登录'}</button><a href={config.blogUrl} target="_blank" rel="noopener noreferrer" className="text-white/50">忘记密码？前往账号中心</a></div>
      <p className="text-xs leading-5 text-white/40">工具免费使用；AI 模型调用费用由你自己的中转账户承担。</p>
    </form>
  </Modal>;
}
