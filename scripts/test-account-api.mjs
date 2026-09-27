import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const sqlite = new DatabaseSync(':memory:');
const statement = (sql, values = []) => ({
  bind(...next) { return statement(sql, next); },
  async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
  async first() { return sqlite.prepare(sql).get(...values) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...values) }; },
});
globalThis.__accountDb = { prepare: statement, async batch(statements) { sqlite.exec('BEGIN'); try { const result = []; for (const item of statements) result.push(await item.run()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
const load = async entry => {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'memory-database', setup(b) {
    b.onLoad({ filter: /[\\/]server[\\/]bindings\.ts$/ }, () => ({ contents: 'export const requireDatabase=()=>globalThis.__accountDb; export const requireImages=()=>{throw Error("asset changes forbidden")};' }));
    b.onResolve({ filter: /\.sql\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'sql' }));
    b.onLoad({ filter: /.*/, namespace: 'sql' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  } }] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const store = await load('app/lib/server/project-store.ts');
await store.listProjects('user-a');
sqlite.exec(`INSERT INTO video_projects (id, owner_id, title, analysis_json, brief_json, created_at, updated_at) VALUES ('old-project','local_seedy','old','{}','{}',1,1), ('other-project','user-b','other','{}','{}',1,1);`);
assert.equal((await store.listProjects('user-a')).length, 0);
assert.equal(await store.getProject('user-a', 'other-project'), null);
await store.claimLocalProjects('user-a', ['old-project']);
assert.equal((await store.listProjects('user-a'))[0].id, 'old-project');
assert.equal((await store.listProjects('local_seedy')).length, 0);
assert.equal(await store.getProject('user-b', 'old-project'), null);
await assert.rejects(() => store.claimLocalProjects('user-b', ['old-project']), /write_conflict/);
await assert.rejects(() => store.claimLocalProjects('user-a', ['other-project']), /write_conflict/);
assert.equal(sqlite.prepare("SELECT owner_id FROM video_projects WHERE id='other-project'").get().owner_id, 'user-b');
const pipeline = await load('app/lib/server/pipeline-store.ts');
sqlite.exec("INSERT INTO projects (id, owner_id, title, created_at, updated_at) VALUES ('pipeline-a','user-a','a',1,1), ('pipeline-b','user-b','b',1,1)");
assert.equal((await pipeline.listPipelineProjects('user-a')).length, 1);
assert.equal(await pipeline.loadPipeline('pipeline-b', 'user-a'), null);

process.env.SUPABASE_URL = 'https://unit-test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_unit_test';
process.env.MIRROR_AUTH_ENABLED = 'true';
const route = await load('app/api/auth/[action]/route.ts');
const originalFetch = globalThis.fetch;
const user = { id: 'user-a', email: 'test@example.test', user_metadata: {} };
const access = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user-a', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.test`;
const session = { user, access_token: access, refresh_token: 'test-refresh', expires_in: 3600, token_type: 'bearer' };
let confirmEmail = true, providerFailure = false;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  if (providerFailure) return Response.json({ msg: 'private provider diagnostic' }, { status: 503 });
  if (String(url).includes('/auth/v1/signup')) return Response.json(confirmEmail ? { user } : session);
  if (String(url).includes('/auth/v1/token')) return Response.json(session);
  if (String(url).includes('/auth/v1/user')) return Response.json(user);
  if (String(url).includes('/rest/v1/profiles')) return Response.json([{ is_banned: false }]);
  throw new Error('unexpected network request');
};
const request = (action, body, origin = 'http://localhost:3000') => new Request(`http://localhost:3000/api/auth/${action}`, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const context = action => ({ params: Promise.resolve({ action }) });
try {
  let response = await route.POST(request('register', { email: user.email, password: 'test-password', source: 'github' }), context('register'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verifyEmail, true);
  assert.equal(response.headers.getSetCookie().length, 0);
  const signup = JSON.parse(calls.find(call => call.url.includes('/signup')).options.body);
  assert.equal(signup.data.register_source, 'jinggan_github');
  assert.equal(signup.data.phone, undefined);
  confirmEmail = false;
  response = await route.POST(request('register', { email: user.email, password: 'test-password', source: 'github' }), context('register'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal((await response.json()).user.id, 'user-a');
  response = await route.POST(request('login', { email: user.email, password: 'test-password', source: 'douyin' }), context('login'));
  assert.equal(response.status, 200);
  assert.equal(sqlite.prepare("SELECT first_source FROM account_visits WHERE user_id='user-a'").get().first_source, 'jinggan_github');
  response = await route.POST(request('session', {}, 'https://evil.test'), context('session'));
  assert.equal(response.status, 403);
  response = await route.POST(request('session', {}), context('session'));
  assert.equal(response.status, 401);
  providerFailure = true;
  response = await route.POST(request('login', { email: user.email, password: 'test-password' }), context('login'));
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private provider diagnostic'));
  response = await route.POST(request('logout', {}), context('logout'));
  assert.ok(response.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
} finally { globalThis.fetch = originalFetch; sqlite.close(); delete globalThis.__accountDb; }
console.log('Memory SQLite: project ownership/claims, pipeline isolation, registration/verification, attribution, cookie/logout and service errors passed; no real accounts or project data changed.');
