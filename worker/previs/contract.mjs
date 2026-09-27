export const VERSION = 'motion-plan.v1';
export const JOINTS = ['pelvis', 'chest', 'neck', 'head', 'left_shoulder', 'left_elbow', 'left_hand', 'right_shoulder', 'right_elbow', 'right_hand', 'left_hip', 'left_knee', 'left_foot', 'right_hip', 'right_knee', 'right_foot'];
export const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus'];
const fail = message => { throw new Error(message); };
const finite = n => typeof n === 'number' && Number.isFinite(n);
const vec = (v, name, bound = 200) => {
  if (!Array.isArray(v) || v.length !== 3 || v.some(n => !finite(n) || Math.abs(n) > bound)) fail(`${name} 必须为有限三维向量`);
};
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const list = (v, name, min, max) => { if (!Array.isArray(v) || v.length < min || v.length > max) fail(`${name} 数量应为 ${min}–${max}`); };
export function parseJson(text) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

export function parsePlanningResponse(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return { data: JSON.parse(clean), repaired: false }; }
  catch (error) {
    const position = Number(error.message.match(/position (\d+)/)?.[1]);
    // Only remove prose after a complete container, never repair values or truncated plans.
    const junk = Number.isInteger(position) && /[}\]]\s*$/.test(clean.slice(0, position))
      ? clean.slice(position).match(/^[\u3400-\u9fff]{2,80}"?(?=\s*[,}\]])/)?.[0] : undefined;
    if (!junk) throw error;
    return { data: JSON.parse(clean.slice(0, position) + clean.slice(position + junk.length)), repaired: true, removedText: junk, position };
  }
}
export function validateInput(analysis, duration) {
  if (!analysis || !Array.isArray(analysis.beats) || !analysis.beats.length) fail('缺少完整 DNA 分镜');
  if (!finite(duration) || duration <= 0 || duration > 600) fail('当前自动预演支持 10 分钟以内视频');
  list(analysis.beats, '分镜', 1, 150);
  if (!Array.isArray(analysis.source_roles)) fail('DNA 缺少角色表');
  let previous = 0;
  for (const beat of analysis.beats) {
    if (!finite(beat.start_seconds) || !finite(beat.end_seconds) || beat.end_seconds <= beat.start_seconds || Math.abs(beat.start_seconds - previous) > .15 || beat.end_seconds > duration + .15) fail(`DNA 镜头 ${beat.beat_id} 存在时间空洞、重叠或越界，请重新分析`);
    previous = beat.end_seconds;
  }
  if (Math.abs(previous - duration) > .15) fail('DNA 没有覆盖完整源片，不能把漏掉的尾段当成完整预演');
}
export function requirementsFor(beat, start, end) {
  return [
    { id: 'composition', description: [beat.framing, beat.composition, beat.blocking].map(v => typeof v === 'object' ? JSON.stringify(v) : v).filter(Boolean).join('\n') },
    { id: 'camera', description: beat.camera_motion || '保持源片实际摄影方式' },
    { id: 'whole_action', description: beat.visual_action || beat.action || '完整还原本段可见动作' },
    { id: 'props', description: JSON.stringify(beat.props || []) + '；原片中全部可见拿取、接触、放下、飞行与持握状态' },
    ...(beat.action_beats || []).map((b, i) => ({ id: `action_${i}`, at: b.at_seconds - start, description: JSON.stringify(b) })).filter(b => b.at >= 0 && b.at < end - start),
  ];
}
export function validatePlan(plan, expected) {
  if (plan?.schema_version !== VERSION) fail('执行计划版本错误');
  if (!finite(plan.duration) || Math.abs(plan.duration - expected.duration) > .002) fail('执行计划不能改变源片时长');
  list(plan.actors, 'actors', 0, 30); list(plan.props, 'props', 0, 100); list(plan.coverage, 'coverage', 1, 200);
  const allIds = [...plan.actors, ...plan.props].map(e => e.id);
  if (allIds.some(e => !id(e)) || new Set(allIds).size !== allIds.length) fail('角色/道具 ID 非法或重复');
  for (const required of expected.roleIds || []) if (!plan.actors.some(a => a.id === required)) fail(`执行计划漏掉在场角色 ${required}`);
  const track = (keys, name, check) => {
    list(keys, name, 1, 500);
    let prev = -1;
    for (const key of keys) {
      if (!finite(key.at) || key.at < 0 || key.at > plan.duration + 1e-6 || key.at <= prev) fail(`${name} 时间必须严格递增并位于镜头内`);
      if (prev < 0 && key.at !== 0) fail(`${name} 必须给出 0 秒初始状态`);
      prev = key.at; check(key);
    }
  };
  for (const actor of plan.actors) {
    if (!finite(actor.height) || actor.height < .1 || actor.height > 10) fail(`${actor.id} 身高非法`);
    if (!['human', 'animal', 'quadruped'].includes(actor.kind)) fail(`${actor.id} kind 不支持`);
    vec(actor.color, 'actor.color', 1); vec(actor.skin, 'actor.skin', 1);
    track(actor.keys, `${actor.id}.keys`, key => {
      vec(key.position, 'position'); vec(key.rotation, 'rotation', 720);
      key.head_rotation ??= [0, 0, 0]; key.mouth_open ??= 0;
      vec(key.head_rotation, 'head_rotation', 360);
      if (!finite(key.mouth_open) || key.mouth_open < 0 || key.mouth_open > 1) fail('mouth_open 应为0–1');
      if (typeof key.visible !== 'boolean') fail('visible 必须为布尔值');
      if (!key.joints || JOINTS.some(j => !key.joints[j])) fail('每个人物关键帧必须包含全部 16 个关节，避免省略导致重置');
      for (const joint of JOINTS) vec(key.joints[joint], `joints.${joint}`, 3);
    });
  }
  for (const prop of plan.props) {
    list(prop.parts, 'prop.parts', 1, 40);
    for (const p of prop.parts) {
      if (!SHAPES.includes(p.shape)) fail(`不支持的几何体 ${p.shape}`);
      vec(p.position, 'part.position'); vec(p.rotation, 'part.rotation', 720); vec(p.size, 'part.size', 50); vec(p.color, 'part.color', 1);
      if (p.size.some(n => n <= 0)) fail('几何体尺寸必须大于零');
    }
    track(prop.keys, `${prop.id}.keys`, key => {
      vec(key.position, 'prop.position'); vec(key.rotation, 'prop.rotation', 720);
      if (typeof key.visible !== 'boolean') fail('visible 必须为布尔值');
      if (key.attach) {
        if (!plan.actors.some(a => a.id === key.attach.actor) || !JOINTS.includes(key.attach.joint)) fail('道具绑定到不存在的角色/关节');
        vec(key.attach.offset, 'attach.offset', 3);
      }
    });
  }
  track(plan.camera, 'camera', key => {
    vec(key.position, 'camera.position'); vec(key.target, 'camera.target');
    if (!finite(key.lens) || key.lens < 10 || key.lens > 200) fail('焦距应为 10–200mm');
    if (!finite(key.roll) || Math.abs(key.roll) > 360) fail('相机 roll 非法');
    if (Math.hypot(...key.position.map((n, i) => n - key.target[i])) < .05) fail('相机不能与目标重合');
  });
  for (const requirement of expected.requirements) {
    const matches = plan.coverage.filter(c => c.id === requirement.id);
    if (matches.length !== 1) fail(`必须逐条覆盖 ${requirement.id}，不能只画站位`);
    const c = matches[0];
    if (!finite(c.start) || !finite(c.end) || c.start < 0 || c.end < c.start || c.end > plan.duration + 1e-6 || !Array.isArray(c.entities) || c.entities.some(e => e !== 'camera' && !allIds.includes(e)) || typeof c.detail !== 'string' || !c.detail.trim()) fail(`${c.id} 的执行覆盖证据无效`);
  }
  if (!Array.isArray(plan.uncertainties) || plan.uncertainties.some(v => typeof v !== 'string')) fail('必须显式记录 uncertainties');
  return plan;
}
export function validateReview(review, requirements) {
  if (!review || !Array.isArray(review.checks)) fail('审核没有逐项检查结果');
  for (const r of requirements) {
    const matches = review.checks.filter(c => c.id === r.id);
    if (matches.length !== 1) fail(`审核漏检 ${r.id}`);
    const c = matches[0];
    if (!['pass', 'fail', 'uncertain'].includes(c.status) || typeof c.evidence !== 'string' || !c.evidence.trim()) fail(`审核 ${r.id} 缺少视频证据`);
  }
  if (!Array.isArray(review.issues) || review.issues.some(i => typeof i !== 'string')) fail('审核 issues 非法');
  return { ...review, passed: review.checks.every(c => c.status === 'pass') && review.issues.length === 0 };
}

export function validateContinuation(previous, next) {
  const distance = (a, b) => Math.hypot(...a.map((v, i) => v-b[i]));
  for (const actor of previous.actors) {
    const initial = next.actors.find(a => a.id === actor.id)?.keys[0];
    if (!initial) fail(`连续片段丢失角色 ${actor.id}`);
    const last = actor.keys.at(-1);
    if (distance(last.position, initial.position) > .08 || distance(last.rotation, initial.rotation) > 8 || JOINTS.some(j => distance(last.joints[j], initial.joints[j]) * actor.height > .08)) fail(`连续片段 ${actor.id} 的初始姿态没有承接前段末状态`);
  }
  const camera = previous.camera;
  if (distance(camera.position, next.camera[0].position) > .08 || distance(camera.target, next.camera[0].target) > .08 || Math.abs(camera.lens-next.camera[0].lens) > 1) fail('连续片段的摄影没有承接前段末状态');
  for (const prop of previous.props) {
    const key = next.props.find(p => p.id === prop.id)?.keys[0];
    const last = prop.keys.at(-1);
    if (!key || JSON.stringify(last.attach ?? null) !== JSON.stringify(key.attach ?? null) || (!last.attach && distance(last.position, key.position) > .08)) fail(`连续片段的 ${prop.id} 道具状态没有承接前段`);
  }
}
