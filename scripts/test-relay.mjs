import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { GoogleGenAI } from '../node_modules/@google/genai/dist/web/index.mjs';

process.on('uncaughtException', error => { console.error(error.message); process.exitCode = 1; });

const load = async path => {
  const result = await build({ stdin: { contents: `export * from ${JSON.stringify('./' + path)}; export { setAccountScope } from './app/lib/account-client';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const { relayOrigin, redactRelayError, readRelayResponse, textFromResult, requireRelayText } = await load('app/lib/relay-protocol.ts');
assert.equal(relayOrigin('https://heyroute.ai/v1/'), 'https://heyroute.ai');
for (const url of ['http://heyroute.ai', 'https://example.com', 'https://heyroute.ai@evil.com', 'https://heyroute.ai/v1/models', 'https://heyroute.ai/?key=secret', 'https://127.0.0.1']) assert.throws(() => relayOrigin(url));
assert.ok(!redactRelayError('bad sk-testingsecret').includes('sk-testingsecret'));
const sse = (text, chunkSize = 3) => new Response(new ReadableStream({ start(controller) { const data = new TextEncoder().encode(text); for (let i = 0; i < data.length; i += chunkSize) controller.enqueue(data.slice(i, i + chunkSize)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
const events = [];
const image = await readRelayResponse(sse('event: started\r\ndata: {}\r\n\r\nevent: heartbeat\r\ndata: {}\r\n\r\nevent: completed\r\ndata: {"data":[{"b64_json":"AA=="}]}\r\n\r\nevent: done\ndata: {}\n\n'), e => events.push(e));
assert.equal(image.data[0].b64_json, 'AA==');
assert.deepEqual(events, ['started', 'heartbeat', 'completed']);
const chat = await readRelayResponse(sse('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', 1));
assert.equal(textFromResult(chat), '你好');
const response = await readRelayResponse(sse('event: response.completed\ndata: {"response":{"output":[{"content":[{"text":"{\\"ok\\":true}"}]}]}}\n\n'));
assert.equal(textFromResult(response), '{"ok":true}');
// Relay completion notifications may omit the text already sent in deltas.
const deltaThenEmpty = await readRelayResponse(sse('event: response.output_text.delta\ndata: {"delta":"正文"}\n\nevent: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\n', 1));
assert.equal(requireRelayText(deltaThenEmpty), '正文');
const genericEvent = await readRelayResponse(sse('event: message\ndata: {"type":"response.output_text.delta","delta":"正文"}\n\nevent: message\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'));
assert.equal(requireRelayText(genericEvent), '正文');
const doneOnly = await readRelayResponse(sse('event: response.output_text.done\ndata: {"text":"完整正文"}\n\nevent: completed\ndata: {}\n\n'));
assert.equal(requireRelayText(doneOnly), '完整正文');
assert.equal(requireRelayText({ data: { response: { output: [{ type: 'reasoning', content: [{ text: 'do not extract' }] }, { type: 'message', content: [{ type: 'output_text', text: '故事' }] }] } } }), '故事');
assert.equal(requireRelayText({ choices: [{ message: { content: [{ type: 'text', text: '故事' }] } }] }), '故事');
assert.throws(() => requireRelayText({ output: [{ type: 'reasoning', content: [{ text: 'not final' }] }] }), /未读到故事正文/);
assert.equal(requireRelayText({ choices: [{ text: 'legacy completion' }] }), 'legacy completion');
assert.doesNotThrow(() => JSON.parse(redactRelayError(JSON.stringify({ text: 'x'.repeat(1000), key: 'sk-testingsecret' }), '', Infinity)));
await assert.rejects(readRelayResponse(sse('event: heartbeat\ndata: {}\n\n')), /未收到完成/);
await assert.rejects(readRelayResponse(sse('event: error\ndata: {"error":{"message":"failed"}}\n\n')), /failed/);
await assert.rejects(readRelayResponse(sse('data: {"choices":[{"finish_reason":"length"}]}\n\n')), /长度限制/);
await assert.rejects(readRelayResponse(new Response('<html>secret</html>', { status: 503 })), /503/);

// Entire network layer is mocked: no real API key, upload, or billed request.
const originalFetch = globalThis.fetch;
const previousEnv = process.env.NODE_ENV;
const previousAuth = process.env.MIRROR_AUTH_ENABLED;
process.env.NODE_ENV = 'development';
process.env.MIRROR_AUTH_ENABLED = 'false'; // Route protocol tests; authentication has its own dedicated tests.
try {
  const { POST } = await load('app/api/relay/request/route.ts');
  const native = await load('app/api/relay/native/[...path]/route.ts');
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), ...options }); return Response.json({ data: [{ id: 'test-model' }] }); };
  const makeRequest = (body, headers = {}) => new Request('http://localhost:3000/api/relay/request', { method: 'POST', headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json', 'x-relay-base': 'https://heyroute.ai/v1', 'x-relay-key': 'unit-test-only', ...headers }, body: JSON.stringify(body) });
  const result = await POST(makeRequest({ kind: 'models' }));
  assert.equal(result.status, 200); assert.equal(calls.at(-1).url, 'https://heyroute.ai/v1/models'); assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).headers.get('Authorization'), 'Bearer unit-test-only');
  await POST(makeRequest({ kind: 'image', payload: { model: 'test-image', n: 1 } }));
  assert.equal(calls.at(-1).url, 'https://heyroute.ai/v1/images/generations');
  const count = calls.length;
  assert.equal((await POST(makeRequest({ kind: 'models' }, { origin: 'https://evil.com' }))).status, 400);
  assert.equal((await POST(makeRequest({ kind: 'models' }, { 'x-relay-key': '' }))).status, 400);
  assert.equal((await POST(makeRequest({ kind: 'toString' }))).status, 400);
  assert.equal((await POST(makeRequest({ kind: 'models' }, { 'x-relay-base': 'https://evil.com' }))).status, 400);
  assert.equal(calls.length, count);
  const nativeRequest = new Request('http://localhost:3000/api/relay/native/v1beta/models/test:generateContent?key=never-forward-query', { method: 'POST', headers: { 'x-relay-base': 'https://heyroute.ai/v1', 'x-relay-key': 'unit-test-only', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await native.POST(nativeRequest, { params: Promise.resolve({ path: ['v1beta', 'models', 'test:generateContent'] }) })).status, 200);
  assert.equal(calls.at(-1).url, 'https://heyroute.ai/v1beta/models/test:generateContent');
  assert.equal(calls.at(-1).headers.get('x-goog-api-key'), 'unit-test-only');

  const sdkCalls = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url); sdkCalls.push({ url: target, ...options });
    if (target.includes('upload') && !target.includes('upload_id')) return new Response('{}', { headers: { 'x-goog-upload-url': 'http://localhost:3000/api/relay/native/upload/v1beta/files?upload_id=test' } });
    if (target.includes('upload_id')) return Response.json({ file: { name: 'files/test', uri: 'https://heyroute.ai/v1beta/files/test', state: 'ACTIVE' } }, { headers: { 'x-goog-upload-status': 'final' } });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
  };
  const ai = new GoogleGenAI({ apiKey: 'unit-test-only', httpOptions: { baseUrl: 'http://localhost:3000/api/relay/native', apiVersion: 'v1beta', headers: { 'x-relay-base': 'https://heyroute.ai/v1', 'x-relay-key': 'unit-test-only' }, retryOptions: { attempts: 1 } } });
  await ai.models.generateContent({ model: 'test', contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'video/mp4', data: 'AA==' } }, { text: 'analyze' }] }] });
  assert.equal(sdkCalls[0].url, 'http://localhost:3000/api/relay/native/v1beta/models/test:generateContent');
  assert.ok(sdkCalls[0].body.includes('video/mp4'));
  await ai.files.upload({ file: new Blob(['test'], { type: 'video/mp4' }), config: { mimeType: 'video/mp4' } });
  assert.ok(sdkCalls.every(c => c.url.startsWith('http://localhost:3000/api/relay/native/')));
  assert.ok(sdkCalls.at(-1).url.includes('upload_id=test'));
  assert.equal(new Headers(sdkCalls.at(-1).headers).get('x-relay-key'), 'unit-test-only');
  // ---- 付费确认走统一弹窗，不再用系统原生 confirm ----
  // 这几处确认都出现在「即将扣费」「上次可能已扣费」的时刻，用系统弹窗既难看又不可信。
  const confirmMod = await load('app/lib/confirm.ts');
  const asked = [];
  confirmMod.setConfirmHandler(async (request) => { asked.push(request); return false; });
  assert.equal(await confirmMod.confirmAction({ title: 't', message: 'm', confirmLabel: 'ok' }), false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 't');
  confirmMod.setConfirmHandler(async () => true);
  assert.equal(await confirmMod.confirmAction({ title: 't', message: 'm', confirmLabel: 'ok' }), true);
  // 宿主没挂上时必须退回 window.confirm：宁可难看，也绝不静默放行付费动作。
  confirmMod.setConfirmHandler(null);
  const originalConfirm = globalThis.window?.confirm;
  globalThis.window = globalThis.window ?? {};
  let fellBack = false;
  globalThis.window.confirm = () => { fellBack = true; return false; };
  assert.equal(await confirmMod.confirmAction({ title: 't', message: 'm', confirmLabel: 'ok' }), false);
  assert.ok(fellBack, '没有宿主时必须退回 window.confirm，不能默认放行');
  if (originalConfirm) globalThis.window.confirm = originalConfirm;

  // ---- 参数探测绝不能带参考素材 ----
  // 空 prompt 之所以安全，是因为"没有内容就生成不了东西"。一旦带上图，请求就变成了合法的图生视频，
  // 这道保险立刻失效：2026-09-10 手工试过一次，中转没拒绝，直接转发给上游并一直挂着。
  {
    const store = new Map([
      ['mirror:account:test-user:mirror:relay:v1:video', JSON.stringify({ baseUrl: 'https://heyroute.ai/v1', model: 'seedance-2.5' })],
      ['mirror:account:test-user:mirror:relay:v1:video:key', 'unit-test-only'],
    ]);
    globalThis.window = globalThis.window ?? {};
    globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
    globalThis.sessionStorage = globalThis.localStorage;
    const sent = [];
    globalThis.fetch = async (url, options) => { if (url === '/api/auth/session') return Response.json({ user: { id: 'test-user' } }); sent.push(JSON.parse(options.body)); return Response.json({ error: 'seconds must be between 4 and 30' }, { status: 400 }); };
    const { probeVideoParam, setAccountScope } = await load('app/lib/relay-client.ts');
    setAccountScope('test-user');
    await probeVideoParam({ seconds: '9999', images: ['data:image/jpeg;base64,AA'], input_reference: 'data:x', reference_images: ['x'], first_frame: 'x' });
    const payload = sent.at(-1).payload;
    assert.equal(payload.prompt, '', '探测必须用空提示词');
    assert.equal(payload.seconds, '9999');
    for (const forbidden of ['images', 'input_reference', 'reference_images', 'first_frame']) {
      assert.ok(!(forbidden in payload), `探测请求里绝不能出现 ${forbidden}`);
    }
  }

  console.log('Relay tests passed: SSE chunking/errors, paid-action confirm bridge, route guards, credential redaction, model discovery, native video paths, upload headers, and probe never carries reference media. No real network requests.');
} finally { globalThis.fetch = originalFetch; if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv; if (previousAuth === undefined) delete process.env.MIRROR_AUTH_ENABLED; else process.env.MIRROR_AUTH_ENABLED = previousAuth; }
