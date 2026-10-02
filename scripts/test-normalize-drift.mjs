// 模型形状偏差的归一化。
//
// 这一层的价值全在"分寸"上：修得太少，一份好分析因为两个措辞被整条拒收；
// 修得太多，就等于替模型编造证据。所以测试分两半——
// 该修的必须修到，不该碰的必须一根毫毛都不动。

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const load = async (p) => {
  const r = await build({ entryPoints: [p], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

const { normalizeModelDrift, describeDrift } = await load('app/lib/normalize-drift.ts');
const { parseReferenceDna } = await load('app/lib/validation.ts');

const ok = [];
const check = (name, fn) => {
  fn();
  ok.push(name);
  console.log(`  ✅ ${name}`);
};

// ---- 底本用仓库里的合法夹具，省得手搓一份形状对不上的 ----
// 夹具没有 blocking（它是给旧数据兼容用的），这里补上，因为要测的正是 blocking 里的枚举。
const fs = await import('node:fs');
const FIXTURE = JSON.parse(fs.readFileSync('fixtures/video-dna.v1.json', 'utf8'));

const dna = () => {
  const a = JSON.parse(JSON.stringify(FIXTURE));
  a.beats.forEach((b) => {
    b.blocking = {
      actors: b.role_ids.map((role_id, n) => ({
        role_id,
        screen_position: ['center', 'left', 'right'][n % 3],
        depth_layer: 'midground',
        facing: '面向镜头',
      })),
      camera: { shot_size: 'MS', angle: 'eye_level', movement: 'static', screen_direction: 'static' },
    };
  });
  return a;
};

console.log('== 该修的 ==');

check('数组给到了要字符串的字段 → 按原顺序合并，不丢内容', () => {
  const a = dna();
  a.style_dna.performance.gesture_language = ['掌掴挥手', '抱头假寐', '合十求饶'];
  const fixes = normalizeModelDrift(a);
  assert.equal(a.style_dna.performance.gesture_language, '掌掴挥手；抱头假寐；合十求饶');
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].path, /performance\.gesture_language$/);
});

check('枚举带程度修饰词 → slow_dolly_in 归到 dolly_in', () => {
  const a = dna();
  a.beats[1].blocking.camera.movement = 'slow_dolly_in';
  const fixes = normalizeModelDrift(a);
  assert.equal(a.beats[1].blocking.camera.movement, 'dolly_in');
  assert.equal(fixes[0].path, 'beats[1].blocking.camera.movement');
});

check('换个说法 → push_in / wide_shot / over_the_shoulder 都认得', () => {
  const a = dna();
  a.beats[0].blocking.camera.movement = 'push_in';
  a.beats[0].blocking.camera.shot_size = 'wide_shot';
  a.beats[1].blocking.camera.angle = 'over_the_shoulder';
  normalizeModelDrift(a);
  assert.equal(a.beats[0].blocking.camera.movement, 'dolly_in');
  assert.equal(a.beats[0].blocking.camera.shot_size, 'LS');
  assert.equal(a.beats[1].blocking.camera.angle, 'over_shoulder');
});

check('只是大小写或连字符不同 → 认得', () => {
  const a = dna();
  a.beats[0].blocking.camera.screen_direction = 'Left-To-Right';
  normalizeModelDrift(a);
  assert.equal(a.beats[0].blocking.camera.screen_direction, 'left_to_right');
});

check('数字写成了字符串 → 转回数字', () => {
  const a = dna();
  a.style_dna.pacing.average_shot_seconds = '4.5';
  normalizeModelDrift(a);
  assert.equal(a.style_dna.pacing.average_shot_seconds, 4.5);
});

console.log('== 不该碰的 ==');

check('本来就规矩的数据 → 一处都不改，不制造假阳性', () => {
  const a = dna();
  const before = JSON.stringify(a);
  const fixes = normalizeModelDrift(a);
  assert.equal(fixes.length, 0);
  assert.equal(JSON.stringify(a), before);
});

check('猜不出原意的枚举 → 保持原样，让校验照常拒收', () => {
  const a = dna();
  a.beats[0].blocking.camera.movement = '镜头飘忽不定像喝多了';
  const fixes = normalizeModelDrift(a);
  assert.equal(a.beats[0].blocking.camera.movement, '镜头飘忽不定像喝多了');
  assert.equal(fixes.length, 0);
});

check('一个值里有两段运镜 → 不替人做选择', () => {
  const a = dna();
  a.beats[0].blocking.camera.movement = 'pan_then_tilt';   // pan 和 tilt 都命中
  const fixes = normalizeModelDrift(a);
  assert.equal(a.beats[0].blocking.camera.movement, 'pan_then_tilt');
  assert.equal(fixes.length, 0);
});

check('取证事实一律不动：时间轴、镜数、置信度、源片时长', () => {
  const a = dna();
  a.style_dna.performance.gesture_language = ['甲', '乙'];   // 顺带触发一次真修改
  const facts = a.beats.map((b) => [b.beat_id, b.start_seconds, b.end_seconds, b.confidence]);
  const duration = a.source.duration_seconds;
  const count = a.beats.length;
  normalizeModelDrift(a);
  assert.deepEqual(a.beats.map((b) => [b.beat_id, b.start_seconds, b.end_seconds, b.confidence]), facts);
  assert.equal(a.source.duration_seconds, duration);
  assert.equal(a.beats.length, count);
});

check('schema 里本来就是数组的字段不受影响（palette / props / narrative_arc）', () => {
  const a = dna();
  const before = {
    palette: [...a.style_dna.visual.palette],
    props: [...a.beats[0].props],
    arc: [...a.style_dna.narrative_arc],
  };
  normalizeModelDrift(a);
  assert.deepEqual(a.style_dna.visual.palette, before.palette);
  assert.deepEqual(a.beats[0].props, before.props);
  assert.deepEqual(a.style_dna.narrative_arc, before.arc);
});

console.log('== 修了要说 ==');

check('改动清单会写进 uncertainties，界面上看得见', () => {
  const a = dna();
  a.style_dna.performance.gesture_language = ['掌掴挥手', '抱头假寐'];
  a.beats[1].blocking.camera.movement = 'slow_dolly_in';
  const parsed = parseReferenceDna(JSON.stringify(a));
  const line = parsed.uncertainties.find((u) => u.includes('已自动归一'));
  assert.ok(line, 'uncertainties 里没有归一化说明');
  assert.ok(line.includes('2 处'), `没说清修了几处：${line}`);
  assert.ok(line.includes('slow_dolly_in'), '没说清改了什么值');
  assert.ok(line.includes('不会静默放过'), '没说清修不了的仍然拒收');
});

check('没有偏差时不往 uncertainties 里塞废话', () => {
  const parsed = parseReferenceDna(JSON.stringify(dna()));
  assert.equal(parsed.uncertainties.filter((u) => u.includes('已自动归一')).length, 0);
});

check('归一化之后，原本会被拒收的分析能正常进项目', () => {
  const a = dna();
  a.style_dna.performance.gesture_language = ['甲', '乙', '丙'];
  a.beats[0].blocking.camera.movement = 'slow_dolly_in';
  const parsed = parseReferenceDna(JSON.stringify(a));   // 归一化之前这里会抛
  assert.equal(parsed.beats[0].blocking.camera.movement, 'dolly_in');
  assert.equal(parsed.style_dna.performance.gesture_language, '甲；乙；丙');
});

check('describeDrift 空清单返回空串', () => {
  assert.equal(describeDrift([]), '');
});

const encodedTimeline = () => {
  const a = dna();
  a.source.duration_seconds = 141.83;
  const boundaries = [0, 9.6, 27.5, 37.2, 47.3, 107.3, 140.6, 207.4, 211.7, 221.83];
  a.beats = boundaries.slice(1).map((end, i) => ({ ...structuredClone(a.beats[0]),
    beat_id: `BEAT_${i + 1}`, start_seconds: boundaries[i], end_seconds: end,
    action_beats: [{ at_seconds: boundaries[i], actor_ids: a.beats[0].role_ids, action: '动作' }],
  }));
  a.beats[4].action_beats.push({ at_seconds: 103, actor_ids: a.beats[0].role_ids, action: '打蛋' });
  a.beats[6].blocking.actors[0].entry_at = 143;
  a.beats[6].blocking.actors[0].exit_at = 204;
  return a;
};

check('分秒编码误填秒数：完整时间轴、动作和出入画同步转换且留下记录', () => {
  const a = encodedTimeline();
  const parsed = parseReferenceDna(JSON.stringify(a));
  assert.equal(parsed.beats.at(-1).end_seconds, 141.83);
  assert.equal(parsed.beats[4].end_seconds, 67.3);
  assert.equal(parsed.beats[4].action_beats[1].at_seconds, 63);
  assert.equal(parsed.beats[6].blocking.actors[0].entry_at, 103);
  assert.equal(parsed.beats[6].blocking.actors[0].exit_at, 124);
  assert.ok(parsed.uncertainties.some(v => v.includes('分秒编码')));
  assert.equal(a.beats.at(-1).end_seconds, 221.83);
  assert.deepEqual(parseReferenceDna(JSON.stringify(parsed)), parsed);
});

check('真实秒数、错误终点、混用时间和显式例外均不猜测转换', () => {
  for (const change of [
    a => { a.source.duration_seconds = 221.83; },
    a => { a.beats.at(-1).end_seconds = 225; },
    a => { a.beats[4].action_beats[1].at_seconds = 63; },
    a => { a.beats[5].timeline_exception = { kind: 'gap', duration_seconds: 1, reason: '明确例外' }; },
    a => { a.beats[6].blocking.actors[0].entry_at = 180; },
  ]) {
    const a = encodedTimeline(); change(a);
    assert.deepEqual(parseReferenceDna(JSON.stringify(a)).beats, a.beats);
  }
});

check('真实案例：一拍没有执行角色（空 actor_ids）不再让整次付费分析被拒收，移掉的那拍要记下来', () => {
  const a = dna();
  const before = a.beats[1].action_beats.length;
  a.beats[1].action_beats[0].actor_ids = [];
  const parsed = parseReferenceDna(JSON.stringify(a));
  assert.equal(parsed.beats[1].action_beats.length, before - 1);
  assert.ok(parsed.uncertainties.some((u) => u.includes('action_beats[0]') && u.includes('已移出逐拍动作')));
});

check('actor_ids 写成单个字符串时包成一项，内容不改', () => {
  const a = dna();
  const id = a.beats[0].action_beats[0].actor_ids[0];
  a.beats[0].action_beats[0].actor_ids = id;
  const parsed = parseReferenceDna(JSON.stringify(a));
  assert.deepEqual(parsed.beats[0].action_beats[0].actor_ids, [id]);
});

console.log(`\n✅ ${ok.length} 项全过：该修的修到、取证事实没动、修了都说了。`);
