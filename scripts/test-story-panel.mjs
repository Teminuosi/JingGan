import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

// Exercise the real panel handlers with in-memory hooks and a cache-only relay.
// No browser storage, project writes or model requests are used.
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
const probe = { keys: [], saves: [], states: [], result: null, error: null };
globalThis.__storyPanelProbe = probe;
const built = await build({
  entryPoints: ['app/components/StoryPanel.tsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'isolated-panel', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
    builder.onResolve({ filter: /\/relay-client$/ }, () => ({ path: 'relay', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: target }) => ({ contents: target === 'hooks'
      ? `export const useEffect = () => {}; export const useRef = value => ({current:value}); export const useState = value => [typeof value === 'function' ? value() : value, next => globalThis.__storyPanelProbe.states.push(next)];`
      : `export async function recoverRelayTask(key) { const p = globalThis.__storyPanelProbe; p.keys.push(key); if(p.error) throw p.error; return p.result; } export function generateRelayText() { throw new Error('Model calls forbidden'); } export function loadConnection() { return {apiKey:''}; }` }));
  } }],
});
const filename = path.resolve('scripts/story-panel-in-memory.cjs');
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(built.outputFiles[0].text, filename);
const { StoryPanel } = compiled.exports;
const helpers = await build({ entryPoints: ['app/lib/original-story.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { projectPreservedDraft } = await import(`data:text/javascript;base64,${Buffer.from(helpers.outputFiles[0].text).toString('base64')}`);
const analysis = JSON.parse(await readFile('fixtures/video-dna.v1.json', 'utf8'));
const projected = projectPreservedDraft(analysis);
const brief = { storyMode: 'preserve', outputLanguage: 'English', aspectRatio: '9:16', sourceRightsScope: 'owned_or_authorized', newConcept: '', voiceBrief: '', settingBrief: '', characterBrief: '', dialogueBrief: '' };
function panel(source = analysis, extra = {}) {
  probe.keys = []; probe.saves = []; probe.states = []; probe.error = null;
  return StoryPanel({ analysis: source, brief: { ...brief, ...extra }, projectId: 'test-project', videoModelId: 'seedance-2.5', onChange() {}, onBusy() {}, onContinue() {}, async onSave(value) { probe.saves.push(value); } });
}
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
async function recover(tree) {
  const button = nodes(tree).find(n => n.type === 'button' && n.props.children === '找回上次结果');
  assert.ok(button);
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
}
let tree = panel();
probe.result = { output_text: JSON.stringify({ lines: projected.beats.filter(b => b.dialogue).map(b => ({ beat_id: b.beat_id, text: 'Hello.' })) }) };
await recover(tree);
assert.deepEqual(probe.keys, ['translate:test-project']);
assert.equal(probe.saves.length, 1);
assert.equal(probe.saves[0].storyMode, 'preserve');
assert.equal(probe.saves[0].mode, 'character_swap');
assert.match(probe.saves[0].storyDraft.beats[0].dialogue, /Hello/);
assert.deepEqual(probe.saves[0].storyDraft.beats.map(b => [b.start_seconds, b.end_seconds, b.action]), projected.beats.map(b => [b.start_seconds, b.end_seconds, b.action]));

tree = panel(analysis, { storyMode: 'rewrite' });
const rewritten = { ...projected, differentiation_log: ['事件：新事件', '人物：新人物', '场景：新场景', '对白：新对白'] };
probe.result = { output_text: JSON.stringify(rewritten) };
await recover(tree);
assert.deepEqual(probe.keys, ['story:test-project']);
assert.equal(probe.saves.length, 1);
assert.equal(probe.saves[0].storyMode, 'rewrite');
assert.equal(probe.saves[0].mode, 'full_original');

tree = panel(analysis, { storyDraft: projected });
probe.error = new Error('No cached result');
await recover(tree);
assert.equal(probe.saves.length, 0, 'Missing cache must not replace the current draft');
assert.ok(probe.states.includes('No cached result'));
const html = renderToStaticMarkup(tree);
assert.ok(html.includes('确认故事，继续设计角色'));
assert.ok(!html.includes('故事方向'));
assert.ok(!html.includes('场景与道具偏好'));
assert.ok(!html.includes('保留原剧情并翻译对白'), 'Existing draft hides regeneration by default');
assert.equal(nodes(tree).filter(n => n.type === 'details' && n.props.className === 'group').length, projected.beats.length);
assert.ok(nodes(tree).filter(n => n.type === 'details').every(n => !n.props.open));

const silent = structuredClone(analysis);
silent.beats.forEach(b => { b.dialogue.source_text = ''; b.dialogue.speaker_role = ''; b.dialogue.semantic_intent = '无对白'; });
tree = panel(silent);
assert.ok(!renderToStaticMarkup(tree).includes('对白语言'));
await recover(tree);
assert.deepEqual(probe.keys, []);
assert.equal(probe.saves.length, 1);
assert.equal(probe.saves[0].storyDraft.beats.length, silent.beats.length);
assert.ok(renderToStaticMarkup(panel(analysis, { storyMode: 'rewrite' })).includes('故事方向'));
delete globalThis.__storyPanelProbe;
console.log('Story panel: cache recovery, unchanged timeline, missing-cache protection and UI states passed.');
