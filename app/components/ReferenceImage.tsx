'use client';
import Image, { type ImageProps } from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { accountFetch } from '../lib/account-client';

export function ReferenceImage(props: ImageProps) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [localUrl, setLocalUrl] = useState('');
  const epoch = useRef(0);
  const source = typeof props.src === 'string' ? props.src : '';
  useEffect(() => () => { epoch.current++; }, [source]);
  useEffect(() => () => { if (localUrl) URL.revokeObjectURL(localUrl); }, [localUrl]);
  const retry = async () => {
    if (loading) return;
    const started = epoch.current;
    setLoading(true);
    try {
      if (!source.startsWith('/api/assets/')) throw new Error('请下载图片诊断检查原地址；不要重新付费生成。');
      const response = await accountFetch(source, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? '项目中未找到这张图片，请先检查已缓存结果。' : `图片读取失败（HTTP ${response.status}），请稍后重试。`);
      if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('图片接口返回了非图片内容，请检查保存记录。');
      const blob = await response.blob();
      if (!blob.size) throw new Error('保存的图片文件为空。');
      if (started !== epoch.current) return;
      setLocalUrl(URL.createObjectURL(blob)); setError('');
    } catch (cause) { if (started === epoch.current) setError(cause instanceof Error ? cause.message : '图片读取失败。'); }
    finally { if (started === epoch.current) setLoading(false); }
  };
  return <span className="block min-w-0">
    <Image {...props} alt={props.alt} src={localUrl || props.src} onError={() => setError('图片未能加载。已保存记录仍保留，请重新读取，无需重新生成。')} />
    {error && <span role="alert" className="block p-3 text-xs leading-5 text-amber-100"><span>{error}</span><span role="button" tabIndex={0} aria-disabled={loading} onClick={event => { event.preventDefault(); event.stopPropagation(); void retry(); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void retry(); } }} className="mt-2 block cursor-pointer text-emerald-200 underline">{loading ? '正在重新读取图片…' : '重新加载图片（不调用模型）'}</span></span>}
  </span>;
}
