'use client';
import Image, { type ImageProps } from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { accountFetch } from '../lib/account-client';

export function ReferenceImage(props: ImageProps) {
  const [issue, setIssue] = useState({ source: '', message: '' });
  const [loading, setLoading] = useState(false);
  const [image, setImage] = useState({ source: '', url: '' });
  const epoch = useRef(0);
  const busy = useRef(false);
  const objectUrl = useRef('');
  const source = typeof props.src === 'string' ? props.src : '';
  const protectedSource = source.startsWith('/api/assets/');
  const localUrl = image.source === source ? image.url : '';
  const error = issue.source === source ? issue.message : '';
  const read = useCallback(async () => {
    if (busy.current) return;
    const started = epoch.current;
    busy.current = true; setLoading(true); setIssue({ source, message: '' });
    try {
      if (!source.startsWith('/api/assets/')) throw new Error('请下载图片诊断检查原地址；不要重新付费生成。');
      const response = await accountFetch(source, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? '项目中未找到这张图片，请先检查已缓存结果。' : `图片读取失败（HTTP ${response.status}），请稍后重试。`);
      if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('图片接口返回了非图片内容，请检查保存记录。');
      const blob = await response.blob();
      if (!blob.size) throw new Error('保存的图片文件为空。');
      if (started !== epoch.current) return;
      const url = URL.createObjectURL(blob);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      setImage({ source, url });
    } catch (cause) { if (started === epoch.current) setIssue({ source, message: cause instanceof Error ? cause.message : '图片读取失败。' }); }
    finally { if (started === epoch.current) { busy.current = false; setLoading(false); } }
  }, [source]);
  useEffect(() => {
    const generation = epoch.current;
    queueMicrotask(() => { if (protectedSource && epoch.current === generation) void read(); });
    return () => {
      epoch.current = generation + 1; busy.current = false;
      if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; }
    };
  }, [protectedSource, read]);
  return <span className="block min-w-0">
    {(!protectedSource || localUrl) ? <Image {...props} alt={props.alt} src={localUrl || props.src} onLoad={event => { setIssue({ source, message: '' }); props.onLoad?.(event); }} onError={event => { setIssue({ source, message: '图片未能加载。已保存记录仍保留，请重新读取，无需重新生成。' }); props.onError?.(event); }} /> : <span role="status" className={`${props.className ?? ''} flex items-center justify-center text-xs text-white/55`}>{error ? '图片暂未显示' : '正在加载图片…'}</span>}
    {error && <span role="alert" className="block p-3 text-xs leading-5 text-amber-100"><span>{error}</span><span role="button" tabIndex={0} aria-disabled={loading} onClick={event => { event.preventDefault(); event.stopPropagation(); void read(); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void read(); } }} className="mt-2 block cursor-pointer text-emerald-200 underline">{loading ? '正在重新读取图片…' : '重新加载图片（不调用模型）'}</span></span>}
  </span>;
}
