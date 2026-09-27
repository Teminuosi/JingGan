import assert from 'node:assert/strict';
import { build } from 'esbuild';

const load = async entry => {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
process.env.NODE_ENV = 'production';
process.env.SUPABASE_URL = 'https://unit-test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_unit_test';
process.env.MIRROR_RELAY_ALLOWED_ORIGINS = 'https://heyroute.ai';
const upstream = [];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes('/auth/v1/user')) return Response.json({ id: 'test-user', email: 'test@example.test', user_metadata: {} });
  if (target.includes('/rest/v1/profiles')) return Response.json([{ is_banned: false }]);
  upstream.push({ target, options });
  return Response.json({ data: [{ id: 'test-model' }] });
};
const origin = 'https://jinggan.3yuedaohang.com';
const request = (headers = {}) => new Request(`${origin}/api/relay/request`, { method: 'POST', headers: { origin, cookie: 'mirror_access=test-access', 'content-type': 'application/json', 'x-relay-base': 'https://heyroute.ai/v1', 'x-relay-key': 'unit-test-only', ...headers }, body: JSON.stringify({ kind: 'models' }) });
try {
  const { deploymentFeatures } = await load('app/lib/server/deployment.ts');
  delete process.env.MIRROR_PIPELINE_ENABLED;
  delete process.env.MIRROR_HELPER_DOWNLOAD_URL;
  delete process.env.MIRROR_HELPER_OFFLINE_URL;
  const hosted = deploymentFeatures(request());
  assert.equal(hosted.pipelineEnabled, false);
  assert.equal(hosted.helperDownloads.lightReady, false);
  assert.equal(hosted.helperDownloads.light, 'https://github.com/Teminuosi/JingGan/releases');
  process.env.MIRROR_HELPER_DOWNLOAD_URL = 'javascript:alert(1)';
  assert.equal(deploymentFeatures(request()).helperDownloads.lightReady, false);
  process.env.MIRROR_HELPER_DOWNLOAD_URL = 'https://downloads.example.test/helper.zip';
  assert.equal(deploymentFeatures(request()).helperDownloads.lightReady, true);
  assert.equal(deploymentFeatures(new Request('http://localhost:3000')).pipelineEnabled, false);
  process.env.NODE_ENV = 'development';
  assert.equal(deploymentFeatures(new Request('http://localhost:3000')).pipelineEnabled, true);
  process.env.NODE_ENV = 'production';
  const route = await load('app/api/relay/request/route.ts');
  assert.equal((await route.POST(request())).status, 200, 'authenticated production request must reach configured relay');
  assert.equal(upstream.at(-1).target, 'https://heyroute.ai/v1/models');
  const count = upstream.length;
  assert.equal((await route.POST(request({ cookie: '' }))).status, 401);
  assert.equal((await route.POST(request({ origin: 'https://evil.test' }))).status, 400);
  assert.equal((await route.POST(request({ origin: '' }))).status, 400);
  assert.equal((await route.POST(request({ 'x-relay-base': 'https://api.heyroute.ai/v1' }))).status, 400, 'unconfigured allowed provider must not be proxied');
  assert.equal((await route.POST(request({ 'x-relay-base': 'https://127.0.0.1/v1' }))).status, 400);
  delete process.env.MIRROR_RELAY_ALLOWED_ORIGINS;
  assert.equal((await route.POST(request())).status, 400, 'production proxy must fail closed without explicit provider configuration');
  assert.equal(upstream.length, count, 'rejected requests must never contact a model provider');
  process.env.MIRROR_RELAY_ALLOWED_ORIGINS = 'https://heyroute.ai';
  const native = await load('app/api/relay/native/[...path]/route.ts');
  const nativeRequest = (site = 'same-origin') => new Request(`${origin}/api/relay/native/v1beta/files/test-file?key=must-not-forward`, { headers: { cookie: 'mirror_access=test-access', 'sec-fetch-site': site, 'x-relay-key': 'unit-test-only' } });
  const context = { params: Promise.resolve({ path: ['v1beta', 'files', 'test-file'] }) };
  assert.equal((await native.GET(nativeRequest(), context)).status, 200);
  assert.equal(upstream.at(-1).target, 'https://heyroute.ai/v1beta/files/test-file');
  assert.equal((await native.GET(nativeRequest('cross-site'), context)).status, 400);
  console.log('Hosted relay: authenticated allowlist, same-origin, anonymous/SSRF rejection, and fail-closed configuration passed; all upstream calls mocked.');
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}
