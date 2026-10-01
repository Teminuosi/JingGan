import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

// Exercise the real panel handlers with in-memory hooks and a cache-only relay.
// No browser storage, project writes or model requests are used.
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
const probe = { keys: [], saves: [], changes: [], states: [], result: null, error: null };
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
  probe.changes = [];
  return StoryPanel({ analysis: source, brief: { ...brief, ...extra }, projectId: 'test-project', videoModelId: 'seedance-2.5', onChange(value) { probe.changes.push(value); }, onBusy() {}, onContinue() {}, async onSave(value) { probe.saves.push(value); } });
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
// 选了语种才翻译：translateDialogue=true 走「找回译文」这条路。
let tree = panel(analysis, { translateDialogue: true });
probe.result = { output_text: JSON.stringify({ lines: projected.beats.filter(b => b.dialogue).map(b => ({ beat_id: b.beat_id, text: 'Hello.' })) }) };
await recover(tree);
assert.deepEqual(probe.keys, ['translate:test-project']);
assert.equal(probe.saves.length, 1);
assert.equal(probe.saves[0].storyMode, 'preserve');
assert.equal(probe.saves[0].mode, 'character_swap');
assert.match(probe.saves[0].storyDraft.beats[0].dialogue, /Hello/);
assert.deepEqual(probe.saves[0].storyDraft.beats.map(b => [b.start_seconds, b.end_seconds, b.action]), projected.beats.map(b => [b.start_seconds, b.end_seconds, b.action]));

// 「翻译」默认是「无」：源片明明有台词，也不许偷偷调模型翻译、不许把台词留进草稿。
// 只看界面文案会漏掉「其实真的发了请求」，所以这里用真实 handler 验。
tree = panel();
const translateSelect = nodes(tree).find(n => n.type === 'select' && n.props.value === 'none');
assert.ok(translateSelect, '保留模式的「翻译」必须有「无」这一项');
// 选语种：写回 translateDialogue + outputLanguage；outputLanguage 永远是真实语种，不塞 'none' 进提示词。
translateSelect.props.onChange({ target: { value: 'Japanese' } });
assert.equal(probe.changes.at(-1).translateDialogue, true);
assert.equal(probe.changes.at(-1).outputLanguage, 'Japanese');
assert.notEqual(probe.changes.at(-1).outputLanguage, 'none');
// 本地投影：这个测试里 generateRelayText 一调用就抛错，所以跑通就证明真的没去翻译。
const localBuild = nodes(tree).find(n => n.type === 'button' && n.props.children === '生成原剧情分镜');
assert.ok(localBuild, '选「无」时主按钮应该是「生成原剧情分镜」');
localBuild.props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(probe.keys, [], '选「无」时不得请求译文');
assert.equal(probe.saves.length, 1);
assert.ok(probe.saves[0].storyDraft.beats.every(b => !b.dialogue.trim()), '选「无」时草稿一条台词都不留');
assert.equal(probe.saves[0].storyDraft.beats.length, projected.beats.length, '时间轴与镜头数不受影响');
// 没调过模型就没有可找回的结果：「找回上次结果」绝不能拿一份新投影把用户改过的草稿冲掉。
const noRemote = panel(analysis, { storyDraft: projected });
await recover(noRemote);
assert.equal(probe.saves.length, 0, '选「无」时找回不得覆盖现有草稿');
assert.ok(probe.states.some(value => String(value).includes('没有可找回的结果')));

tree = panel(analysis, { storyMode: 'rewrite' });
const rewritten = { ...projected, differentiation_log: ['事件：新事件', '人物：新人物', '场景：新场景', '对白：新对白'] };
probe.result = { output_text: JSON.stringify(rewritten) };
await recover(tree);
assert.deepEqual(probe.keys, ['story:test-project']);
assert.equal(probe.saves.length, 1);
assert.equal(probe.saves[0].storyMode, 'rewrite');
assert.equal(probe.saves[0].mode, 'full_original');

tree = panel(analysis, { storyDraft: projected, translateDialogue: true });
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

const detailed = structuredClone(projected);
detailed.beats[0].action_beats = [{ at_seconds: 2.5, actor_ids: ['CHAR_A'], action: 'Holds the cargo rail and watches the road', toward_ids: ['CHAR_B'], reaction: 'Turns forward', consequence: 'Keeps balance' }];
detailed.beats[0].sound = 'Engine and marketplace ambience';
const detailedTree = panel(analysis, { storyDraft: detailed });
const beatRow = nodes(detailedTree).find(n => n.type === 'details' && n.props.className === 'group');
const beatHtml = renderToStaticMarkup(beatRow);
assert.ok(beatHtml.indexOf('Holds the cargo rail') < beatHtml.indexOf('调整时长与拆镜'), 'Action sequence must be visible outside timing controls');
assert.equal(beatHtml.split('Holds the cargo rail').length - 1, 1, 'Action sequence is not duplicated');
assert.ok(beatHtml.includes('Engine and marketplace ambience'));
assert.ok(beatHtml.includes('Turns forward') && beatHtml.includes('Keeps balance'));
const soundEditor = nodes(beatRow).find(n => n.type === 'textarea' && n.props.value === detailed.beats[0].sound);
assert.ok(soundEditor, 'Sound details must be editable');
soundEditor.props.onChange({ target: { value: 'Updated engine ambience' } });
assert.equal(probe.changes.at(-1).storyDraft.beats[0].sound, 'Updated engine ambience');
assert.equal(probe.changes.at(-1).storyConfirmed, false);
const actionEditor = nodes(beatRow).find(n => n.type === 'textarea' && n.props.value === detailed.beats[0].action_beats[0].action);
assert.ok(actionEditor, 'Action beats must be editable');
actionEditor.props.onChange({ target: { value: 'Looks back at the passenger' } });
assert.equal(probe.changes.at(-1).storyDraft.beats[0].action_beats[0].action, 'Looks back at the passenger');
assert.equal(probe.changes.at(-1).storyDraft.beats[0].action_beats[0].reaction, 'Turns forward');
assert.equal(probe.changes.at(-1).storyDraft.beats[0].end_seconds, detailed.beats[0].end_seconds);
const invalidSteps = structuredClone(detailed);
invalidSteps.beats[0].action_beats[0].at_seconds = invalidSteps.beats[0].end_seconds + 1;
const invalidTree = panel(analysis, { storyDraft: invalidSteps });
const confirmation = nodes(invalidTree).find(n => n.type === 'button' && typeof n.props.children === 'string' && n.props.children.startsWith('确认故事'));
await confirmation.props.onClick();
assert.equal(probe.saves.length, 0, 'Invalid action timestamps must not be saved as confirmed');
assert.ok(probe.states.some(value => String(value).includes('动作时间')));

const silent = structuredClone(analysis);
silent.beats.forEach(b => { b.dialogue.source_text = ''; b.dialogue.speaker_role = ''; b.dialogue.semantic_intent = '无对白'; });
tree = panel(silent);
const silentHtml = renderToStaticMarkup(tree);
assert.ok(!silentHtml.includes('对白语言'), '保留模式的标签是「翻译」，不是「对白语言」');
assert.ok(silentHtml.includes('原片没有对白'), '源片无对白时要直接说明，别让用户猜');
// 源片本来没有对白：本地投影就能出分镜，一次模型调用都不该有。
const silentBuild = nodes(tree).find(n => n.type === 'button' && n.props.children === '生成原剧情分镜');
assert.ok(silentBuild);
silentBuild.props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(probe.keys, []);
assert.equal(probe.saves.length, 1);
assert.equal(probe.saves[0].storyDraft.beats.length, silent.beats.length);
assert.ok(probe.saves[0].storyDraft.beats.every(b => !b.dialogue.trim()));
assert.ok(renderToStaticMarkup(panel(analysis, { storyMode: 'rewrite' })).includes('故事方向'));
delete globalThis.__storyPanelProbe;
console.log('Story panel: cache recovery, unchanged timeline, missing-cache protection and UI states passed.');
