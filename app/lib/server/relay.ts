import { relayOrigin, redactRelayError } from '../relay-protocol';

export function assertLocalRelay(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || (origin && origin !== url.origin)) {
    throw new Error('中转接口仅允许本机同源访问，不提供公开代理。');
  }
}

export async function forwardRelay(request: Request, path: string, body: BodyInit | null, method = 'POST', extraHeaders?: HeadersInit) {
  assertLocalRelay(request);
  const base = relayOrigin(request.headers.get('x-relay-base') || 'https://heyroute.ai/v1');
  const key = request.headers.get('x-relay-key') || request.headers.get('x-goog-api-key') || '';
  if (!key.trim() || /[\r\n]/.test(key)) return Response.json({ error: '请先配置对应中转 Key。' }, { status: 400 });
  const headers = new Headers(extraHeaders);
  headers.set('Authorization', `Bearer ${key}`);
  if (path.includes('v1beta')) headers.set('x-goog-api-key', key);
  try {
    const response = await fetch(`${base}${path}`, {
      method, headers, body, redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20 * 60 * 1000)]),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    });
    if (!response.ok && response.status !== 308) {
      const raw = await response.text();
      let message = '';
      // 上游常把真正的错再套一层 JSON 字符串（message 里还是一段 JSON），逐层剥到最里面那句人话为止。
      const unwrap = (value: unknown, depth = 0): string => {
        if (depth > 3) return '';
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed.startsWith('{')) { try { return unwrap(JSON.parse(trimmed), depth + 1) || trimmed; } catch { return trimmed; } }
          return trimmed;
        }
        if (value && typeof value === 'object') {
          const node = value as Record<string, unknown>;
          for (const key of ['message', 'error', 'detail', 'msg']) {
            const found = unwrap(node[key], depth + 1);
            if (found) return found;
          }
        }
        return '';
      };
      try { message = unwrap(JSON.parse(raw)); } catch { /* Do not reflect an upstream HTML page. */ }
      return Response.json({ error: redactRelayError(message || `中转返回 HTTP ${response.status}`, key), requestId: response.headers.get('x-request-id') }, { status: response.status >= 400 ? response.status : 502 });
    }
    const out = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': response.headers.get('content-type') || 'application/json' });
    for (const [name, value] of response.headers) {
      if (name.startsWith('x-goog-upload-')) {
        if (name === 'x-goog-upload-url') {
          const upload = new URL(value);
          if (upload.origin !== base || !upload.pathname.startsWith('/upload/')) throw new Error('上传返回了非当前中转站地址，已停止以免密钥泄露。');
          out.set(name, `${new URL(request.url).origin}/api/relay/native${upload.pathname}${upload.search}`);
        } else out.set(name, value);
      }
    }
    return new Response(response.body, { status: response.status, headers: out });
  } catch (error) {
    const detail = error instanceof Error && error.message.includes('密钥泄露') ? error.message : '连接中转失败或超时。提交后断连不代表未扣费，请先查看中转日志，不要立即重复生成。';
    return Response.json({ error: detail }, { status: 502 });
  }
}
