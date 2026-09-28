import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import path from 'node:path';
import React from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://jinggan.test' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Event']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
const result = await build({ stdin: { contents: "export { ReferenceImage } from './app/components/ReferenceImage'; export { setAccountScope } from './app/lib/account-client';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', plugins: [{ name: 'dom-image', setup(b) {
  b.onResolve({ filter: /^next\/image$/ }, () => ({ path: 'image', namespace: 'image-test' }));
  b.onLoad({ filter: /.*/, namespace: 'image-test' }, () => ({ resolveDir: process.cwd(), contents: `import React from 'react';export default function Image({unoptimized,priority,fill,...props}){return React.createElement('img',props);}` }));
} }] });
const filename = path.resolve('scripts/reference-image-memory.cjs');
const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(process.cwd()); mod._compile(result.outputFiles[0].text, filename);
mod.exports.setAccountScope('image-owner');
const originalFetch = globalThis.fetch;
const originalRevoke = URL.revokeObjectURL;
const revoked = [];
URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
const calls = [];
let status = 200, assetFailures = 0, pendingAsset;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=', 'base64');
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init?.method ?? 'GET', init });
  if (url === '/api/auth/session') return Response.json({ user: { id: 'image-owner' } });
  if (!url.startsWith('/api/assets/')) throw Error('Unexpected request: ' + url);
  if (pendingAsset) return new Promise(resolve => { pendingAsset.resolve = resolve; });
  if (assetFailures-- > 0) return Response.json({ error: 'expired session' }, { status: 401 });
  return status === 200 ? new Response(png, { headers: { 'Content-Type': 'image/png' } }) : new Response('', { status });
};
const props = { src: '/api/assets/project/image', alt: '角色参考图', width: 20, height: 20, unoptimized: true };
try {
  render(React.createElement(mod.exports.ReferenceImage, props));
  await waitFor(() => assert.equal(calls.filter(c => c.url === props.src).length, 1, 'thumbnail must read the saved image automatically through authenticated GET'));
  await waitFor(() => assert.ok(screen.getByRole('img', { name: props.alt }).src.startsWith('blob:')));
  const firstUrl = screen.getByRole('img').src;
  fireEvent.load(screen.getByRole('img'));
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(calls.find(c => c.url === props.src).init.headers.get('x-mirror-account-id'), 'image-owner');
  cleanup();
  assert.ok(revoked.includes(firstUrl), 'unmount must release the displayed image URL');

  calls.length = 0; status = 404;
  render(React.createElement(mod.exports.ReferenceImage, props));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('未找到')));
  assert.equal(screen.queryByRole('img'), null, 'a failed private image must not show the browser broken-image icon');
  status = 200;
  fireEvent.keyDown(screen.getByRole('button', { name: '重新加载图片（不调用模型）' }), { key: 'Enter' });
  await waitFor(() => assert.ok(screen.getByRole('img').src.startsWith('blob:')));
  assert.equal(screen.queryByRole('alert'), null);
  cleanup();

  calls.length = 0; assetFailures = 1;
  render(React.createElement(mod.exports.ReferenceImage, props));
  await waitFor(() => assert.ok(screen.getByRole('img').src.startsWith('blob:')));
  assert.equal(calls.filter(c => c.url === props.src).length, 2, 'expired authentication must refresh and retry only the read request');
  cleanup();

  calls.length = 0;
  render(React.createElement(React.StrictMode, null, React.createElement(mod.exports.ReferenceImage, props)));
  await waitFor(() => assert.ok(screen.getByRole('img').src.startsWith('blob:')));
  assert.equal(calls.filter(c => c.url === props.src).length, 1, 'StrictMode effect replay must not duplicate image reads');
  cleanup();

  pendingAsset = {}; calls.length = 0;
  const view = render(React.createElement(mod.exports.ReferenceImage, props));
  await waitFor(() => assert.equal(typeof pendingAsset.resolve, 'function'));
  const finishOld = pendingAsset.resolve;
  view.rerender(React.createElement(mod.exports.ReferenceImage, { ...props, src: 'data:image/png;base64,' + png.toString('base64') }));
  await act(async () => { finishOld(new Response(png, { headers: { 'Content-Type': 'image/png' } })); });
  assert.ok(screen.getByRole('img').src.startsWith('data:image/png'), 'late reads for the previous image must not replace the new source');
  cleanup();
  assert.ok(calls.every(c => c.url === '/api/auth/session' || c.method === 'GET'), 'image display and recovery must never submit a generation request');
} finally { cleanup(); globalThis.fetch = originalFetch; URL.revokeObjectURL = originalRevoke; dom.window.close(); }
console.log('Reference images: automatic authenticated thumbnails, refresh/retry, missing-file feedback, source changes and URL cleanup passed; no generation requests.');
