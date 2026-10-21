// 角色槽位（source_roles[].slot）与残留检查。纯本地，不调用任何模型。
// 旧 DNA（没有 slot）的编译结果必须与加槽位之前逐字节一致：fixtures/role-slots-legacy.snapshot.json
// 是改动前用旧代码生成的快照；带 --update-legacy-snapshot 运行只会重写快照，不跑其余断言。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
const load = async path => {
  const result = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const story = await load('app/lib/original-story.ts');
const swapText = await load('app/lib/role-swap-text.ts');
const { roleForCandidate } = await load('app/lib/role-design.ts');
const { validateCompiledOriginalPack, parseVideoDna } = await load('app/lib/validation.ts');
const analysis = JSON.parse(await readFile('fixtures/video-dna.v1.json', 'utf8'));
const oldPack = JSON.parse(await readFile('fixtures/creative-pack.v1.json', 'utf8'));
const SNAPSHOT = 'fixtures/role-slots-legacy.snapshot.json';

const baseChar = { ...oldPack.character_bible[0] };
const preserveBrief = { workflow: 'same-type-original', mode: 'full_original', sourceRightsScope: 'owned_or_authorized', storyConfirmed: true, targetModel: 'Seedance 2.5', aspectRatio: '9:16', outputLanguage: '简体中文', voiceBrief: 'warm voice', storyMode: 'preserve' };
const rewriteBrief = { ...preserveBrief, storyMode: 'rewrite', outputLanguage: 'English', sourceRightsScope: 'third_party_reference' };
const castFor = (dna, settings) => dna.source_roles.map((role, i) => {
  const designed = roleForCandidate(role, { design_settings: settings[role.role_id] }, dna.style_dna.visual.medium);
  return { ...structuredClone(baseChar), character_id: `CHAR_${String.fromCharCode(65 + i)}`, source_role_id: role.role_id, candidate_id: `SWAP_${i}`, design_name: `换角${i}`, reference_image_prompt: `swap prompt ${i}`, design_mode: 'style_variant', design_settings: settings[role.role_id], entity_type: designed.entity_type, species: designed.species, body_plan: designed.body_plan, anthropomorphism_level: designed.anthropomorphism_level, casting_envelope: designed.casting_envelope };
});
const assetsFor = cast => cast.map(c => ({ character_id: c.character_id, candidate_id: c.candidate_id, asset_id: c.candidate_id, approved: true, retired: false, prompt: c.reference_image_prompt }));

/** 一只动物（ROLE_A）+ 一个人（ROLE_B）的源片，镜头文字里写满动物专属词。 */
function animalAnalysis({ species, appearance, action, step, sound, palette, texture, sfx }) {
  const dna = structuredClone(analysis);
  delete dna.english;
  const human = { ...structuredClone(analysis.source_roles[0]), role_id: 'ROLE_B' };
  const animal = { ...structuredClone(analysis.source_roles[0]), role_id: 'ROLE_A', entity_type: 'animal', species, body_plan: '四足动物身体结构', anthropomorphism_level: 'none', generalized_appearance: appearance, silhouette: '小巧', casting_envelope: { ...analysis.source_roles[0].casting_envelope, apparent_age_band: '幼年', gender_expression: '不限定', build_silhouette: '小巧', hair_grooming: appearance, regional_visual_context: '家庭室内', visual_medium: 'AI视频生成/超写实拟真渲染' } };
  dna.source_roles = [animal, human];
  dna.style_dna.visual = { medium: 'AI视频生成/超写实拟真渲染', palette: [palette, '暖黄台灯'], lighting_logic: '手机屏幕冷光', textures: [texture, '棉质被褥褶皱'], atmosphere: '温馨' };
  dna.style_dna.audio = { ...dna.style_dna.audio, sound_effects: [sfx, '手机提示音'] };
  dna.beats.forEach(b => {
    b.role_ids = ['ROLE_A', 'ROLE_B'];
    b.visual_action = action;
    b.action_beats = [{ at_seconds: b.start_seconds, actor_ids: ['ROLE_A'], action: step, consequence: 'ROLE_B 笑了' }];
    b.framing = '平视主角面部';
    b.color = palette;
    b.sound = sound;
    b.props = ['手机', '被褥'];
    b.dialogue = { ...b.dialogue, speaker_role: 'ROLE_B' };
  });
  return dna;
}
const catDna = () => animalAnalysis({ species: '三花猫 / cat', appearance: '三花小猫', action: '被窝里的小猫专心看亮屏手机，ROLE_B 在旁边笑', step: '小猫趴下枕在被褥上', sound: '轻轻的喵叫、被褥摩擦声', palette: '猫咪三花色彩', texture: '细腻猫毛', sfx: '猫叫声' });
const penguinDna = () => animalAnalysis({ species: '企鹅 / penguin', appearance: '黑白羽毛小企鹅', action: '黑白羽毛的小企鹅摇摇摆摆凑近亮屏手机，ROLE_B 在旁边笑', step: 'penguin 摇摇摆摆趴到被褥上', sound: '短促的嘎嘎叫、被褥摩擦声', palette: '黑白羽毛与橙色喙', texture: '蓬松羽毛', sfx: '企鹅嘎嘎叫声' });
const rewriteDraft = action => ({ schema_version: 'creative-draft.v1', title: '新片', concept_summary: '一只小动物在雨夜帮主人找回钥匙。', differentiation_log: ['事件：找钥匙', '人物：主仆协作', '场景：雨夜门口', '对白：全新台词'], style_lock: { pacing: '紧凑', camera: '中景', visual: '柔光', performance: '克制', sound: '轻钢琴', negative_constraints: ['无水印'] }, beats: [0, 1].map(i => ({ beat_id: `new_${i}`, start_seconds: i * 5, end_seconds: (i + 1) * 5, story_function: '推进', character_ids: ['CHAR_A', 'CHAR_B'], action, performance: '专注', environment: '雨夜门口', props: ['钥匙'], framing: '中景', camera_motion: '缓推', lighting: '路灯', continuity: '承接', dialogue: 'CHAR_B: Good job, buddy.', dialogue_speaker_ids: ['CHAR_B'], sound: '雨声' })), qa: {} });

const corgi = { ROLE_A: { entity_type: 'animal', species: '柯基幼犬 / corgi puppy', visual_medium: '皮克斯风格3D卡通渲染' }, ROLE_B: { visual_medium: '皮克斯风格3D卡通渲染' } };
const robot = { ROLE_A: { entity_type: 'animal', species: '机器人 / robot', visual_medium: '皮克斯风格3D卡通渲染' }, ROLE_B: { visual_medium: '皮克斯风格3D卡通渲染' } };
const compile = (draft, dna, brief, settings) => { const cast = castFor(dna, settings); return story.compileOriginalStory(draft, dna, brief, cast, assetsFor(cast)); };
const promptsOf = pack => [...pack.seedance_asset_map.runs.map(r => r.target_prompt), pack.seedance_asset_map.full_run.target_prompt, ...pack.beats.map(b => b.video_prompt), pack.prompt_bundle.first_frame_prompt, pack.prompt_bundle.last_frame_prompt];

// ---- 旧 DNA（无 slot）快照：这些包在加槽位之前就能编出来，之后必须逐字节相同 ----
const legacyCases = () => {
  const cat = catDna();
  const penguin = penguinDna();
  const fixtureCast = analysis.source_roles.map((role, i) => ({ ...structuredClone(baseChar), character_id: `CHAR_${String.fromCharCode(65 + i)}`, source_role_id: role.role_id, candidate_id: `T_${i}`, design_name: `原创${i}`, design_rationale: 'x', reference_image_prompt: `p${i}` }));
  const adapter = swapText.buildRoleSwapAdapter(cat, { roleDesigns: corgi }, castFor(cat, corgi));
  return {
    fixturePreserve: story.compileOriginalStory(story.projectPreservedDraft(analysis), analysis, preserveBrief, fixtureCast, assetsFor(fixtureCast)),
    catToCorgi: compile(story.projectPreservedDraft(cat), cat, { ...preserveBrief, roleDesigns: corgi }, corgi),
    catKeep: compile(story.projectPreservedDraft(cat), cat, preserveBrief, {}),
    penguinToRobot: compile(story.projectPreservedDraft(penguin), penguin, { ...preserveBrief, roleDesigns: robot }, robot),
    catRewriteCorgiClean: compile(rewriteDraft('CHAR_A 叼起钥匙跑向 CHAR_B'), cat, { ...rewriteBrief, roleDesigns: corgi }, corgi),
    adapterText: ['三花小猫舔了舔猫爪，喵喵叫', 'ROLE_B 抱起小猫', '细腻猫毛，超写实拟真渲染'].map(adapter.text),
  };
};
if (process.argv.includes('--update-legacy-snapshot')) {
  await writeFile(SNAPSHOT, `${JSON.stringify(legacyCases(), null, 1)}\n`);
  console.log(`wrote ${SNAPSHOT}`);
  process.exit(0);
}
const legacy = legacyCases();
const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8'));
// 2026-10-21 三月同意：重写线锁定的画面/声音两行（逐字沿用源片）换角时也要替换，所以这个场景按设计改变，单独断言。
const INTENDED_CHANGE = new Set(['catRewriteCorgiClean']);
for (const key of Object.keys(snapshot).filter(key => !INTENDED_CHANGE.has(key))) {
  // 旧项目可能多出 role_leaks（只有检出残留时才有）；其余字段必须与快照逐字节一致。
  const now = Array.isArray(legacy[key]) ? { value: legacy[key] } : { ...legacy[key] };
  delete now.role_leaks;
  const expected = Array.isArray(snapshot[key]) ? { value: snapshot[key] } : snapshot[key];
  assert.equal(JSON.stringify(now), JSON.stringify(expected), `旧 DNA 场景 ${key} 的编译结果变了`);
}
// 这几个旧场景本来就干净，不该凭空多出残留报告。
for (const key of ['fixturePreserve', 'catToCorgi', 'catKeep', 'penguinToRobot']) assert.equal(legacy[key].role_leaks, undefined, key);
// 重写线锁住「光线与色调」「声音设计」时，画面/声音两行逐字沿用源片（细腻猫毛、猫叫声）：换成柯基后要替换掉，
// 而模型新写的故事动作一字不动。除这几行外，整包与快照一致。
{
  const pack = legacy.catRewriteCorgiClean;
  const leaks = (pack.role_leaks ?? []).filter(l => l.kind !== 'motion');
  assert.equal(leaks.length, 0, JSON.stringify(leaks));
  const runs = pack.seedance_asset_map.runs.map(r => r.target_prompt).join(' ');
  assert.ok(!/猫毛|猫叫声/.test(runs), runs);
  assert.ok(runs.includes('叼起钥匙'), '模型写的新故事动作不改');
  const before = snapshot.catRewriteCorgiClean.seedance_asset_map.runs.map(r => r.target_prompt);
  const after = pack.seedance_asset_map.runs.map(r => r.target_prompt);
  assert.equal(after.length, before.length);
  after.forEach((text, i) => {
    const lines = value => value.split(String.fromCharCode(10));
    const changed = lines(text).filter((line, k) => line !== lines(before[i])[k]);
    assert.ok(changed.every(line => /^(画面|表演|声音|\d)/.test(line) || /秒。/.test(line)), `只允许画面/表演/声音/时长介质行变化：${changed.join(' | ')}`);
  });
}

// ---- 带槽位：换成旧词表里没有的物种（企鹅 → 机器人）----
const penguinSlot = { species_terms: ['小企鹅', '企鹅', 'penguin'], appearance_terms: ['黑白羽毛', '橙色喙', '蓬松羽毛'], voice: { kind: 'animal', description: '短促的嘎嘎叫', terms: ['嘎嘎叫声', '嘎嘎叫', '嘎嘎'] }, motion_terms: ['摇摇摆摆'] };
{
  const dna = penguinDna();
  dna.source_roles[0].slot = penguinSlot;
  const pack = compile(story.projectPreservedDraft(dna), dna, { ...preserveBrief, roleDesigns: robot }, robot);
  validateCompiledOriginalPack(pack);
  for (const prompt of promptsOf(pack)) {
    assert.doesNotMatch(prompt, /企鹅|penguin|嘎嘎|羽毛|橙色喙/i, prompt);
    assert.match(prompt, /CHAR_A（机器人）/);
  }
  const full = pack.seedance_asset_map.full_run.target_prompt;
  assert.match(full, /机器人发出的声音/);                           // 叫声换成新角色的声音
  assert.match(full, /棉质被褥褶皱/);                                // 无关描述原样保留
  assert.match(full, /摇摇摆摆/);                                    // 动作习惯词不硬改，交给残留检查提示
  const leaks = pack.role_leaks ?? [];
  assert.equal(leaks.filter(l => l.kind !== 'motion').length, 0, JSON.stringify(leaks));
  assert.ok(leaks.length > 0 && leaks.every(l => l.kind === 'motion' && l.term === '摇摇摆摆' && l.roleId === 'ROLE_A' && l.characterId === 'CHAR_A' && l.where && Number.isInteger(l.index)));
  assert.ok(leaks.some(l => l.where === 'FULL_RUN') && leaks.some(l => l.where.startsWith('RUN_')) && leaks.some(l => l.where.startsWith('镜头 ')));
  // 剧情数据（动作/对白/时间）不改写，只改出片文字。
  assert.deepEqual(pack.beats.map(b => [b.start_seconds, b.end_seconds, b.dialogue]), story.projectPreservedDraft(dna).beats.map(b => [b.start_seconds, b.end_seconds, b.dialogue]));
  // 没换物种：一个字都不动，也不报残留。
  const keep = compile(story.projectPreservedDraft(dna), dna, preserveBrief, {});
  const keepLegacy = compile(story.projectPreservedDraft(penguinDna()), penguinDna(), preserveBrief, {});
  assert.equal(JSON.stringify(promptsOf(keep)), JSON.stringify(promptsOf(keepLegacy)));
  assert.equal(keep.role_leaks, undefined);
  assert.match(keep.seedance_asset_map.full_run.target_prompt, /小企鹅摇摇摆摆/);
}

// ---- 槽位 + 旧词表：猫换柯基，槽位里多出旧词表没有的词（橘白、呼噜）也要换掉 ----
{
  const dna = catDna();
  dna.beats.forEach(b => { b.sound = '轻轻的喵叫、呼噜声、被褥摩擦声'; b.visual_action = '被窝里橘白相间的小猫专心看亮屏手机，ROLE_B 在旁边笑'; });
  const legacyLeak = compile(story.projectPreservedDraft(dna), dna, { ...preserveBrief, roleDesigns: corgi }, corgi);
  assert.match(legacyLeak.seedance_asset_map.full_run.target_prompt, /呼噜/);   // 旧词表兜不住
  dna.source_roles[0].slot = { species_terms: ['小猫', '猫', 'cat', 'kitten'], appearance_terms: ['橘白相间', '三花'], voice: { kind: 'animal', description: '轻柔的喵叫和呼噜', terms: ['喵', '呼噜声', '呼噜'] }, motion_terms: [] };
  const pack = compile(story.projectPreservedDraft(dna), dna, { ...preserveBrief, roleDesigns: corgi }, corgi);
  validateCompiledOriginalPack(pack);
  for (const prompt of promptsOf(pack)) assert.doesNotMatch(prompt, /猫|喵|呼噜|橘白|三花/, prompt);
  assert.equal(pack.role_leaks, undefined);
  assert.match(pack.seedance_asset_map.full_run.target_prompt, /细腻毛发/);  // 旧词表的部位中性词仍然生效
}

// ---- 英文词按整词换：cat 不能误伤 category / scatter ----
{
  const dna = penguinDna();
  dna.source_roles[0].slot = { ...penguinSlot, species_terms: ['cat'] };
  dna.source_roles[0].species = '猫 / cat';
  const cast = castFor(dna, robot);
  const adapter = swapText.buildRoleSwapAdapter(dna, { roleDesigns: robot }, cast);
  assert.equal(adapter.text('a cat and two cats scatter by the category sign'), 'a CHAR_A（机器人） and two CHAR_A（机器人） scatter by the category sign');
  assert.deepEqual(swapText.findRoleLeaks('category scatter cats', dna, ['ROLE_A']).map(l => l.term), ['cat']);
}

// ---- 两个同类角色只换其一：共有的词说不清指谁，不替换也不报 ----
{
  const dna = penguinDna();
  const seal = { ...structuredClone(dna.source_roles[0]), role_id: 'ROLE_C', species: '海豹 / seal', slot: { species_terms: ['海豹', '小动物'], appearance_terms: [], voice: { kind: 'animal', description: '', terms: [] }, motion_terms: [] } };
  dna.source_roles = [{ ...dna.source_roles[0], slot: { ...penguinSlot, species_terms: [...penguinSlot.species_terms, '小动物'] } }, dna.source_roles[1], seal];
  dna.beats.forEach(b => { b.role_ids = ['ROLE_A', 'ROLE_B', 'ROLE_C']; b.visual_action = '小企鹅和海豹两只小动物挤在一起看手机，ROLE_B 在旁边笑'; });
  const settings = { ...robot, ROLE_C: { visual_medium: '皮克斯风格3D卡通渲染' } };
  const pack = compile(story.projectPreservedDraft(dna), dna, { ...preserveBrief, roleDesigns: settings }, settings);
  const full = pack.seedance_asset_map.full_run.target_prompt;
  assert.match(full, /CHAR_A（机器人）和海豹两只小动物/);            // 没换的海豹一字不动，共有的「小动物」不碰
  assert.ok(!(pack.role_leaks ?? []).some(l => l.term === '小动物' || l.term === '海豹'));
}

// ---- 重写新故事：草稿里残留源物种词，残留检查能报出来（不改写草稿） ----
{
  const dna = catDna();
  const dirty = compile(rewriteDraft('CHAR_A 小猫喵了一声，叼起钥匙跑向 CHAR_B'), dna, { ...rewriteBrief, roleDesigns: corgi }, corgi);
  const terms = new Set((dirty.role_leaks ?? []).map(l => l.term));
  assert.ok(terms.has('小猫') && terms.has('喵'), JSON.stringify(dirty.role_leaks));
  assert.match(dirty.seedance_asset_map.full_run.target_prompt, /小猫喵了一声/);   // 重写线只报不改
  assert.ok(dirty.role_leaks.every(l => l.roleId === 'ROLE_A' && l.kind !== 'motion'));
  // 带槽位时同样报，而且旧词表没有的词也能查到。
  dna.source_roles[0].slot = { species_terms: ['小猫', '猫'], appearance_terms: [], voice: { kind: 'animal', description: '', terms: ['喵', '呼噜'] }, motion_terms: [] };
  const slotDirty = compile(rewriteDraft('CHAR_A 打着呼噜醒来，叼起钥匙跑向 CHAR_B'), dna, { ...rewriteBrief, roleDesigns: corgi }, corgi);
  const slotClean = compile(rewriteDraft('CHAR_A 叼起钥匙跑向 CHAR_B'), dna, { ...rewriteBrief, roleDesigns: corgi }, corgi);
  assert.equal(slotClean.role_leaks, undefined, '锁住的画面/声音行已跟着换角替换，干净的新故事不该再报');
  assert.deepEqual([...new Set(slotDirty.role_leaks.map(l => l.term))], ['呼噜']);
  // 没换物种：重写线也不报。
  assert.equal(compile(rewriteDraft('CHAR_A 小猫喵了一声'), dna, rewriteBrief, {}).role_leaks, undefined);
}

// ---- 分析层：slot 是可选字段，有就校验形状，坏的槽位丢掉而不是拒收整份分析 ----
{
  const dna = structuredClone(analysis);
  dna.source_roles[0].slot = { species_terms: ['人'], appearance_terms: [], voice: { kind: 'speech', description: '成年人说话', terms: [] }, motion_terms: [] };
  assert.deepEqual(parseVideoDna(JSON.stringify(dna)).source_roles[0].slot, dna.source_roles[0].slot);
  const bad = structuredClone(analysis);
  bad.source_roles[0].slot = { species_terms: 'oops' };
  const parsed = parseVideoDna(JSON.stringify(bad));
  assert.equal(parsed.source_roles[0].slot, undefined);
  assert.ok(parsed.uncertainties.some(u => u.includes('slot')));
  assert.equal(JSON.stringify(parseVideoDna(JSON.stringify(analysis))), JSON.stringify(parseVideoDna(JSON.stringify(analysis))));
  assert.ok(!('slot' in parseVideoDna(JSON.stringify(analysis)).source_roles[0]));
}

// ---- 真实分析暴露的两个问题（2026-10-21 牵引绳片）：同物种两只狗只换一只；人的槽位里有「人手」这种碎片词 ----
{
  const dna = structuredClone(analysis);
  delete dna.english;
  const base = analysis.source_roles[0];
  const dog = (role_id, slot) => ({ ...structuredClone(base), role_id, entity_type: 'animal', species: '家犬', body_plan: '四足动物身体结构', anthropomorphism_level: 'none', slot });
  dna.source_roles = [
    { ...structuredClone(base), role_id: 'ROLE_OWNER', slot: { species_terms: ['人', '人手', '主人', 'human', 'hand'], appearance_terms: ['荧光黄色手表'], voice: { kind: 'none', description: '', terms: [] }, motion_terms: ['握持'] } },
    dog('ROLE_BLACK', { species_terms: ['黑狗', '大狗', 'black dog', 'dog'], appearance_terms: ['纯黑短毛'], voice: { kind: 'animal', description: '', terms: ['喘气'] }, motion_terms: ['小跑'] }),
    dog('ROLE_GOLD', { species_terms: ['金毛', '金毛犬', 'golden retriever'], appearance_terms: ['金黄色长毛'], voice: { kind: 'none', description: '', terms: [] }, motion_terms: ['慢走'] }),
  ];
  const settings = { ROLE_OWNER: { entity_type: 'robot', species: '银色机器人 / robot' }, ROLE_BLACK: { entity_type: 'animal', species: '橘猫 / orange cat' } };
  const cast = castFor(dna, settings);
  const adapter = swapText.buildRoleSwapAdapter(dna, { roleDesigns: settings }, cast);
  const text = '主人手持双头牵引绳，黑狗与金毛犬反复交叉换位，黑狗不时喘气。';
  const out = adapter.text(text);
  assert.ok(!out.includes('主CHAR'), `「人手」不能把「主人手持」拆开：${out}`);
  assert.ok(out.includes('CHAR_A（') && out.includes('手持'), out);
  assert.ok(!out.includes('黑狗') && out.includes('CHAR_B（'), `同物种只换一只时，换掉那只的专属叫法照换：${out}`);
  assert.ok(out.includes('金毛犬'), `没换的金毛一字不动：${out}`);
  const swapped = swapText.swappedRoleIds(dna, cast);
  assert.deepEqual(swapText.findRoleLeaks(text, dna, swapped).filter(l => l.roleId === 'ROLE_BLACK').map(l => l.term).sort(), ['喘气', '黑狗', '黑狗'].sort(), '漏换时要报出来');
  assert.ok(!swapText.findRoleLeaks(text, dna, swapped).some(l => ['人', '人手', 'hand', 'human'].includes(l.term)), '泛指词不当专属词');
}
console.log('Role slot checks passed: legacy byte-identical, slot swap to unknown species, word-boundary English, shared-term safety, rewrite leak report, schema shape.');
