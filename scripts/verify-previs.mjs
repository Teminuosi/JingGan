// 端到端验证：全片预演 → 真实 Blender 渲染 → ffmpeg 编码 → 一条 MP4。
//
// 用手工造的、带真实空间数据的三镜片段，因为现在的分析结果里没有空间数据，
// 拿它去渲只能得到几个叠在原点的胶囊，验不出任何东西。
//
// 用法：node scripts/verify-previs.mjs
//   BLENDER_PATH 可覆盖 blender 可执行文件路径

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { makeBlenderExec } from '../worker/blender-exec.mjs';
import { createFfmpeg } from '../worker/repo.mjs';

const load = async (p) => {
  const r = await build({ entryPoints: [p], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

const BLENDER = process.env.BLENDER_PATH
  ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const ROOT = path.resolve('.previs-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const { buildFilmScene, buildScene, validateScene, describeBlocking } = await load('app/lib/blender/protocol.ts');
const { SubprocessBlenderRunner } = await load('app/lib/blender/runner.ts');

// ---- 三个镜头，带真实空间数据 ----
const mk = (idx, start, end, over = {}) => ({
  schema_version: 'shot-dna.v1', shot_id: `S${idx}`, project_id: 'PREVIS', idx,
  start_time: start, end_time: end, scene_id: 'SC1', narrative_function: '', summary: `第${idx + 1}镜`,
  camera: {
    shot_size: 'MS', angle: 'eye_level', movement: 'static', movement_detail: '',
    depth_of_field: 'medium', screen_direction: 'static', composition_notes: '',
    ...(over.camera ?? {}),
  },
  actors: over.actors ?? [],
  objects: [{ object_id: 'O1', name: '长桌', screen_position: 'center', depth_layer: 'midground', state: '', persistent: true }],
  environment: { location_id: 'L1', location: '室内食堂', interior_exterior: 'interior', time_of_day: '中午', weather: '', set_dressing: [] },
  lighting: { key_light: '顶部漫射', fill: '', practicals: [], mood: '', color_temperature: '冷', direction: '顶光' },
  action_timeline: [], expression_timeline: [],
  continuity: { from_previous: '', to_next: '', wardrobe_state: {}, prop_state: {}, position_state: {} },
  visual_style: { medium: '', palette: [], texture: '', grade: '', atmosphere: '' },
  complexity: { score: 0, factors: {}, needs_blender: true, reasons: [] },
  dialogue: { speaker_id: '', text: '', delivery: '' }, sound: '', transition_in: '',
  corrected_by_user: false, revision: 1,
});
const actor = (id, pos, depth, facing = '面向镜头', extra = {}) =>
  ({ character_id: id, role_in_shot: '', screen_position: pos, depth_layer: depth, facing, wardrobe: '', props_held: [], ...extra });

const shots = [
  // 第 1 镜：三人分站左中右，推镜
  mk(0, 0, 3, {
    camera: { shot_size: 'MLS', angle: 'eye_level', movement: 'dolly_in', movement_detail: '缓推', depth_of_field: 'medium', screen_direction: 'static', composition_notes: '' },
    actors: [actor('A', 'left', 'midground', '侧身朝右'), actor('B', 'center', 'midground'), actor('C', 'right', 'midground', '侧身朝左')],
  }),
  // 第 2 镜：切到 A 的近景 —— 机位必须硬切，不能从上一镜飞过来
  mk(1, 3, 5, {
    camera: { shot_size: 'MCU', angle: 'low', movement: 'static', movement_detail: '', depth_of_field: 'shallow', screen_direction: 'static', composition_notes: '' },
    actors: [actor('A', 'center', 'foreground')],
  }),
  // 第 3 镜：拉回全景，D 中途从画右走入
  mk(2, 5, 8, {
    camera: { shot_size: 'LS', angle: 'high', movement: 'truck', movement_detail: '横移', depth_of_field: 'deep', screen_direction: 'left_to_right', composition_notes: '' },
    actors: [actor('A', 'left', 'foreground'), actor('B', 'center_left', 'midground'),
      actor('C', 'center_right', 'midground'), actor('D', 'right', 'background', '面向镜头', { entry_at: 1 })],
  }),
];

// ---- 逐镜模式：每镜单独一个场景 ----
console.log('== 逐镜模式 ==');
for (const dna of shots) {
  const sc = buildScene(dna, { aspectRatio: '9:16' });
  const bad = validateScene(sc);
  console.log(`  第${dna.idx + 1}镜  相机 y=${sc.camera.position.y.toFixed(2)} 焦距${sc.camera.focalLength}mm  ${bad.length ? '⚠ ' + bad[0].message : '场景正常'}`);
}

// ---- 全片模式 ----
console.log('== 全片模式 ==');
const film = buildFilmScene(shots, { aspectRatio: '9:16' });
console.log(`  时长 ${film.durationSeconds}s / ${film.fps}fps = ${Math.round(film.durationSeconds * film.fps)} 帧`);
console.log(`  角色 ${film.actors.map((a) => a.id).join(',')}  机位关键帧 ${film.camera.path.length} 个，其中硬切 ${film.camera.path.filter((k) => k.cut).length} 次`);
console.log(`  站位：${describeBlocking(film).slice(0, 120)}…`);

const cuts = film.camera.path.filter((k) => k.cut).map((k) => k.at);
if (cuts.length !== shots.length) throw new Error(`硬切次数应等于镜头数 ${shots.length}，实际 ${cuts.length}`);
if (cuts[1] !== 3 || cuts[2] !== 5) throw new Error(`硬切时间点不对：${cuts}`);

// ---- 真实渲染 ----
const ffmpeg = createFfmpeg(ROOT);
const runner = new SubprocessBlenderRunner({
  blenderPath: BLENDER,
  workDir: ROOT.split(String.fromCharCode(92)).join('/'),
  // 与 worker 共用同一份进程包装——这条验证跑通才代表 worker 里那条也通。
  exec: makeBlenderExec({ onWarn: (m) => console.warn('[blender]', m) }),
  writeFile: async (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  },
  readOutput: async (dir) => fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({
          name: e.name,
          // 只把 result.json 的内容读进来。目录里还躺着上千张 PNG，
          // 全读一遍就是几百 MB 进内存——而调用方只需要文件名和那份清单。
          bytes: e.name === 'result.json' ? fs.readFileSync(path.join(dir, e.name)) : Buffer.alloc(0),
        })),
  onWarn: (m) => console.warn('[warn]', m),
  encodeFrames: async (framesDir, fps, outPath) => await ffmpeg.encodeFrames(framesDir, fps, outPath),
});

console.log('\n正在渲染全片预演（真实 Blender）…');
const t0 = Date.now();
const result = await runner.render(film);
console.log(`渲染完成，${result.renderSeconds}s`);
for (const a of result.artifacts) console.log('  产出：', a.key, a.contentType);

const mp4 = path.join(ROOT, film.shotId.replace(':', '_'), 'previs.mp4');
const found = result.artifacts.find((a) => a.contentType === 'video/mp4');
if (!found) throw new Error('没有产出 MP4');
const mp4Path = path.join(ROOT, found.key.replace(/^blender\//, ''));
const real = fs.existsSync(mp4Path) ? mp4Path : mp4;
if (!fs.existsSync(real)) throw new Error(`MP4 文件不存在：${mp4Path}`);

const probe = await ffmpeg.probe(path.relative(ROOT, real).split(String.fromCharCode(92)).join('/'));
console.log(`\nMP4 实测：${probe.durationSeconds}s  ${probe.width}×${probe.height}  ${(probe.bytes / 1024).toFixed(0)} KB`);
if (Math.abs(probe.durationSeconds - film.durationSeconds) > 0.3) {
  throw new Error(`预演时长对不上：要 ${film.durationSeconds}s，实际 ${probe.durationSeconds}s`);
}
console.log(`\n✅ 全片预演跑通：${shots.length} 镜拼成一条 ${probe.durationSeconds} 秒 MP4，镜头间硬切 ${cuts.length} 次，总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
