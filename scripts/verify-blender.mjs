// 验证生成的 Python 能不能在真实 Blender 上跑通。
// 不花钱、不碰上游，只回答一个问题：我按 4.x API 写的脚本，5.x 认不认。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const load = async (p) => {
  const r = await build({ entryPoints: [p], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

const BLENDER = process.env.BLENDER_PATH ?? 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe';
const OUT = path.resolve('.blender-test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { buildScene, validateScene, describeBlocking, describeCameraPath } = await load('app/lib/blender/protocol.ts');
const { generateBlenderPython } = await load('app/lib/blender/python.ts');

// 手工造一个「有真实空间数据」的镜头——正是现在分析层给不出来的那种
const dna = {
  schema_version: 'shot-dna.v1', shot_id: 'TEST', project_id: 'T', idx: 0,
  start_time: 0, end_time: 2, scene_id: 'S1', narrative_function: '', summary: '三人对峙',
  camera: { shot_size: 'MS', angle: 'eye_level', movement: 'dolly_in', movement_detail: '缓慢推近',
    depth_of_field: 'shallow', screen_direction: 'static', composition_notes: '三角构图' },
  actors: [
    { character_id: 'A', role_in_shot: '', screen_position: 'left', depth_layer: 'foreground', facing: '侧身朝右', wardrobe: '', props_held: [] },
    { character_id: 'B', role_in_shot: '从画右走入', screen_position: 'right', depth_layer: 'midground', facing: '面向镜头', wardrobe: '', props_held: [], entry_at: 1 },
    { character_id: 'C', role_in_shot: '', screen_position: 'center', depth_layer: 'background', facing: '背对镜头', wardrobe: '', props_held: [] },
  ],
  objects: [{ object_id: 'O1', name: '桌子', screen_position: 'center', depth_layer: 'midground', state: '', persistent: true }],
  environment: { location_id: '', location: '室内仓库', interior_exterior: 'interior', time_of_day: '黄昏', weather: '', set_dressing: [] },
  lighting: { key_light: '侧逆光', fill: '', practicals: [], mood: '', color_temperature: '冷', direction: '左' },
  action_timeline: [{ at: 0, actor_ids: ['A'], action: '抬手' }, { at: 1, actor_ids: ['B'], action: '走入', toward_ids: ['A'] }],
  expression_timeline: [], continuity: { from_previous: '', to_next: '', wardrobe_state: {}, prop_state: {}, position_state: {} },
  visual_style: { medium: '', palette: [], texture: '', grade: '', atmosphere: '' },
  complexity: { score: 0, factors: {}, needs_blender: true, reasons: [] },
  dialogue: { speaker_id: '', text: '', delivery: '' }, sound: '', transition_in: '',
  corrected_by_user: false, revision: 1,
};

const scene = buildScene(dna, { aspectRatio: '9:16' });
const issues = validateScene(scene);
console.log('场景校验：', issues.length ? issues.map((i) => i.message) : '无问题');
console.log('站位描述：', describeBlocking(scene));
console.log('机位描述：', describeCameraPath(scene));

// 让它渲路径动画，验证 mp4 输出这条路
scene.outputs = ['first_frame', 'layout_diagram', 'path_animation'];
const script = path.join(OUT, 'previs.py');
fs.writeFileSync(script, generateBlenderPython(scene, { outputDir: OUT.split(String.fromCharCode(92)).join('/'), width: 320, height: 180 }), 'utf8');

console.log('\n正在调用真实 Blender…');
const t0 = Date.now();
let out;
try {
  out = await execFileAsync(BLENDER, ['--background', '--python', script, '--python-exit-code', '1'],
    { maxBuffer: 32 * 1024 * 1024, timeout: 240000 });
} catch (err) {
  console.error('❌ Blender 失败');
  console.error((err.stderr || err.stdout || String(err)).slice(-2500));
  process.exit(1);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const done = /BLENDER_DONE (.*)/.exec(out.stdout);
console.log(`Blender 退出正常，用时 ${secs}s`);
console.log('脚本报告产出：', done ? done[1] : '(没找到完成标记)');
console.log('目录实际文件：');
for (const f of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, f));
  console.log(`  ${f}  ${(st.size / 1024).toFixed(1)} KB`);
}
