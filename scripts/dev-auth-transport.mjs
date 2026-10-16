import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ProxyAgent, fetch as proxyFetch } from 'undici';

const prefix = '/__mirror_auth_transport';
const allowed = new Map([
  ['/auth/v1/user', ['GET', 'HEAD']],
  ['/rest/v1/profiles', ['GET', 'HEAD']],
  ['/auth/v1/token', ['POST']],
  ['/auth/v1/signup', ['POST']],
]);

/** Local development only: keep the worker's account verification on a working connection. */
export function createAuthTransport({ upstreamOrigin, proxyUrl, fetchImpl = proxyFetch }) {
  const upstream = new URL(upstreamOrigin);
  const proxy = new URL(proxyUrl);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('账号服务必须是 HTTPS origin');
  }
  if (proxy.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(proxy.hostname) || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new Error('开发代理必须是本机 HTTP 代理');
  }
  const token = randomBytes(32).toString('hex');
  const dispatcher = new ProxyAgent(proxy.href);
  const reject = (res, status) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify({ error: status === 503 ? 'auth_unavailable' : 'forbidden' }));
  };
  return {
    token,
    async middleware(req, res, next) {
      if (!req.url?.startsWith(`${prefix}/`)) return next();
      const supplied = req.headers['x-mirror-auth-transport'];
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return reject(res, 403);
      const path = req.url.slice(prefix.length);
      const target = new URL(path, upstream.origin);
      if (target.origin !== upstream.origin || !allowed.get(target.pathname)?.includes(req.method) || path.split('?')[0] !== target.pathname) return reject(res, 403);
      const headers = new Headers();
      for (const key of ['apikey', 'authorization', 'content-type', 'x-client-info', 'x-supabase-api-version']) {
        if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key]);
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) return reject(res, 413);
          chunks.push(chunk);
        }
        const response = await fetchImpl(target.href, {
          method: req.method, headers, dispatcher, redirect: 'error',
          signal: AbortSignal.timeout(10000),
          ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        });
        const body = Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'private, no-store' });
        res.end(body);
      } catch (cause) {
        console.warn('Local account transport connection failed:', cause?.cause?.code || cause?.name || 'unknown');
        if (!res.headersSent) reject(res, 503);
        else res.end();
      }
    },
    close: () => dispatcher.close(),
  };
}
