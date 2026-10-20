// render.py 的计算部分逐行移植：给动作计划和时间，算出每个灰模物体的位置、朝向、缩放。
// 不依赖 Three.js 或 Blender，浏览器播放、导出和与 Blender 的数值对照都只认这一份。
// 坐标系与动作计划一致：Z 朝上，角色面朝 -Y，角度为度、XYZ 欧拉顺序（与 Blender 相同）。

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const normalize = a => { const l = length(a); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; };
const rad = d => d * Math.PI / 180;

/** 3×3 行主序矩阵。Blender Euler('XYZ').to_matrix() = Rz·Ry·Rx。 */
export function eulerMatrix(deg) {
  const [x, y, z] = deg.map(rad);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [
    cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
    cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
    -sy, sx * cy, cx * cy,
  ];
}
export const apply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export const matmul = (a, b) => {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out;
};
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** 构造一个把局部 Z 轴对准 direction 的旋转（对 X/Y 等比缩放的球体，绕 Z 的滚转不影响形状）。 */
export function alignZ(direction) {
  const z = normalize(direction);
  if (length(z) < 1e-9) return IDENTITY;
  // 与 Blender to_track_quat('Z','Y') 一样：Y 轴尽量朝世界 +Z（与 Z 平行时退到世界 +Y）。
  let up = Math.abs(z[2]) > 1 - 1e-9 ? [0, 1, 0] : [0, 0, 1];
  let x = normalize(cross(up, z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

/** 关键帧采样：数值线性插值，布尔/字符串/attach 取左值；右键带 cut 时保持左值直到切点。 */
export function sample(keys, t) {
  let left = keys[0];
  for (const right of keys.slice(1)) {
    if (t < right.at) {
      const u = (t - left.at) / (right.at - left.at);
      if (right.cut) return left;
      const mix = (a, b) => {
        // 与 Python zip 一致：两边长度不同时按短的截断。
        if (Array.isArray(a)) return a.slice(0, Array.isArray(b) ? Math.min(a.length, b.length) : a.length).map((x, i) => mix(x, b?.[i]));
        if (a && typeof a === 'object') { const out = {}; for (const [k, v] of Object.entries(a)) out[k] = mix(v, b && Object.hasOwn(b, k) ? b[k] : v); return out; }
        if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * u;
        return a;
      };
      const l = { ...left }, r = { ...right };
      delete l.attach; delete r.attach;
      return { ...mix(l, r), attach: left.attach };
    }
    left = right;
  }
  return left;
}

export const EDGES = [
  ['pelvis', 'chest', .105], ['chest', 'neck', .075],
  ['chest', 'left_shoulder', .07], ['chest', 'right_shoulder', .07],
  ['pelvis', 'left_hip', .065], ['pelvis', 'right_hip', .065],
  ['left_shoulder', 'left_elbow', .04], ['left_elbow', 'left_hand', .033],
  ['right_shoulder', 'right_elbow', .04], ['right_elbow', 'right_hand', .033],
  ['left_hip', 'left_knee', .055], ['left_knee', 'left_foot', .045],
  ['right_hip', 'right_knee', .055], ['right_knee', 'right_foot', .045],
];

/** 两节骨骼 IK：保持骨长，用计划里的肘/膝位置决定弯曲平面。 */
function solveLimb(joints, original, start, middle, end, height, rootRotation, metrics) {
  const a = joints[start], desired = joints[end], hint = joints[middle];
  const lengthA = length(sub(original[start], original[middle])) * height;
  const lengthB = length(sub(original[middle], original[end])) * height;
  const delta = sub(desired, a);
  const direction = length(delta) > .00001 ? normalize(delta) : apply(rootRotation, [0, 0, -1]);
  const distance = Math.min(Math.max(length(delta), Math.abs(lengthA - lengthB) + .00001), lengthA + lengthB - .00001);
  const actual = add(a, mul(direction, distance));
  if (metrics) metrics.max_unreachable_target_m = Math.max(metrics.max_unreachable_target_m, length(sub(actual, desired)));
  let bend = sub(sub(hint, a), mul(direction, dot(sub(hint, a), direction)));
  if (length(bend) < .00001) {
    bend = apply(rootRotation, [0, -1, 0]);
    bend = sub(bend, mul(direction, dot(bend, direction)));
    if (length(bend) < .00001) bend = cross(direction, [1, 0, 0]);
  }
  bend = normalize(bend);
  const along = (lengthA ** 2 - lengthB ** 2 + distance ** 2) / (2 * distance);
  const side = Math.sqrt(Math.max(0, lengthA ** 2 - along ** 2));
  joints[middle] = add(add(a, mul(direction, along)), mul(bend, side));
  joints[end] = actual;
}

export function actorPose(actor, t, metrics) {
  const pose = sample(actor.keys, t);
  const rotation = eulerMatrix(pose.rotation);
  const h = actor.height, origin = pose.position;
  const joints = {};
  for (const [j, v] of Object.entries(pose.joints)) joints[j] = add(origin, apply(rotation, mul(v, h)));
  for (const side of ['left', 'right']) {
    for (const names of [['shoulder', 'elbow', 'hand'], ['hip', 'knee', 'foot']]) {
      const [s, m, e] = names.map(n => `${side}_${n}`);
      solveLimb(joints, actor.keys[0].joints, s, m, e, h, rotation, metrics);
    }
  }
  return { pose, joints, rotation };
}

/**
 * 复制计划并做与 render.py 相同的预处理：从「放着」到「拿在手里」的插值终点
 * 是真实握点，而不是挂接关键帧里存的占位坐标。
 */
export function preparePlan(plan, metrics) {
  const prepared = structuredClone(plan);
  const actors = Object.fromEntries(prepared.actors.map(a => [a.id, a]));
  for (const prop of prepared.props) {
    for (const key of prop.keys) {
      if (!key.attach) continue;
      // render.py 在这一步也会累计「够不到」的距离，同口径保留。
      const { joints, rotation } = actorPose(actors[key.attach.actor], key.at, metrics);
      key.position = add(joints[key.attach.joint], apply(rotation, key.attach.offset));
    }
  }
  return prepared;
}

/** 某一时刻全部可见物体。每个物体：name、shape、color、position、rotation(3×3)、scale、visible。 */
export function objectsAt(prepared, t, metrics) {
  const objects = [], worlds = {};
  for (const a of prepared.actors) {
    const { pose, joints, rotation } = actorPose(a, t, metrics);
    const h = a.height, visible = pose.visible !== false, human = a.kind === 'human';
    worlds[a.id] = { joints, rotation };
    for (const [ja, jb, radius] of EDGES) {
      const delta = sub(joints[jb], joints[ja]);
      objects.push({ name: `${a.id}_${ja}_${jb}`, shape: 'sphere', color: a.color, position: mul(add(joints[ja], joints[jb]), .5), rotation: alignZ(delta), scale: [radius * h, radius * h, Math.max(length(delta) / 2, .001)], visible, limb: [a.id, ja, jb, length(delta)] });
    }
    const head = matmul(rotation, eulerMatrix(pose.head_rotation || [0, 0, 0]));
    const at = offset => add(joints.head, apply(head, offset));
    objects.push({ name: `${a.id}_head`, shape: 'sphere', color: a.skin, position: joints.head, rotation: head, scale: [h * .095, h * .085, h * .115], visible });
    objects.push({ name: `${a.id}_nose`, shape: 'sphere', color: human ? [.2, .15, .1] : a.skin, position: at([0, -h * .095, -h * .018]), rotation: head, scale: human ? [h * .022, h * .034, h * .025] : [h * .055, h * .07, h * .042], visible });
    objects.push({ name: `${a.id}_mouth`, shape: 'sphere', color: [.045, .025, .025], position: at([0, -h * .092, -h * .072]), rotation: head, scale: [h * .038, h * .018, h * (.007 + .018 * (pose.mouth_open ?? 0))], visible });
    for (const [i, side] of [-1, 1].entries()) objects.push({ name: `${a.id}_eye_${side}`, shape: 'sphere', color: [.02, .02, .025], position: at([side * h * .046, -h * .080, h * .028]), rotation: IDENTITY, scale: [h * .014, h * .013, h * .014], visible, order: i });
    if (!human) for (const side of [-1, 1]) objects.push({ name: `${a.id}_ear_${side}`, shape: 'cone', color: a.skin, position: at([side * h * .065, 0, h * .12]), rotation: head, scale: [h * .04, h * .035, h * .075], visible });
    for (const joint of ['left_hand', 'right_hand', 'left_foot', 'right_foot']) {
      objects.push({ name: `${a.id}_${joint}`, shape: 'sphere', color: joint.includes('hand') ? a.skin : [.07, .07, .08], position: joints[joint], rotation, scale: [h * .037, h * (joint.includes('foot') ? .055 : .035), h * .028], visible });
    }
  }
  for (const p of prepared.props) {
    const pose = sample(p.keys, t);
    let rot = eulerMatrix(pose.rotation), position = pose.position;
    if (pose.attach) {
      const { joints, rotation } = worlds[pose.attach.actor];
      position = add(joints[pose.attach.joint], apply(rotation, pose.attach.offset));
      rot = matmul(rotation, rot);
    }
    for (const [i, part] of p.parts.entries()) {
      objects.push({ name: `${p.id}_${i}`, shape: part.shape, color: part.color, position: add(position, apply(rot, part.position)), rotation: matmul(rot, eulerMatrix(part.rotation)), scale: part.size.map(v => v / 2), visible: pose.visible !== false, prop: p.id });
    }
    if (metrics) {
      if (pose.attach) metrics.attachment_count += 1;
      const previous = metrics._props[p.id];
      // Python 的 dict 比较不看键顺序，这里同样按内容比。
      if (previous && !sameAttach(previous.attach, pose.attach)) metrics.attachment_switches.push({ id: p.id, at: t, distance_from_previous_frame_m: length(sub(position, previous.position)), attached: Boolean(pose.attach) });
      metrics._props[p.id] = { attach: pose.attach, position };
    }
  }
  return objects;
}

function sameAttach(a, b) {
  if (!a || !b) return !a && !b;
  return a.actor === b.actor && a.joint === b.joint && a.offset.length === b.offset.length && a.offset.every((v, i) => v === b.offset[i]);
}

export function cameraAt(prepared, t) {
  const c = sample(prepared.camera, t);
  return { position: c.position, target: c.target, roll: c.roll ?? 0, lens: c.lens };
}

/** Blender 默认 36mm 传感器、自动适配：横画面对应宽度，竖画面对应高度。返回 Three.js 用的垂直视场角（度）。 */
export function verticalFov(lens, width, height) {
  const half = 18 / lens;
  return 2 * Math.atan(width >= height ? half * height / width : half) * 180 / Math.PI;
}

export const frameCount = (start, end, fps = 24) => Math.round(end * fps) - Math.round(start * fps);

/** 与 render.py 写出的 motion-check.json 同口径的本地检查。 */
export function motionCheck(plan, frames, fps = 24) {
  const metrics = { frames, fps, nonfinite: 0, max_limb_length_change: 0, max_unreachable_target_m: 0, attachment_count: 0, attachment_switches: [], _props: {} };
  const prepared = preparePlan(plan, metrics);
  const baseline = new Map();
  for (let frame = 1; frame <= frames; frame++) {
    const objects = objectsAt(prepared, (frame - 1) / fps, metrics);
    for (const o of objects) {
      if (![...o.position, ...o.scale, ...o.rotation].every(Number.isFinite)) metrics.nonfinite += 1;
      if (!o.limb) continue;
      const [, , , len] = o.limb, key = o.name;
      if (!baseline.has(key)) baseline.set(key, Math.max(len, .01));
      metrics.max_limb_length_change = Math.max(metrics.max_limb_length_change, Math.abs(len / baseline.get(key) - 1));
    }
  }
  delete metrics._props;
  return metrics;
}

/** 与 engine.mjs 同样的判定阈值。 */
export function motionIssues(check) {
  const issues = [];
  if (check.max_limb_length_change > .4) issues.push('肢体长度变化超过40%，需要检查动作计划');
  if (check.max_unreachable_target_m > .10) issues.push('手脚目标超出肢体可达范围，需要检查动作计划');
  if (check.nonfinite > 0) issues.push('动作计划里有无效数值，需要检查动作计划');
  return issues;
}

/**
 * 画面检查（不调用模型）：按镜头真实取景，查三类明显错误——
 * 1) 某个出场角色整镜都不在画面里（被放到镜头外）；
 * 2) 角色身体或道具埋在地面以下；
 * 3) 镜头整镜一个角色都拍不到。
 * 返回中文问题列表；空数组表示通过。width/height 只用来定画幅比例。
 */
export function framingIssues(plan, frames, width, height, fps = 24) {
  const prepared = preparePlan(plan);
  const aspect = width / height;
  const seen = new Map(prepared.actors.map(a => [a.id, { shown: false, onScreen: false }]));
  const below = new Set();
  const swallowed = new Set();
  let anyOnScreen = false;
  const step = Math.max(1, Math.round(fps / 4));
  for (let frame = 1; frame <= frames; frame += step) {
    const t = (frame - 1) / fps;
    const cam = cameraAt(prepared, t);
    const z = normalize(sub(cam.position, cam.target));
    let x = normalize(cross([0, 0, 1], z));
    if (length(x) < 1e-9) x = [1, 0, 0];
    let y = cross(z, x);
    const r = rad(cam.roll || 0), c = Math.cos(r), s = Math.sin(r);
    [x, y] = [add(mul(x, c), mul(y, s)), add(mul(x, -s), mul(y, c))];
    const tanV = Math.tan(rad(verticalFov(cam.lens, width, height)) / 2), tanH = tanV * aspect;
    const inView = p => {
      const d = sub(p, cam.position), depth = -dot(d, z);
      if (depth < .05) return false;
      return Math.abs(dot(d, x) / depth) <= tanH && Math.abs(dot(d, y) / depth) <= tanV;
    };
    for (const a of prepared.actors) {
      const { pose, joints } = actorPose(a, t);
      const state = seen.get(a.id);
      if (pose.visible === false) continue;
      state.shown = true;
      if (['head', 'chest', 'pelvis'].some(j => joints[j] && inView(joints[j]))) { state.onScreen = true; anyOnScreen = true; }
      const lowest = Math.min(...Object.values(joints).map(j => j[2]));
      if (lowest < -.15) below.add(`角色 ${a.id}`);
    }
    for (const o of objectsAt(prepared, t)) {
      if (!o.prop || !o.visible) continue;
      // 用竖直方向的半高估算底面；中心已在地面以下 0.05 米就算埋进地里。
      if (o.position[2] < -.05) below.add(`道具 ${o.prop}`);
      // 相机落在道具部件的包围盒里（局部坐标三个轴都在半尺寸内）：画面前景会是它的内壁。
      const d = sub(cam.position, o.position), m = o.rotation;
      if ([0, 1, 2].every(i => Math.abs(m[i] * d[0] + m[3 + i] * d[1] + m[6 + i] * d[2]) < o.scale[i] - .01)) swallowed.add(o.prop);
    }
  }
  const issues = [];
  const missing = [...seen].filter(([, v]) => v.shown && !v.onScreen).map(([id]) => id);
  if (!anyOnScreen) issues.push('镜头整镜都没有拍到任何角色，相机 target 应对准主要角色');
  else if (missing.length) issues.push(`${missing.join('、')} 出场了但整镜都在画面外，请把它放进镜头取景范围或调整相机`);
  if (swallowed.size) issues.push(`镜头在道具 ${[...swallowed].join('、')} 里面，画面前景会被它的内壁挡住：把相机移到道具外面（例如床边、床尾外侧），保持原片景别`);
  if (below.size) issues.push(`${[...below].join('、')} 位于地面以下（地面 z=0），请把它放到地面或家具上`);
  // 实测（2026-10-20）：模型把床、床头柜绑到躺着的角色骨盆上再往下偏，只说「放到地面」它会原样再犯。
  const attachedBelow = plan.props.filter(p => below.has(`道具 ${p.id}`) && p.keys.some(k => k.attach))
    .map(p => { const a = p.keys.find(k => k.attach).attach; return `${p.id} 绑定在 ${a.actor} 的 ${a.joint} 上`; });
  if (attachedBelow.length) issues.push(`其中 ${attachedBelow.join('、')}，是绑定把它带到了地下：床、柜子、门墙等环境物体不要绑定角色，attach.actor 写 WORLD，用世界坐标 position 放在地面上；角色躺/坐在家具上时，调整角色 position 让身体落在家具表面`);
  return issues;
}
