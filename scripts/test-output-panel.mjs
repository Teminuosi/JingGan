import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const states = [];
let cursor = 0;
globalThis.__outputHooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
  },
};
const storage = new Map();
globalThis.window = {};
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
globalThis.sessionStorage = { getItem: () => null };
let copied = '';
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(text) { copied = text; } } } });
globalThis.fetch = () => { throw new Error('Network/model requests forbidden'); };
const built = await build({ entryPoints: ['app/components/OriginalOutputPanel.tsx', 'app/components/VideoTargetPanel.tsx'], bundle: true, write: false, outdir: 'memory', platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', plugins: [{ name: 'hooks', setup(builder) {
  builder.onResolve({ filter: /^(react|next\/image)$/ }, args => ({ path: args.path, namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'react'
    ? 'export const useState = globalThis.__outputHooks.useState; export const useMemo = fn => fn(); export const useEffect = () => {};'
    : 'export default function Image() { return null; }' }));
} }] });
function load(name) {
  const output = built.outputFiles.find(file => file.path.endsWith(`${name}.js`));
  const filename = path.resolve(`scripts/${name}-in-memory.cjs`);
  const compiled = new Module(filename); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(process.cwd());
  compiled._compile(output.text, filename); return compiled.exports;
}
const { VideoTargetPanel } = load('VideoTargetPanel');
const { OriginalOutputPanel } = load('OriginalOutputPanel');
const run = { run_id: 'RUN_01', beat_ids: ['BEAT_001'], source_start_seconds: 0, source_end_seconds: 9.6, duration_seconds: 9.6, target_prompt: '[素材绑定]\n\nCHAR_A = 【绑定图片】\n\n原提示词' };
const pack = { title: '测试', concept_summary: '测试', beats: [{ beat_id: 'BEAT_001', character_ids: ['CHAR_A'] }], seedance_asset_map: { runs: [run], bindings: [{ kind: 'character_reference', character_id: 'CHAR_A', asset_id: 'asset' }], full_run: { ...run, run_id: 'FULL_RUN', duration_seconds: 141.83, within_character_limit: true } } };
const props = { pack, referenceAssets: [{ asset_id: 'asset', uri: 'data:image/png;base64,AAAA', mime_type: 'image/png' }], projectId: 'test-only', videoModelId: 'seedance-2.5', onVideoModelChange() {} };
function panel() { cursor = 0; return VideoTargetPanel(props); }
function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
const button = (tree, text) => nodes(tree).find(node => node.type === 'button' && node.props.children === text);
let tree = panel();
assert.equal(nodes(tree).filter(node => node.type === 'article').length, 1);
assert.equal(nodes(tree).filter(node => node.type === 'textarea').length, 1);
nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'edited action' } });
tree = panel();
assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, 'edited action');
await button(tree, '复制提示词').props.onClick();
assert.equal(copied, 'edited action');
await button(tree, '复制 API 请求体').props.onClick();
await new Promise(resolve => setImmediate(resolve));
const body = JSON.parse(copied);
assert.match(body.prompt, /edited action/);
assert.equal(body.images.length, 1);
assert.equal(body.videos, undefined);
assert.equal(pack.seedance_asset_map.runs[0].target_prompt, run.target_prompt);
assert.ok(storage.has('mirror:output-prompts:test-only'));
states.length = 0;
tree = panel();
assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, 'edited action');
props.preserve = true;
states[1] = { ticket: { id: 'test-job', token: 'test-token' }, shots: [{ index: 1, beatId: 'BEAT_001', start: 0, end: 9.6 }] };
tree = panel();
assert.equal(nodes(tree).filter(node => node.type === 'button' && node.props.children === '复制含 3D 绑定的提示词').length, 0);
assert.equal(nodes(tree).filter(node => node.type === 'button' && node.props.children === '复制提示词').length, 1);
const withVideo = nodes(tree).find(node => node.type === 'textarea').props.value;
assert.ok(withVideo.indexOf('3D 参考 =') < withVideo.indexOf('edited action'));
await button(tree, '复制提示词').props.onClick();
assert.equal(copied, withVideo);
nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: withVideo } });
tree = panel();
await button(tree, '复制 API 请求体').props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.ok(!JSON.parse(copied).prompt.includes('3D 参考 ='));
props.preserve = false;
nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'x'.repeat(4001) } });
tree = panel();
assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value.length, 4001);
assert.equal(button(tree, '复制提示词').props.disabled, true);
assert.equal(button(tree, '提交生成').props.disabled, true);
states.length = 0; cursor = 0;
const outer = OriginalOutputPanel(props);
assert.equal(nodes(outer).filter(node => node.type === 'section').length, 0);
assert.equal(nodes(outer).filter(node => node.type === 'summary' && JSON.stringify(node.props.children).includes('整片导出')).length, 1);
assert.ok(JSON.stringify(outer).includes('不能整片直接提交'));
const wholeText = nodes(outer).find(node => node.type === 'pre').props.children;
assert.ok(wholeText.includes('【整片 3D 预演视频】'));
await button(outer, '复制整片到即梦').props.onClick();
assert.equal(copied, wholeText);
console.log('Unified output panel: edited request/copy, image binding, local persistence, separate full export passed; no network calls.');
