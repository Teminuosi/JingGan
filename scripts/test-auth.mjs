import assert from 'node:assert/strict';
import { build } from 'esbuild';
const load = async entry => {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
process.env.MIRROR_AUTH_ENABLED = 'true';
const { requireOwner } = await load('app/lib/server/auth.ts');
await assert.rejects(async () => requireOwner(new Request('http://localhost:3000/api/projects')), /unauthorized|auth_not_configured/);
await assert.rejects(async () => requireOwner(new Request('http://localhost:3000/api/projects', { headers: { 'oai-authenticated-user-id': 'victim' } })), /unauthorized|auth_not_configured/);
console.log('anonymous and forged identity headers rejected');
process.env.SUPABASE_URL = 'https://unit-test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_unit_test';
const sessions = await load('app/lib/server/auth-session.ts');
const protocol = await load('app/lib/auth-protocol.ts');
assert.equal(protocol.registrationSource('github'), 'jinggan_github');
assert.equal(protocol.registrationSource('jinggan_blog'), 'jinggan_blog');
assert.equal(protocol.registrationSource('https://evil.test/?secret=1'), 'jinggan');
assert.equal(protocol.registrationSource({ channel: 'github' }), 'jinggan');
const user = { id: 'user-a', email: 'test@example.test', user_metadata: { full_name: 'Test' } };
const originalFetch = globalThis.fetch;
let banned = false, failure = false, calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  if (failure) throw new Error('do not expose provider or token details');
  if (String(url).includes('/auth/v1/user')) return Response.json(user);
  if (String(url).includes('/rest/v1/profiles')) return Response.json([{ is_banned: banned }]);
  throw new Error('network prohibited');
};
try {
  const request = new Request('http://localhost:3000/api/projects', { headers: { cookie: 'mirror_access=test-access', 'oai-authenticated-user-id': 'victim' } });
  assert.equal(await requireOwner(request), 'user-a');
  assert.ok(calls.some(call => call.url.includes('id=eq.user-a')));
  banned = true;
  await assert.rejects(() => requireOwner(request), /account_banned/);
  banned = false; failure = true;
  await assert.rejects(() => requireOwner(request), /auth_unavailable/);
  const response = sessions.sessionResponse(request, { user }, { access_token: 'test-access', refresh_token: 'test-refresh' });
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.ok(response.headers.getSetCookie().every(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && !cookie.includes('Secure')));
  assert.ok(sessions.sessionResponse(new Request('https://example.test'), {}, { access_token: 'a', refresh_token: 'b' }).headers.getSetCookie().every(cookie => cookie.includes('Secure')));
  assert.ok(sessions.sessionResponse(request, {}, null).headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
  process.env.MIRROR_LOCAL_CLAIMS = 'true';
  process.env.NODE_ENV = 'development';
  assert.throws(() => sessions.assertLocalClaim(new Request('http://localhost:3000/api/projects/claim')), /forbidden_origin/);
  assert.doesNotThrow(() => sessions.assertLocalClaim(new Request('http://localhost:3000/api/projects/claim', { headers: { origin: 'http://localhost:3000' } })));
  assert.throws(() => sessions.assertLocalClaim(new Request('https://example.test/api/projects/claim', { headers: { origin: 'https://example.test' } })), /forbidden_origin/);
} finally { globalThis.fetch = originalFetch; }
console.log('verified identity, ban, provider failure, cookies, attribution and local claim guards passed');
