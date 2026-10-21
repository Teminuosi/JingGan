import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['app/lib/post/timeline.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { buildTimeline, layoutCaption, textWidth, segmentToOutputTime, locateOutputTime, frameCount, DEFAULT_FLASH_FRAMES } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} ≠ ${expected}`);

// ---- 段落拼接 + 裁掉多交的秒数 ----
const segs = [
  { id: 'A', durationSeconds: 5.04 },
  { id: 'B', durationSeconds: 10.02, trimTo: 7.5 },
  { id: 'C', durationSeconds: 4, trimTo: 12 }, // trimTo 比实际长：按实际
  { id: 'D', durationSeconds: 3, trimTo: 0 }, // 0 视为不裁
];
const tl = buildTimeline(segs, [], { fps: 30 });
assert.deepEqual(tl.segments.map(s => s.id), ['A', 'B', 'C', 'D']);
near(tl.segments[0].outputStart, 0, 'A start');
near(tl.segments[0].outputEnd, 5.04, 'A end');
near(tl.segments[1].keepSeconds, 7.5, 'B keep');
near(tl.segments[1].outputEnd, 12.54, 'B end');
near(tl.segments[2].keepSeconds, 4, 'C keep');
near(tl.segments[3].keepSeconds, 3, 'D keep');
near(tl.duration, 5.04 + 7.5 + 4 + 3, 'total');
assert.equal(frameCount(tl), Math.floor(19.54 * 30));
assert.throws(() => buildTimeline([{ id: 'X', durationSeconds: 0 }]), /时长无效/);
assert.equal(buildTimeline([]).duration, 0);

// ---- 段内时间 ↔ 成片时间 ----
near(segmentToOutputTime(tl, 'B', 2), 7.04, 'B@2');
assert.equal(segmentToOutputTime(tl, 'B', 8), null); // 落在裁掉的部分
assert.equal(segmentToOutputTime(tl, 'Z', 1), null);
assert.equal(locateOutputTime(tl, 5.04).segment.id, 'B'); // 边界归后一段
near(locateOutputTime(tl, 6).localSeconds, 0.96, 'locate local');
assert.equal(locateOutputTime(tl, tl.duration).segment.id, 'D'); // 片尾归最后一段
assert.equal(locateOutputTime(tl, tl.duration + 1), null);

// ---- 包装轨：裁到片长、闪白帧数、弹字 ----
const withOverlays = buildTimeline([{ id: 'A', durationSeconds: 6 }, { id: 'B', durationSeconds: 6, trimTo: 4 }], [
  { type: 'flash', at: 5.9 },
  { type: 'flash', at: 2, frames: 3 },
  { type: 'flash', at: 9.99 }, // 跨片尾：裁短
  { type: 'flash', at: 12 }, // 片外：丢弃
  { type: 'pop', text: ' 真香！ ', at: 3, duration: 1.2 },
  { type: 'pop', text: '   ', at: 3, duration: 1 }, // 空文字丢弃
  { type: 'caption', text: '今天我们来试试这个新方法', start: -1, end: 2 }, // 片头之前的部分裁掉
  { type: 'caption', text: '最后一句', start: 9, end: 14, speaker: '小猫' },
], { fps: 30 });
near(withOverlays.duration, 10, 'overlay film len');
const flashes = withOverlays.overlays.filter(o => o.type === 'flash');
assert.equal(flashes.length, 3);
near(flashes[0].start, 2, 'flash sorted');
near(flashes[0].end - flashes[0].start, 3 / 30, 'flash frames');
near(flashes[1].end - flashes[1].start, DEFAULT_FLASH_FRAMES / 30, 'default flash frames');
near(flashes[2].end, 10, 'flash clipped');
const pops = withOverlays.overlays.filter(o => o.type === 'pop');
assert.equal(pops.length, 1);
assert.equal(pops[0].text, '真香！');
near(pops[0].end, 4.2, 'pop end');
const caps = withOverlays.overlays.filter(o => o.type === 'caption');
near(caps[0].start, 0, 'caption clipped start');
near(caps.at(-1).end, 10, 'caption clipped end');
assert.equal(caps.at(-1).speaker, '小猫');
for (let i = 1; i < withOverlays.overlays.length; i++) assert.ok(withOverlays.overlays[i].start >= withOverlays.overlays[i - 1].start);

// ---- 字幕排版 ----
assert.equal(textWidth('你好'), 2);
assert.equal(textWidth('OK'), 1);
assert.equal(textWidth('你好OK'), 3);
const short = layoutCaption('你好呀。', 1, 2);
assert.deepEqual(short, [{ lines: ['你好呀'], start: 1, end: 2 }]); // 行尾句号去掉
assert.deepEqual(layoutCaption('真的吗？', 0, 1)[0].lines, ['真的吗？']); // 问号保留
assert.deepEqual(layoutCaption('', 0, 1), []);
assert.deepEqual(layoutCaption('有字', 2, 2), []);

const long = '我本来只是想偷偷玩一下主人的手机，结果一不小心点开了外卖软件，还下了一单三十块的小鱼干，现在主人回来了，我该怎么解释才好呢？';
const chunks = layoutCaption(long, 10, 20);
assert.ok(chunks.length >= 2);
for (const chunk of chunks) {
  assert.ok(chunk.lines.length >= 1 && chunk.lines.length <= 2, `lines ${chunk.lines.length}`);
  for (const line of chunk.lines) {
    assert.ok(textWidth(line) <= 14, `too wide: ${line} (${textWidth(line)})`);
    assert.ok(!/[，。、]$/.test(line), `trailing punct: ${line}`);
  }
}
near(chunks[0].start, 10, 'chunk start');
near(chunks.at(-1).end, 20, 'chunk end');
for (let i = 1; i < chunks.length; i++) near(chunks[i].start, chunks[i - 1].end, 'chunks contiguous');
// 不丢字：去掉标点后拼回来与原文一致
const strip = s => s.replace(/[，。！？、\s]/g, '');
assert.equal(strip(chunks.flatMap(c => c.lines).join('')), strip(long));
// 超宽小句均分，不留两字尾巴；其余在标点处断行
assert.deepEqual(chunks[0].lines, ['我本来只是想偷偷玩', '一下主人的手机']);
assert.deepEqual(chunks[1].lines, ['结果一不小心点开了外卖软件', '还下了一单三十块的小鱼干']);

// 没有标点的长中文：硬切
const noPunct = layoutCaption('一二三四五六七八九十一二三四五六七八九十', 0, 2);
assert.deepEqual(noPunct.flatMap(c => c.lines), ['一二三四五六七八九十', '一二三四五六七八九十']);
// 西文：不劈开单词
const latin = layoutCaption('Shall we try this together tonight, my friend?', 0, 3);
for (const line of latin.flatMap(c => c.lines)) {
  assert.ok(textWidth(line) <= 14, line);
  assert.ok(!line.startsWith(' ') && !line.endsWith(' '));
}
assert.equal(latin.flatMap(c => c.lines).join(' ').replace(/,/g, ''), 'Shall we try this together tonight my friend?');
// 自定义行宽 / 行数
const narrow = layoutCaption('第一句话很短，第二句话也短，第三句话还是短', 0, 3, { maxLineWidth: 7, maxLines: 1 });
assert.deepEqual(narrow.map(c => c.lines), [['第一句话很短'], ['第二句话也短'], ['第三句话还是短']]);
// 时长按字数比例分配
const weighted = layoutCaption('短句，这是一个明显长得多的句子', 0, 3, { maxLineWidth: 14, maxLines: 1 });
assert.ok(weighted.length === 1 || weighted[0].end - weighted[0].start < weighted[1].end - weighted[1].start);

console.log('Post timeline: segment trim/concat, time mapping, overlay clipping, Chinese caption layout passed.');
