import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import Module from 'node:module';
import path from 'node:path';
import React from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
globalThis.__recoveryAnalysis = JSON.parse(await readFile('fixtures/video-dna.v1.json', 'utf8'));
const result = await build({
  stdin: { contents: "export { StudioApp } from './app/components/StudioApp'; export { setAccountScope } from './app/lib/account-client';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'recovery-fixture', setup(b) {
    // Seed the state left by a successful analysis followed by a failed save.
    // All event handlers, persistence code and the story panel remain real.
    b.onLoad({ filter: /StudioApp\.tsx$/ }, async args => ({ loader: 'tsx', contents: (await readFile(args.path, 'utf8'))
      .replace('useState<VideoDnaAnalysis | null>(null)', 'useState<VideoDnaAnalysis | null>(globalThis.__recoveryAnalysis)')
      .replace("useState<ActivePanel>('dna')", "useState<ActivePanel>('remix')")
      .replace('useState<RemixBrief>(INITIAL_BRIEF)', "useState<RemixBrief>({...INITIAL_BRIEF, storyMode:'preserve', translateDialogue:false})")
      .replace("const [projectTitle, setProjectTitle] = useState('')", "const [projectTitle, setProjectTitle] = useState('Recovered DNA')")
      .replace("const [projectSourceName, setProjectSourceName] = useState('')", "const [projectSourceName, setProjectSourceName] = useState('source.mp4')")
    }));
    b.onResolve({ filter: /^\.\/AccountWorkspace$/ }, () => ({ path: 'account', namespace: 'fixture' }));
    b.onResolve({ filter: /^\.\/AutoPrevisPanel$/ }, () => ({ path: 'previs', namespace: 'fixture' }));
    b.onResolve({ filter: /\/gemini$/ }, () => ({ path: 'analysis', namespace: 'fixture' }));
    b.onResolve({ filter: /\/video-prep$/ }, () => ({ path: 'video', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'account'
      ? 'export const AccountMenu=()=>null; export const useAccountConfig=()=>({pipelineEnabled:false});'
      : args.path === 'analysis'
        ? 'export const analysisPreview=()=>null; export const supportedVideoMimeType=()=>true; export const analyzeRelayVideo=()=>{throw Error("Analysis calls forbidden")};'
      : args.path === 'video'
        ? 'export const createSilentVideo=()=>{throw Error("Video processing forbidden")};'
      : 'export const AutoPrevisPanel=()=>null;' }));
  } }],
});
const filename = path.resolve('scripts/project-save-recovery-memory.cjs');
const mod = new Module(filename);
mod.filename = filename; mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, filename);
mod.exports.setAccountScope('recovery-owner');
const originalFetch = globalThis.fetch;
const writes = [];
let unavailable = true;
globalThis.fetch = async (url, init) => {
  if (url === '/api/auth/session') return Response.json({ user: { id: 'recovery-owner' } });
  if (url === '/api/projects' && (!init?.method || init.method === 'GET')) return Response.json({ projects: [] });
  if (url === '/api/projects' && init?.method === 'POST') {
    const input = JSON.parse(init.body); writes.push(input);
    if (unavailable) return Response.json({ error: '账号服务暂时无法连接' }, { status: 503 });
    return Response.json({ project: { ...input, id: 'recovered-project', updatedAt: new Date().toISOString() } });
  }
  throw Error(`Unexpected request (model calls forbidden): ${url}`);
};
try {
  render(React.createElement(mod.exports.StudioApp));
  assert.ok(screen.getByRole('button', { name: '重试保存项目（不重新分析）' }));
  const generate = screen.getByRole('button', { name: '生成原剧情分镜' });
  assert.equal(generate.disabled, false);
  fireEvent.click(generate);
  await waitFor(() => assert.equal(writes.length, 1));
  await waitFor(() => assert.ok(screen.getByText(/分镜已在当前页面生成，但项目未保存/)));
  assert.equal(writes[0].analysis.beats.length, globalThis.__recoveryAnalysis.beats.length);
  assert.equal(writes[0].brief.storyDraft.beats.length, globalThis.__recoveryAnalysis.beats.length);
  assert.equal(writes[0].sourceName, 'source.mp4');
  assert.equal(writes[0].brief.storyConfirmed, false);
  // Retry the existing data, with no repeat analysis or model submission.
  unavailable = false;
  fireEvent.click(screen.getByRole('button', { name: '重试保存项目（不重新分析）' }));
  await waitFor(() => assert.equal(Boolean(screen.queryByRole('button', { name: '重试保存项目（不重新分析）' })), false));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].analysis, writes[0].analysis);
  assert.deepEqual(writes[1].brief.storyDraft, writes[0].brief.storyDraft);
  assert.equal(screen.getByRole('button', { name: '确认故事，继续设计角色 →' }).disabled, false);
  assert.ok(localStorage.getItem('mirror:account:recovery-owner:mirror-vibe:last-project-id'));
  console.log('Project recovery: local projection survives save failure; retry saves the same DNA and draft without model calls.');
} finally {
  cleanup(); globalThis.fetch = originalFetch; delete globalThis.__recoveryAnalysis; dom.window.close();
}
