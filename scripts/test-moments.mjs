// 关键时刻（analysis.moments）：锚点取证时间、按比例换算到新片时间、清洗。纯本地，不调用任何模型。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const load = async path => {
  const result = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const { momentSourceSeconds, mapMomentTime, normalizeMoments } = await load('app/lib/moments.ts');
const { parseVideoDna } = await load('app/lib/validation.ts');
const base = JSON.parse(await readFile('fixtures/video-dna.v1.json', 'utf8'));

// 两镜：B01 0–2s（1 拍），B02 2–5s（2 拍）。
const analysis = structuredClone(base);
const b2 = analysis.beats[1];
assert.equal(b2.beat_id, 'B02');
b2.action_beats = [{ ...b2.action_beats[0], at_seconds: 2.5 }, { ...b2.action_beats[1], at_seconds: 4 }];
const moment = (over) => ({ id: 'm1', beat_id: 'B02', kind: 'reveal', label: '主人推门', anchor: { type: 'beat', position: 0.5 }, source_seconds: 3.5, emphasis: 2, ...over });

// 取证时间：动作锚点跟着那一拍走，不看模型写的秒数；相对位置按镜长算；对白用给定秒数并夹进本镜。
assert.equal(momentSourceSeconds(analysis, moment({ anchor: { type: 'action', action_index: 1 }, source_seconds: 2.1 })), 4);
assert.equal(momentSourceSeconds(analysis, moment({ anchor: { type: 'beat', position: 0.5 } })), 3.5);
assert.equal(momentSourceSeconds(analysis, moment({ anchor: { type: 'beat', position: 7 } })), 5);           // 夹到 0–1
assert.equal(momentSourceSeconds(analysis, moment({ anchor: { type: 'dialogue', phrase: 'wait' }, source_seconds: 9 })), 5); // 夹进本镜
assert.equal(momentSourceSeconds(analysis, moment({ anchor: { type: 'action', action_index: 9 }, source_seconds: 3 })), 3); // 拍不存在退回秒数
assert.equal(momentSourceSeconds(analysis, moment({ beat_id: 'NOPE' })), undefined);

// 一镜一段，生成段比原片长（3s → 6s）：落在 3.5s 的时刻（本镜 50%）到新片 2 + 3 = 5s。
const longer = [{ beatIds: ['B01'], sourceStart: 0, sourceEnd: 2, outputStart: 0, outputDuration: 2 }, { beatIds: ['B02'], sourceStart: 2, sourceEnd: 5, outputStart: 2, outputDuration: 6 }];
assert.equal(mapMomentTime(analysis, moment(), longer), 5);
// 生成段比原片短（3s → 1.5s）。
const shorter = [{ beatIds: ['B01'], sourceStart: 0, sourceEnd: 2, outputStart: 0, outputDuration: 2 }, { beatIds: ['B02'], sourceStart: 2, sourceEnd: 5, outputStart: 2, outputDuration: 1.5 }];
assert.equal(mapMomentTime(analysis, moment(), shorter), 2.75);
// 动作锚点：第 2 拍在 4s，本镜 2/3 处 → 2 + 6 × 2/3 = 6。
assert.equal(mapMomentTime(analysis, moment({ anchor: { type: 'action', action_index: 1 } }), longer), 6);
// 一镜被拆成两段（B02 / B02_2，4s 处切开）：时刻落在哪段就在哪段里按比例算。
const split = [
  { beatIds: ['B01'], sourceStart: 0, sourceEnd: 2, outputStart: 0, outputDuration: 2 },
  { beatIds: ['B02'], sourceStart: 2, sourceEnd: 4, outputStart: 2, outputDuration: 5 },
  { beatIds: ['B02_2'], sourceStart: 4, sourceEnd: 5, outputStart: 7, outputDuration: 5 },
];
assert.equal(mapMomentTime(analysis, moment({ anchor: { type: 'beat', position: 0.5 } }), split), 5.75); // 3.5s：第一段 75%
assert.equal(mapMomentTime(analysis, moment({ anchor: { type: 'action', action_index: 1 } }), split), 7); // 正好在切点上，归后一段开头
assert.equal(mapMomentTime(analysis, moment({ anchor: { type: 'beat', position: 1 } }), split), 12);     // 最后一段的结尾也算
// 一段装了多镜（RUN 覆盖 B01+B02，原片 0–5s 生成成 10s）。
assert.equal(mapMomentTime(analysis, moment(), [{ beatIds: ['B01', 'B02'], sourceStart: 0, sourceEnd: 5, outputStart: 0, outputDuration: 10 }]), 7);
// 不在任何一段里：没生成这一镜、或段的原片区间不含这个时刻 → undefined，不瞎猜。
assert.equal(mapMomentTime(analysis, moment(), [longer[0]]), undefined);
assert.equal(mapMomentTime(analysis, moment(), [{ beatIds: ['B02'], sourceStart: 4, sourceEnd: 5, outputStart: 0, outputDuration: 3 }]), undefined);
assert.equal(mapMomentTime(analysis, moment({ beat_id: 'GONE' }), longer), undefined);

// 清洗：未知镜头丢掉、重复编号重编、动作序号越界退回相对位置、秒数夹进本镜、重要程度夹到 1–3、按时间排序。
const { moments, dropped } = normalizeMoments(analysis, [
  moment({ id: 'm1', source_seconds: 4.5, anchor: { type: 'action', action_index: 5 }, emphasis: 7 }),
  moment({ id: 'm1', beat_id: 'B01', kind: 'hook', label: ' 开场钩子 ', anchor: { type: 'dialogue', phrase: 'What happened?' }, source_seconds: -3, emphasis: 0 }),
  moment({ id: 'm3', beat_id: 'B99' }),
  moment({ id: 'm4', kind: 'boom' }),
  moment({ id: 'm5', label: '' }),
  'junk',
]);
assert.equal(dropped.length, 4);
assert.deepEqual(moments.map(m => [m.id, m.beat_id, m.kind, m.label, m.source_seconds, m.emphasis]), [['m2', 'B01', 'hook', '开场钩子', 0, 1], ['m1', 'B02', 'reveal', '主人推门', 4.5, 3]]);
assert.deepEqual(moments[1].anchor, { type: 'beat', position: 0.833 });
assert.deepEqual(moments[0].anchor, { type: 'dialogue', phrase: 'What happened?' });
assert.deepEqual(normalizeMoments(analysis, undefined), { moments: [], dropped: [] });

// 分析层：没有 moments 的旧分析一字不动；带 moments 的会被清洗，丢掉的写进待核清单。
const legacy = parseVideoDna(JSON.stringify(base));
assert.ok(!('moments' in legacy));
assert.equal(JSON.stringify(legacy), JSON.stringify(parseVideoDna(JSON.stringify(base))));
const withMoments = structuredClone(base);
withMoments.moments = [moment({ beat_id: 'B02' }), moment({ id: 'x', beat_id: 'B77' })];
const parsed = parseVideoDna(JSON.stringify(withMoments));
assert.equal(parsed.moments.length, 1);
assert.ok(parsed.uncertainties.some(u => u.includes('关键时刻') && u.includes('B77')));

console.log('Moment checks passed: anchors, proportional mapping (longer/shorter/split/multi-beat), out-of-range, normalization, legacy untouched.');
