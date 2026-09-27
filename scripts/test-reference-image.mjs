import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import path from 'node:path';
const probe = { calls: [], states: [], status: 404 };
globalThis.referenceImageProbe = probe;
const result = await build({ entryPoints: ['app/components/ReferenceImage.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', plugins: [{ name: 'image-probe', setup(b) {
  b.onResolve({ filter: /^(react|next\/image|\.\.\/lib\/account-client)$/ }, ({ path }) => ({ path, namespace: 'test' }));
  b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: target }) => ({ contents: target === 'react'
    ? `let index=0;export const useEffect=()=>{};export const useRef=v=>({current:v});export const useState=v=>{const i=index++;return [i===0?'load failed':v,next=>{globalThis.referenceImageProbe.states[i]=next;}];};`
    : target === 'next/image' ? `export default function Image(){return null;}`
    : `export async function accountFetch(url,init){const p=globalThis.referenceImageProbe;p.calls.push({url,init});return p.status===200?new Response(new Blob(['image'],{type:'image/png'}),{headers:{'content-type':'image/png'}}):new Response('',{status:p.status});}` }));
} }] });
const file = path.resolve('scripts/reference-image-memory.cjs');
const mod = new Module(file); mod.filename = file; mod.paths = Module._nodeModulePaths(process.cwd()); mod._compile(result.outputFiles[0].text, file);
const tree = mod.exports.ReferenceImage({ src: '/api/assets/project/image', alt: 'reference', width: 20, height: 20 });
assert.equal(probe.calls.length, 0, 'render must not trigger generation or an extra request');
const retry = tree.props.children[1].props.children[1];
retry.props.onClick({ preventDefault() {}, stopPropagation() {} });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(probe.calls.length, 1);
assert.equal(probe.calls[0].init.cache, 'no-store');
assert.equal(probe.calls[0].init.method, undefined, 'image retry is GET only');
assert.ok(probe.states[0].includes('未找到'));
probe.status = 200;
retry.props.onClick({ preventDefault() {}, stopPropagation() {} });
await new Promise(resolve => setTimeout(resolve, 20));
assert.ok(probe.states[2].startsWith('blob:'));
URL.revokeObjectURL(probe.states[2]);
assert.equal(probe.states[0], '');
delete globalThis.referenceImageProbe;
console.log('Image reload: authenticated GET only, missing-file feedback and successful blob display passed; no model calls.');
