import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['app/lib/server/auth-session.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { authProviderFetch } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
process.env.SUPABASE_URL = 'https://account.example.test';
process.env.NODE_ENV = 'development';
process.env.MIRROR_LOCAL_AUTH_TRANSPORT = 'http://127.0.0.1:3000/__mirror_auth_transport';
process.env.MIRROR_LOCAL_AUTH_TOKEN = 'test-local-transport-token';
const nativeFetch = globalThis.fetch;
let sent;
globalThis.fetch = async (input, init) => { sent = { input, url: input instanceof Request ? input.url : String(input), init }; return Response.json({ ok: true }); };
try {
  await authProviderFetch('https://account.example.test/auth/v1/user', { headers: { apikey: 'test-public-key', Authorization: 'Bearer test-session' } });
  assert.equal(sent.url, 'http://127.0.0.1:3000/__mirror_auth_transport/auth/v1/user');
  assert.equal(new Headers(sent.init.headers).get('x-mirror-auth-transport'), 'test-local-transport-token');
  assert.equal(new Headers(sent.init.headers).get('authorization'), 'Bearer test-session');
  assert.equal(sent.init.redirect, 'manual', 'workerd does not support redirect:error; never forward local redirects');
  await authProviderFetch(new Request('https://account.example.test/auth/v1/token', { method: 'POST', headers: { Authorization: 'Bearer test-session' }, body: 'refresh-body' }));
  assert.equal(sent.input.method, 'POST');
  assert.equal(await sent.input.text(), 'refresh-body');
  assert.equal(new Headers(sent.init.headers).get('authorization'), 'Bearer test-session');
  process.env.NODE_ENV = 'production';
  await authProviderFetch('https://account.example.test/auth/v1/user');
  assert.equal(sent.url, 'https://account.example.test/auth/v1/user', 'Production must never use the local transport');
  process.env.NODE_ENV = 'development';
  await authProviderFetch('https://unrelated.example.test/other');
  assert.equal(sent.url, 'https://unrelated.example.test/other', 'Only the configured account service may use this path');
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://unrelated.example.test' } }); };
  await assert.rejects(authProviderFetch('https://account.example.test/auth/v1/token', { method: 'POST' }), /redirect/);
  assert.equal(calls, 1, 'Do not retry token mutations or follow redirects');
} finally { globalThis.fetch = nativeFetch; }

const { createAuthTransport } = await import('./dev-auth-transport.mjs');
assert.throws(() => createAuthTransport({ upstreamOrigin: 'https://account.example.test', proxyUrl: 'http://remote-proxy.example:8080' }), /本机/);
const requests = [];
let upstreamStatus = 200;
const transport = createAuthTransport({ upstreamOrigin: 'https://account.example.test', proxyUrl: 'http://127.0.0.1:10808', fetchImpl: async (url, init) => {
  requests.push({ url: String(url), init });
  return Response.json(upstreamStatus === 200 ? { user: { id: 'verified-upstream' } } : { error: 'unauthorized' }, { status: upstreamStatus });
} });
const server = createServer((req, res) => transport.middleware(req, res, () => { res.writeHead(404); res.end(); }));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { 'x-mirror-auth-transport': transport.token, apikey: 'test-public-key', Authorization: 'Bearer test-session' };
try {
  assert.equal((await fetch(`${base}/__mirror_auth_transport/auth/v1/user`)).status, 403, 'Browsers cannot use a transport without its server-only token');
  assert.equal(requests.length, 0);
  assert.equal((await fetch(`${base}/__mirror_auth_transport/storage/v1/object`, { headers })).status, 403);
  assert.equal((await fetch(`${base}/__mirror_auth_transport/auth/v1/user`, { method: 'DELETE', headers })).status, 403);
  assert.equal(requests.length, 0, 'Unsupported paths/methods must never reach the proxy');
  const response = await fetch(`${base}/__mirror_auth_transport/auth/v1/user`, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, 'verified-upstream');
  assert.equal(requests[0].url, 'https://account.example.test/auth/v1/user');
  assert.equal(requests[0].init.headers.get('authorization'), 'Bearer test-session');
  assert.equal(requests[0].init.headers.has('x-mirror-auth-transport'), false, 'Do not leak the local transport credential upstream');
  assert.equal(requests[0].init.redirect, 'error', 'Credentialed requests cannot redirect to another host');
  const refreshBody = JSON.stringify({ refresh_token: 'test-refresh' });
  await fetch(`${base}/__mirror_auth_transport/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: refreshBody });
  assert.equal(requests.length, 2, 'Transport must not automatically repeat token mutations');
  assert.equal(requests[1].init.body.toString(), refreshBody);
  upstreamStatus = 401;
  assert.equal((await fetch(`${base}/__mirror_auth_transport/auth/v1/user`, { headers })).status, 401, 'Invalid sessions remain rejected by the upstream account provider');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await transport.close();
}
console.log('Local auth transport: verified upstream responses preserved, development-only routing, loopback proxy, token guard, path/method allowlist, no credential redirects or mutation retries.');
