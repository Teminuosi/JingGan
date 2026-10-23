import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

// 确认框契约：confirmChoice 三选一（Esc / 遮罩 / 关闭 = cancelId），且 confirmAction 老行为不变。
// 不起浏览器：用最小 hook 替身把 ConfirmHost 当函数调用，展开 Modal 后直接点按钮。
const states = [];
let cursor = 0;
globalThis.__confirmHooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
  },
  useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index]; },
  cleanups: [],
  useEffect(effect) { if (!globalThis.__confirmHooks.mounted) { const cleanup = effect(); if (cleanup) globalThis.__confirmHooks.cleanups.push(cleanup); } },
};
const built = await build({
  stdin: { contents: "export * from './app/lib/confirm'; export { ConfirmHost } from './app/components/ConfirmHost';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'hooks', setup(builder) {
    builder.onResolve({ filter: /^(react|lucide-react)$/ }, args => ({ path: args.path, namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'react'
      ? 'export const useState = globalThis.__confirmHooks.useState; export const useRef = globalThis.__confirmHooks.useRef; export const useEffect = globalThis.__confirmHooks.useEffect;'
      : 'export const AlertTriangle = () => null; export const X = () => null;' }));
  } }],
});
const filename = path.resolve('scripts/confirm-choice-in-memory.cjs');
const compiled = new Module(filename); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(built.outputFiles[0].text, filename);
const { confirmAction, confirmChoice, ConfirmHost } = compiled.exports;

const request = {
  title: '3D 预演上传失败：测试',
  message: '三选一',
  actions: [{ id: 'cancel', label: '取消提交' }, { id: 'skip', label: '不带 3D 继续' }, { id: 'retry', label: '重试' }],
  cancelId: 'cancel',
};

// 1) 宿主没挂：confirmAction 照旧走 window.confirm；confirmChoice 退回 window.confirm（确定 = 主按钮，取消 = cancelId）。
const prompts = [];
globalThis.window = { confirm: text => { prompts.push(text); return answer; } };
let answer = true;
assert.equal(await confirmAction({ title: 'T', message: 'M', confirmLabel: '确认' }), true);
assert.equal(prompts[0], 'T\n\nM', 'confirmAction 的退路文案不变');
answer = false;
assert.equal(await confirmAction({ title: 'T', message: 'M', confirmLabel: '确认' }), false);
answer = true;
assert.equal(await confirmChoice(request), 'retry');
answer = false;
assert.equal(await confirmChoice(request), 'cancel');
delete globalThis.window.confirm;
assert.equal(await confirmChoice(request), 'cancel', '连 window.confirm 都没有时只能是取消，绝不放行');

// 2) 挂上宿主。
const render = () => { cursor = 0; return ConfirmHost(); };
const expand = node => {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(expand);
  if (typeof node.type === 'function') return [node, ...expand(node.type(node.props))];
  return [node, ...expand(node.props?.children), ...expand(node.props?.footer)];
};
const buttons = tree => expand(tree).filter(node => node.type === 'button' && typeof node.props.children === 'string');
const tick = () => new Promise(resolve => setImmediate(resolve));
assert.equal(render(), null);
globalThis.__confirmHooks.mounted = true;

// 三个按钮，按给定顺序；最后一个（重试）是主按钮且默认聚焦；点哪个返回哪个 id。
let pending = confirmChoice(request);
let tree = render();
assert.deepEqual(buttons(tree).map(node => node.props.children), ['取消提交', '不带 3D 继续', '重试']);
assert.deepEqual(buttons(tree).map(node => Boolean(node.props.autoFocus)), [false, false, true]);
assert.ok(expand(tree).some(node => node.props?.role === 'dialog' && node.props['aria-modal'] === 'true'));
buttons(tree)[1].props.onClick();
assert.equal(await pending, 'skip');
assert.equal(render(), null, '选完就收起');

// Esc → cancelId。
pending = confirmChoice(request);
tree = render();
let prevented = false;
tree.props.onKeyDown({ key: 'Enter', preventDefault() {} });
tree.props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } });
assert.equal(await pending, 'cancel');
assert.ok(prevented);

// 点遮罩 / 右上角关闭 → cancelId。
pending = confirmChoice(request);
tree = render();
const overlay = expand(tree).find(node => node.props?.role === 'dialog');
overlay.props.onMouseDown({ target: 1, currentTarget: 1 });
assert.equal(await pending, 'cancel');
pending = confirmChoice(request);
tree = render();
expand(tree).find(node => node.type === 'button' && String(node.props['aria-label']).startsWith('关闭')).props.onClick();
assert.equal(await pending, 'cancel');

// 新弹一个时，前一个按取消收掉，不悬空。
const first = confirmChoice(request);
const second = confirmChoice({ ...request, cancelId: 'skip' });
assert.equal(await first, 'cancel');
tree = render();
tree.props.onKeyDown({ key: 'Escape', preventDefault() {} });
assert.equal(await second, 'skip');

// 3) confirmAction 在宿主下行为不变：两个按钮（取消 / 确认），确认 = true，取消或关闭 = false。
let confirmPending = confirmAction({ title: '提交', message: '会扣费', confirmLabel: '确认提交', cancelLabel: '再看看', danger: true });
tree = render();
assert.deepEqual(buttons(tree).map(node => node.props.children), ['再看看', '确认提交']);
buttons(tree)[1].props.onClick();
assert.equal(await confirmPending, true);
confirmPending = confirmAction({ title: '提交', message: '会扣费', confirmLabel: '确认提交' });
tree = render();
assert.deepEqual(buttons(tree).map(node => node.props.children), ['取消', '确认提交']);
buttons(tree)[0].props.onClick();
assert.equal(await confirmPending, false);
// 确认框和三选一互相顶替时，被顶掉的那个按取消收掉。
confirmPending = confirmAction({ title: 'A', message: 'B', confirmLabel: 'C' });
pending = confirmChoice(request);
assert.equal(await confirmPending, false);
render(); buttons(render())[2].props.onClick();
assert.equal(await pending, 'retry');

// 4) 卸载：注销宿主，悬着的按取消收掉，之后退回 window.confirm。
pending = confirmChoice(request);
for (const cleanup of globalThis.__confirmHooks.cleanups) cleanup();
assert.equal(await pending, 'cancel');
globalThis.window.confirm = () => true;
assert.equal(await confirmChoice(request), 'retry');
await tick();
console.log('Confirm choice dialog: 3 actions in order, Esc/backdrop/close → cancelId, confirmAction unchanged, fallback never auto-approves.');
