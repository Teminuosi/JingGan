// 浏览器预演的计算与 Blender（render.py）逐帧对照。
// 基准由 scripts/blender-kinematics-dump.py 从真实动作计划导出；这里只跑 JS，不需要 Blender、不调用模型。
// 用法：node scripts/test-previs-kinematics.mjs [基准目录]（目录里成对放 plan-N.json / golden-N.json）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { preparePlan, objectsAt, cameraAt, motionCheck, eulerMatrix, matmul, apply, framingIssues, ghostParts } from '../worker/previs/kinematics.mjs';

const dir = path.resolve(process.argv[2] || path.join(import.meta.dirname, 'fixtures', 'previs-kinematics'));
const TOL = 1e-4; // 0.1 毫米；Blender 世界矩阵是 float32
const pairs = fs.readdirSync(dir).filter(f => /^plan-.+\.json$/.test(f)).map(f => [f, f.replace(/^plan-/, 'golden-')]).filter(([, g]) => fs.existsSync(path.join(dir, g)));
assert.ok(pairs.length > 0, `没有找到对照基准：${dir}`);

const close = (a, b, label) => assert.ok(Math.abs(a - b) <= TOL, `${label}：JS ${a} ≠ Blender ${b}`);
const closeVec = (a, b, label) => a.forEach((v, i) => close(v, b[i], `${label}[${i}]`));
const column = (m, c) => [m[c], m[3 + c], m[6 + c]];
const norm = v => Math.hypot(...v);

// Three.js 相机 lookAt（up=+Z）再绕视线 roll，与 Blender to_track_quat('-Z','Y') @ Rz(roll) 应一致。
function cameraMatrix({ position, target, roll }) {
  const z = position.map((v, i) => v - target[i]); const zl = norm(z); const zn = z.map(v => v / zl);
  const up = [0, 0, 1];
  let x = [up[1] * zn[2] - up[2] * zn[1], up[2] * zn[0] - up[0] * zn[2], up[0] * zn[1] - up[1] * zn[0]];
  if (norm(x) < 1e-9) x = [1, 0, 0];
  const xl = norm(x); x = x.map(v => v / xl);
  const y = [zn[1] * x[2] - zn[2] * x[1], zn[2] * x[0] - zn[0] * x[2], zn[0] * x[1] - zn[1] * x[0]];
  const look = [x[0], y[0], zn[0], x[1], y[1], zn[1], x[2], y[2], zn[2]];
  return matmul(look, eulerMatrix([0, 0, roll]));
}

let compared = 0;
for (const [planFile, goldenFile] of pairs) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, planFile), 'utf8'));
  const golden = JSON.parse(fs.readFileSync(path.join(dir, goldenFile), 'utf8'));
  const prepared = preparePlan(plan);
  for (const sample of golden.samples) {
    const label = `${planFile} 第 ${sample.frame} 帧`;
    const objects = objectsAt(prepared, sample.t);
    const names = new Set(objects.map(o => o.name));
    for (const name of Object.keys(sample.objects)) if (!['Camera', 'Ground'].includes(name)) assert.ok(names.has(name), `${label}：Blender 有 ${name}，JS 没有`);
    for (const o of objects) {
      const ref = sample.objects[o.name];
      assert.ok(ref, `${label}：JS 多出 ${o.name}`);
      assert.equal(o.visible, ref.visible, `${label} ${o.name} 可见性`);
      closeVec(o.position, ref.position, `${label} ${o.name} 位置`);
      const m = ref.matrix.flat();
      // 世界矩阵 = 旋转·缩放。骨段是 X/Y 等半径的椭球，绕自身 Z 的滚转不改变形状，只比 Z 轴与两个半径。
      if (o.limb) {
        closeVec(apply(o.rotation, [0, 0, o.scale[2]]), column(m, 2), `${label} ${o.name} 长轴`);
        close(o.scale[0], norm(column(m, 0)), `${label} ${o.name} 半径X`);
        close(o.scale[1], norm(column(m, 1)), `${label} ${o.name} 半径Y`);
      } else {
        const rs = o.rotation.map((v, i) => v * o.scale[i % 3]);
        closeVec(rs, m, `${label} ${o.name} 旋转缩放`);
      }
      compared++;
    }
    const cam = cameraAt(prepared, sample.t), ref = sample.objects.Camera;
    closeVec(cam.position, ref.position, `${label} 相机位置`);
    closeVec(cameraMatrix(cam), ref.matrix.flat(), `${label} 相机朝向`);
    close(cam.lens, ref.lens, `${label} 焦距`);
  }
  const check = motionCheck(plan, golden.motionCheck.frames, golden.motionCheck.fps);
  const want = golden.motionCheck;
  close(check.max_limb_length_change, want.max_limb_length_change, `${planFile} 肢体长度变化`);
  close(check.max_unreachable_target_m, want.max_unreachable_target_m, `${planFile} 够不到距离`);
  assert.equal(check.attachment_count, want.attachment_count, `${planFile} 挂接帧数`);
  assert.equal(check.attachment_switches.length, want.attachment_switches.length, `${planFile} 挂接切换次数`);
  check.attachment_switches.forEach((s, i) => { assert.equal(s.id, want.attachment_switches[i].id); close(s.at, want.attachment_switches[i].at, `${planFile} 切换时刻`); close(s.distance_from_previous_frame_m, want.attachment_switches[i].distance_from_previous_frame_m, `${planFile} 切换跳变`); });
}
// 画面检查：真实计划通过；把一个角色挪到镜头外、把道具埋进地下，都必须被拦下（2026-10-19 lite 模型真实事故）。
{
  const base = JSON.parse(fs.readFileSync(path.join(dir, pairs[0][0]), 'utf8'));
  const frames = Math.round(base.duration * 24);
  assert.deepEqual(framingIssues(base, frames, 540, 960), [], '真实计划不应被画面检查误报');
  const offscreen = structuredClone(base);
  for (const key of offscreen.actors[0].keys) key.position = [key.position[0] + 40, key.position[1], key.position[2]];
  assert.match(framingIssues(offscreen, frames, 540, 960).join(''), new RegExp(`${offscreen.actors[0].id} 出场了但整镜都在画面外`));
  const buried = structuredClone(base);
  for (const key of buried.props[0].keys) if (!key.attach) key.position = [key.position[0], key.position[1], -0.5];
  assert.match(framingIssues(buried, frames, 540, 960).join(''), /位于地面以下/);
  assert.doesNotMatch(framingIssues(buried, frames, 540, 960).join(''), /是绑定把它带到了地下/);
  // 实测（2026-10-20）：相机放在被子方块里，前景整片是被子内壁。
  const swallowed = structuredClone(base);
  const camAt = (swallowed.camera[0].position);
  swallowed.props.push({ id: 'prop_duvet', parts: [{ shape: 'box', position: [0, 0, 0], rotation: [0, 0, 30], size: [1.4, 1.4, .3], color: [.5, .5, .5] }], keys: [{ at: 0, position: camAt.map((v, i) => v + (i === 2 ? .05 : .1)), rotation: [0, 0, 0], visible: true, attach: null }] });
  assert.ok(ghostParts(swallowed, frames, 540, 960).includes('prop_duvet_0'), '镜头在部件里面：该部件半透明渲染');
  assert.equal(framingIssues(swallowed, frames, 540, 960).join('').includes('prop_duvet'), false, '交给渲染解决，不再要求模型重排');
  // 实测（2026-10-20）：「钻在被窝里」被编成整只角色放进被子方块，整镜只看到被子。
  const hidden = structuredClone(base);
  const head = objectsAt(preparePlan(base), 0).find(o => o.name === `${base.actors[0].id}_head`).position;
  hidden.props.push({ id: 'prop_blanket', parts: [{ shape: 'box', position: [0, 0, 0], rotation: [0, 0, 0], size: [8, 8, 8], color: [.5, .5, .5] }], keys: [{ at: 0, position: head, rotation: [0, 0, 0], visible: true, attach: null }] });
  hidden.camera = hidden.camera.map(c => ({ ...c, position: [head[0], head[1] - 30, head[2]], target: head }));
  assert.ok(ghostParts(hidden, frames, 540, 960).includes('prop_blanket_0'), '挡住角色头部的部件半透明渲染');
  assert.equal(framingIssues(hidden, frames, 540, 960).join('').includes('prop_blanket'), false);
  // 实测（2026-10-23）：只擦过脸边缘的床、墙也整镜半透明，整间卧室看不见。只挡一条边缘线的部件保持实心。
  const grazed = structuredClone(hidden);
  grazed.props = grazed.props.filter(p => p.id !== 'prop_blanket');
  const edge = base.actors[0].height * .08;
  grazed.props.push({ id: 'prop_wall_edge', parts: [{ shape: 'box', position: [0, 0, 0], rotation: [0, 0, 0], size: [edge * .6, .02, edge * .6], color: [.5, .5, .5] }], keys: [{ at: 0, position: [head[0] + edge, head[1] - .05, head[2]], rotation: [0, 0, 0], visible: true, attach: null }] });
  assert.equal(ghostParts(grazed, frames, 540, 960).includes('prop_wall_edge_0'), false, '只擦过脸边缘的部件不半透明');
  const attachedDown = structuredClone(base);
  attachedDown.props[0].keys = [{ at: 0, position: [0, 0, 0], rotation: [0, 0, 0], visible: true, attach: { actor: base.actors[0].id, joint: 'pelvis', offset: [0, 0, -2] } }];
  assert.match(framingIssues(attachedDown, frames, 540, 960).join(''), new RegExp(`${attachedDown.props[0].id} 绑定在 ${base.actors[0].id} 的 pelvis 上.*attach.actor 写 WORLD`));
}
console.log(`Previs kinematics: ${pairs.length} 份动作计划、${compared} 个物体帧（含 1 份覆盖硬切、转头、张嘴和全部形状的合成计划）与 Blender 逐项一致（误差 ≤ ${TOL} m），本地检查指标一致；画面检查能拦下角色在画外、道具埋地。`);
