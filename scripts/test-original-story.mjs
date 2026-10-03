import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const load = async path => {
  const result = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const { buildDraftFullPrompt, dropSourceMentions, isTextOnlyPack, resizePreservedBeat, splitPreservedBeat, parseStoryDraft, compileOriginalStory, buildStoryTask, projectPreservedDraft, buildDialogueTranslationTask, applyDialogueTranslation, assertPreservedDraft, suggestSplitPoint, beatShotSegments, sourceStyle, applyStyleLocks } = await load('app/lib/original-story.ts');
const { parseReferenceDna, parseVideoDna, validateCompiledOriginalPack } = await load('app/lib/validation.ts');
const { buildCharacterDesignInstruction } = await load('app/lib/prompts.ts');
const vm = await load('app/lib/video-models.ts');
const analysis = JSON.parse(await readFile('fixtures/video-dna.v1.json', 'utf8'));
const oldPack = JSON.parse(await readFile('fixtures/creative-pack.v1.json', 'utf8'));
const characters = oldPack.character_bible.map((c, i) => ({ ...c, character_id: `CHAR_${String.fromCharCode(65 + i)}`, source_role_id: analysis.source_roles[i].role_id, candidate_id: `TEST_${i}`, design_name: `原创${i}`, design_rationale: 'new design', reference_image_prompt: `new prompt ${i}` }));
const assets = characters.map(c => ({ character_id: c.character_id, candidate_id: c.candidate_id, asset_id: c.candidate_id, approved: true, retired: false, prompt: c.reference_image_prompt }));
const draft = { schema_version: 'creative-draft.v1', title: '失而复得的邀请函', concept_summary: '误拿的邀请函让两个陌生人共同完成一场临时演出。', differentiation_log: ['事件改为找回邀请函', '关系改为陌生人协作', '场景改为剧院门口', '对白重新写作'], style_lock: { pacing: '紧凑', camera: '中景转近景', visual: '柔和光线', performance: '克制', sound: '轻钢琴', negative_constraints: ['无水印'] }, beats: Array.from({ length: 4 }, (_, i) => ({ beat_id: `new_${i}`, start_seconds: i * 5, end_seconds: (i + 1) * 5, story_function: '冲突升级', character_ids: ['CHAR_A'], action: `展开邀请函，发现座位号${i}，抬头寻找同行者。`, performance: '先惊讶再微笑', environment: '剧院门口', props: ['邀请函'], framing: '半身中景', camera_motion: '缓慢推进', lighting: '侧窗光', continuity: '右手持邀请函', dialogue: 'CHAR_A: Shall we try this together?', dialogue_speaker_ids: ['CHAR_A'], sound: '纸张轻响' })), qa: {} };
const brief = { workflow: 'same-type-original', mode: 'full_original', sourceRightsScope: 'third_party_reference', storyConfirmed: true, targetModel: 'Seedance 2.5', aspectRatio: '9:16', outputLanguage: 'English', voiceBrief: 'warm voice' };
const result = compileOriginalStory(draft, analysis, brief, characters, assets);
const shotTests = compileOriginalStory(draft, analysis, brief, characters, assets, true);
assert.equal(shotTests.seedance_asset_map.runs.length, draft.beats.length);
shotTests.seedance_asset_map.runs.forEach((run, i) => {
  assert.deepEqual(run.beat_ids, [draft.beats[i].beat_id]);
  assert.equal(run.duration_seconds, 5);
  assert.ok(run.target_prompt.includes('[0–5s]'));
  assert.ok(run.target_prompt.includes(draft.beats[i].dialogue));
  assert.ok(run.target_prompt.includes('CHAR_A'));
});
assert.equal(result.seedance_asset_map.runs.length, 2);
assert.ok(result.seedance_asset_map.bindings.every(b => b.kind === 'character_reference'));
assert.equal(result.beats[0].action, draft.beats[0].action);
assert.equal(result.beats[0].dialogue, draft.beats[0].dialogue);
assert.equal(result.beats.at(-1).end_seconds, 20); // independent from reference duration
assert.equal(result.qa.originality_pass, false); // never claims platform approval
for (const run of result.seedance_asset_map.runs) {
  assert.ok(run.duration_seconds <= 15);
  assert.ok(run.target_prompt.length <= 3800);
  assert.ok(!/@Video|@Image|SOURCE PREP|无声参考视频|source-video clip/.test(run.target_prompt));
  assert.equal((run.target_prompt.match(/【在此绑定/g) ?? []).length, 1);
  assert.ok(run.target_prompt.includes('[0–5s]'));
}
const fullRun = result.seedance_asset_map.full_run; // one prompt for the whole new-story timeline
assert.equal(fullRun.run_id, 'FULL_RUN');
assert.equal(fullRun.source_start_seconds, 0);
assert.equal(fullRun.source_end_seconds, 20);
assert.equal(fullRun.duration_seconds, 20);
assert.deepEqual(fullRun.beat_ids, draft.beats.map(b => b.beat_id)); // covers every shot, no segment left out
assert.equal(fullRun.within_character_limit, true);
assert.ok(!fullRun.target_prompt.includes('[素材绑定'));
assert.ok(fullRun.target_prompt.includes('20 秒。') && !fullRun.target_prompt.includes('9:16'));
// 提示词不得回吐 schema 字段名、分析报告标签，或只对本系统有意义的说明。
assert.ok(!/apparent_age_band|wardrobe_function|hair_grooming|build_silhouette|regional_visual_context/.test(fullRun.target_prompt));
assert.ok(!/(Color|Composition|Transition in|Medium|Palette|Framing|Average shot|Energy curve)\s*:/.test(fullRun.target_prompt));
assert.ok(!/。。|。；/.test(fullRun.target_prompt));
assert.equal((fullRun.target_prompt.match(/【在此绑定/g) ?? []).length, characters.length); // still binds each character image exactly once
assert.ok(!/@Video|@Image|SOURCE PREP|无声参考视频|source-video clip/.test(fullRun.target_prompt));
for (const beat of draft.beats) assert.ok(fullRun.target_prompt.includes(beat.action) && fullRun.target_prompt.includes(beat.dialogue));
assert.ok(fullRun.target_prompt.includes('[0–5s]') && fullRun.target_prompt.includes('[15–20s]')); // absolute new-story timeline
assert.ok(result.seedance_asset_map.runs.length === 2); // segmented runs kept for testing/fallback
const offscreen = structuredClone(draft);
offscreen.beats[0].character_ids = [];
assert.ok(compileOriginalStory(offscreen, analysis, brief, characters, assets).seedance_asset_map.runs[0].target_prompt.includes('【在此绑定'));
const long = structuredClone(draft);
long.beats.forEach(b => { b.action += '细节'.repeat(900); });
const longResult = compileOriginalStory(long, analysis, brief, characters, assets);
assert.ok(longResult.seedance_asset_map.runs.length > 2);
assert.ok(longResult.seedance_asset_map.runs[0].target_prompt.includes(long.beats[0].action));
// An over-long full prompt is flagged, never truncated and never blocks the segmented export.
assert.equal(longResult.seedance_asset_map.full_run.within_character_limit, false);
assert.ok(longResult.seedance_asset_map.full_run.target_prompt.length > 4000);
assert.ok(longResult.seedance_asset_map.full_run.assembly_instruction.includes('超过'));
for (const beat of long.beats) assert.ok(longResult.seedance_asset_map.full_run.target_prompt.includes(beat.action));
// 对白语言：选中文时任务书、示例台词和 Seedance 声音块都必须是中文，且不受旧的英文“对白要求”影响。
const zhBrief = { ...brief, outputLanguage: '简体中文' };
const zhTask = buildStoryTask(analysis, zhBrief);
assert.ok(zhTask.includes('全部台词必须用简体中文写'));
assert.ok(zhTask.includes('language=简体中文'));
assert.ok(!zhTask.includes('New English line'));
assert.ok(!/默认英文原创对白/.test(zhTask));
const staleBrief = { ...zhBrief, dialogueBrief: '创作自然的英文新对白，服务新故事和人物关系。' };
assert.ok(buildStoryTask(analysis, staleBrief).includes('语言一律按 language 写')); // 旧项目里存着英文要求也会被语言选择覆盖
assert.ok(buildStoryTask(analysis, brief).includes('全部台词必须用English写')); // 选英文时仍是英文
const zhDraft = structuredClone(draft);
zhDraft.beats.forEach((b, i) => { b.dialogue = `CHAR_A: 东侧检修口的锁我找到了${i}。`; });
const zhPack = compileOriginalStory(zhDraft, analysis, zhBrief, characters, assets);
assert.equal(zhPack.beats[0].dialogue, zhDraft.beats[0].dialogue);
assert.ok(zhPack.seedance_asset_map.full_run.target_prompt.includes('以简体中文逐字读出下面的台词'));
assert.ok(zhPack.seedance_asset_map.full_run.target_prompt.includes('台词用简体中文。'));
assert.ok(zhPack.seedance_asset_map.full_run.target_prompt.includes('东侧检修口的锁我找到了0。'));
const zhTooLong = structuredClone(zhDraft); // 5秒镜头塞60个汉字，中文也要能查出说不完
zhTooLong.beats[0].dialogue = `CHAR_A: ${'检修口的锁我已经找到了并且确认过'.repeat(4)}。`;
assert.throws(() => parseStoryDraft(JSON.stringify(zhTooLong), analysis), /说不完/);
assert.throws(() => compileOriginalStory(draft, analysis, { ...brief, storyConfirmed: false }, characters, assets), /确认/);
assert.throws(() => compileOriginalStory(draft, analysis, brief, characters, []), /参考图/);
const bad = structuredClone(draft);
bad.beats[0].end_seconds = 0;
assert.throws(() => parseStoryDraft(JSON.stringify(bad), analysis), /时间/);
bad.beats[0] = { ...draft.beats[0], dialogue: 'CHAR_Z: Hello.' };
assert.throws(() => parseStoryDraft(JSON.stringify(bad), analysis), /标签/);
const sourceBad = structuredClone(analysis);
sourceBad.beats.at(-1).end_seconds += 40;
assert.throws(() => parseVideoDna(JSON.stringify(sourceBad)));
assert.ok(parseReferenceDna(JSON.stringify(sourceBad)).uncertainties.some(x => x.includes('参考层待核')));
assert.ok(buildStoryTask(analysis, brief).includes('story-draft.json'));
assert.ok(buildStoryTask(analysis, brief).includes('不得逐镜复制'));
assert.deepEqual(draft.beats[0].dialogue_speaker_ids, ['CHAR_A']);
// 编译后校验：原创线的第二道闸。真实结构必须过，注入故障必须被拦。
const mustPass = (label, fn) => { try { fn(); } catch (e) { throw new Error(`${label} 本应通过但被拦：${e.message}`); } };
const mustFail = (label, fn) => { let ok = false; try { fn(); } catch { ok = true; } if (!ok) throw new Error(`${label} 本应被拦却通过了`); };
mustPass('编译产物', () => validateCompiledOriginalPack(result));
mustPass('按英文校验对白', () => validateCompiledOriginalPack(result, 'English'));
mustFail('选中文但对白是英文', () => validateCompiledOriginalPack(result, '简体中文'));
mustPass('中文包按中文校验', () => validateCompiledOriginalPack(zhPack, '简体中文'));
mustFail('中文包按英文校验', () => validateCompiledOriginalPack(zhPack, 'English'));
for (const [language, line] of [['Japanese', '一緒に行こう。'], ['Cantonese', '一齊試下啦。'], ['繁體中文', '我們一起試試吧。'], ['Thai', 'ไปกันเถอะ'], ['Spanish', 'Vamos juntos.'], ['Korean', '같이 가요.']]) {
  const localizedBrief = { ...brief, outputLanguage: language };
  const localizedDraft = structuredClone(draft);
  localizedDraft.beats.forEach(beat => { beat.dialogue = `CHAR_A: ${line}`; });
  const localizedPack = compileOriginalStory(localizedDraft, analysis, localizedBrief, characters, assets);
  mustPass(`${language} 导出校验`, () => validateCompiledOriginalPack(localizedPack, language));
  assert.ok(localizedPack.seedance_asset_map.full_run.target_prompt.includes(`台词用${language}`));
  assert.ok(buildStoryTask(analysis, localizedBrief).includes(`language=${language}`));
  assert.ok(buildDialogueTranslationTask(analysis, localizedBrief).includes(language));
  const preserved = projectPreservedDraft(analysis);
  const lines = preserved.beats.filter(beat => beat.dialogue.trim()).map(beat => ({ beat_id: beat.beat_id, text: line }));
  assert.ok(lines.length > 0);
  const translated = applyDialogueTranslation(preserved, JSON.stringify({ lines }), localizedBrief);
  assert.ok(translated.beats.some(beat => beat.dialogue.includes(line)));
}
const broken = () => JSON.parse(JSON.stringify(result));
let b;
b = broken(); b.seedance_asset_map.runs[0].target_prompt += ' 请附上 无声参考视频 作为动作依据。';
mustFail('提示词偷偷要求原视频', () => validateCompiledOriginalPack(b));
b = broken(); b.seedance_asset_map.full_run.within_character_limit = false;
mustFail('整片超限标记与实际不符', () => validateCompiledOriginalPack(b));
b = broken(); b.seedance_asset_map.runs.pop();
mustFail('分段未覆盖完整时长', () => validateCompiledOriginalPack(b));
b = broken(); b.seedance_asset_map.full_run.beat_ids.pop();
mustFail('整片漏掉镜头', () => validateCompiledOriginalPack(b));
b = broken(); b.seedance_asset_map.runs[0].target_prompt = b.seedance_asset_map.runs[0].target_prompt.split(draft.beats[0].dialogue).join('(dialogue removed)');
mustFail('台词被截断', () => validateCompiledOriginalPack(b));
b = broken(); b.seedance_asset_map.bindings[0].approved = false;
mustFail('角色图未确认就导出', () => validateCompiledOriginalPack(b));
b = broken(); b.seedance_asset_map.bindings.push({ ...b.seedance_asset_map.bindings[0] }); b.character_bible.push({ ...b.character_bible[0], character_id: 'CHAR_B' });
mustFail('两个角色绑同一张图', () => validateCompiledOriginalPack(b));
b = broken(); b.seedance_asset_map.bindings.push({ slot: '@Video 1', kind: 'source_video_reference', instruction: 'x' });
mustFail('混入原视频素材绑定', () => validateCompiledOriginalPack(b));
b = broken(); b.remix_policy.source_rights_scope = 'unselected';
mustFail('权利范围未声明', () => validateCompiledOriginalPack(b));
b = broken(); b.beats[1].video_prompt += ' 参考 ROLE_A 的表演。';
mustFail('泄漏源角色引用', () => validateCompiledOriginalPack(b));
// 候选 ID 形如 ROLE_A_OPTION_2，是结构性映射，不能被当成源角色泄漏。
mustPass('候选 ID 不算泄漏', () => validateCompiledOriginalPack(result));
// 差异化记录归一化：旧模板的“事件如何改变：”也要能过轴名校验。
assert.ok(result.differentiation_log.every(x => /^(事件|人物|场景|对白)：/.test(x)));

// 每镜上限跟着目标视频模型走：写进任务书，而不是让用户在「新想法」里手写。
assert.ok(buildStoryTask(analysis, brief).includes('每镜最多10秒'));            // 默认 10 秒
assert.ok(buildStoryTask(analysis, brief, 15).includes('每镜最多15秒'));
assert.ok(buildStoryTask(analysis, brief, 6).includes('每镜最多6秒'));
assert.ok(buildStoryTask(analysis, brief, 99).includes('每镜最多15秒'));         // 夹到全站上限
assert.ok(buildStoryTask(analysis, brief, 1).includes('每镜最多3秒'));           // 不允许收到不可用的程度
assert.ok(buildStoryTask(analysis, brief, 10).includes('目标视频模型单次只能生成这么长'));

// 保留原剧情模式：本地投影 + 只翻译台词，剧情逐镜照搬源片。
const preserveBrief = { ...brief, storyMode: 'preserve', outputLanguage: '简体中文', sourceRightsScope: 'owned_or_authorized' };
const noTranscript = structuredClone(analysis);
noTranscript.beats.forEach(b => { b.dialogue.source_text = ''; b.dialogue.semantic_intent = 'celebration'; b.dialogue.speaker_role = noTranscript.source_roles[0].role_id; });
const silentProjection = projectPreservedDraft(noTranscript);
assert.ok(silentProjection.beats.every(b => b.dialogue === '' && b.dialogue_speaker_ids.length === 0), 'Untranscribed placeholders must not become translatable dialogue');
assert.doesNotThrow(() => applyDialogueTranslation(silentProjection, '{"lines":[]}', preserveBrief));
const projected = projectPreservedDraft(analysis);
assert.equal(projected.beats.length, analysis.beats.length);           // 镜头数与源片一致
assert.equal(projected.differentiation_log.length, 2);                  // 只动身份和对白两条轴
projected.beats.forEach((b, i) => {
  assert.equal(b.beat_id, analysis.beats[i].beat_id);
  assert.equal(b.start_seconds, analysis.beats[i].start_seconds);
  assert.equal(b.action, analysis.beats[i].visual_action);              // 动作逐字照搬，不经过模型
});
const translateTask = buildDialogueTranslationTask(analysis, preserveBrief);
assert.ok(translateTask.includes('只翻译台词'));
assert.ok(translateTask.includes('约每秒 5 个汉字'));
assert.ok(!translateTask.includes(analysis.beats[0].visual_action));    // 任务书只发台词，不发剧情
const speakingBeats = analysis.beats.filter(b => b.dialogue.source_text.trim());
if (speakingBeats.length) {
  const good = JSON.stringify({ lines: speakingBeats.map(b => ({ beat_id: b.beat_id, text: '你先停一下。' })) });
  const zhPreserved = applyDialogueTranslation(projected, good, preserveBrief);
  assert.ok(zhPreserved.beats.some(b => b.dialogue.includes('你先停一下。')));
  assert.throws(() => applyDialogueTranslation(projected, JSON.stringify({ lines: [] }), preserveBrief), /没有拿到译文/);
  assert.throws(() => applyDialogueTranslation(projected, JSON.stringify({ lines: speakingBeats.map(b => ({ beat_id: b.beat_id, text: 'Stop right there.' })) }), preserveBrief), /语言/);
  assert.throws(() => applyDialogueTranslation(projected, JSON.stringify({ lines: speakingBeats.map(b => ({ beat_id: b.beat_id, text: '你先停一下再听我说完'.repeat(15) })) }), preserveBrief), /说不完/);
}
assert.throws(() => applyDialogueTranslation(projected, 'oops', preserveBrief), /JSON/);
// 保留模式锁的是“同一个故事、同样长”，不是“镜头与源片一刀不差”：
// 长镜拆成两镜剧情与总时长都没变，必须允许，否则源片有超长镜时完全没有出路。
const splitOnce = splitPreservedBeat(projected, 0);
assert.equal(splitOnce.beats.length, projected.beats.length + 1);
assert.equal(splitOnce.beats.at(-1).end_seconds, projected.beats.at(-1).end_seconds);   // 总时长不变
assert.doesNotThrow(() => assertPreservedDraft(splitOnce, analysis));
for (let i = 1; i < splitOnce.beats.length; i += 1) {
  assert.ok(Math.abs(splitOnce.beats[i].start_seconds - splitOnce.beats[i - 1].end_seconds) < 0.011);  // 仍然连续
}
const tamperedTime = structuredClone(projected); tamperedTime.beats.at(-1).end_seconds += 3;
assert.throws(() => assertPreservedDraft(tamperedTime, analysis), /总时长/);        // 改总长要拦
const gapped = structuredClone(projected); gapped.beats[1].start_seconds += 1;
assert.throws(() => assertPreservedDraft(gapped, analysis), /不连续/);              // 出现空洞要拦
const droppedBeat = structuredClone(projected); droppedBeat.beats.pop();
assert.throws(() => assertPreservedDraft(droppedBeat, analysis), /总时长/);         // 删镜头会让总长对不上
// 改时长由下一镜吸收，总时长恒定；挤爆下一镜或改最后一镜都要拦
// 夹具是 5 秒两镜（2s + 3s）：第一镜拉到 3 秒，第二镜相应缩到 2 秒，总长仍是 5 秒。
const resized = resizePreservedBeat(projected, 0, 3);
assert.equal(resized.beats[0].end_seconds - resized.beats[0].start_seconds, 3);
assert.equal(resized.beats[1].end_seconds - resized.beats[1].start_seconds, 2);
assert.equal(resized.beats.at(-1).end_seconds, projected.beats.at(-1).end_seconds);
assert.doesNotThrow(() => assertPreservedDraft(resized, analysis));
assert.throws(() => resizePreservedBeat(projected, 0, 4.5), /不足 1 秒/);
assert.throws(() => resizePreservedBeat(projected, projected.beats.length - 1, 5), /最后一镜/);
assert.throws(() => splitPreservedBeat({ ...projected, beats: [{ ...projected.beats[0], end_seconds: projected.beats[0].start_seconds + 1 }] }, 0), /不足 2 秒/);

// ---- 六把 DNA 锁 ----
// 锁必须在编译期真的生效，不能只靠任务书嘱咐模型：模型不照做时，成片仍要按源片风格走。
const allLocked = { pacing: true, camera: true, lighting: true, performance: true, sound: true, narrative: true };
const allOpen = { pacing: false, camera: false, lighting: false, performance: false, sound: false, narrative: false };
const src = sourceStyle(analysis);
const madeUp = { pacing: '自创节奏', camera: '自创摄影', visual: '自创视觉', performance: '自创表演', sound: '自创声音', negative_constraints: ['无水印'] };
const locked = applyStyleLocks(madeUp, analysis, allLocked);
assert.equal(locked.pacing, src.pacing);
assert.equal(locked.camera, src.camera);
assert.equal(locked.visual, src.visual);          // lighting 这把锁管的是 style_lock.visual
assert.equal(locked.performance, src.performance);
assert.equal(locked.sound, src.sound);
assert.deepEqual(locked.negative_constraints, ['无水印']);   // 锁不该碰负面约束
assert.deepEqual(applyStyleLocks(madeUp, analysis, allOpen), madeUp);   // 全解锁时一个字都不改
const halfLocked = applyStyleLocks(madeUp, analysis, { ...allOpen, camera: true });
assert.equal(halfLocked.camera, src.camera);
assert.equal(halfLocked.pacing, '自创节奏');       // 只锁一项就只改一项
// 任务书要把锁的内容明说，只说“锁住了”而不给源片原值，模型只能猜
const lockedTask = buildStoryTask(analysis, { ...brief, locks: allLocked });
assert.ok(lockedTask.includes('【锁定】') && !lockedTask.includes('【解锁】'));
assert.ok(lockedTask.includes(src.camera));                                  // 源片原值要给出去
assert.ok(lockedTask.includes(analysis.style_dna.hook_pattern));             // narrative 锁给钩子机制
const openTask = buildStoryTask(analysis, { ...brief, locks: allOpen });
assert.ok(openTask.includes('【解锁】') && !openTask.includes('【锁定】'));
// 编译期兜底：草稿写了自创风格，但用户锁了摄影 → 成片必须按源片摄影走
const lockedPack = compileOriginalStory({ ...draft, style_lock: { ...madeUp } }, analysis, { ...brief, locks: { ...allOpen, camera: true } }, characters, assets);
assert.equal(lockedPack.style_lock.camera, src.camera);
assert.equal(lockedPack.style_lock.pacing, '自创节奏');
// 保留原剧情是逐镜复刻，不管 brief 里怎么写，六项一律按源片
const preserveLocked = compileOriginalStory(projected, analysis, { ...preserveBrief, locks: allOpen }, characters, assets);
for (const field of ['pacing', 'camera', 'visual', 'performance', 'sound']) {
  assert.equal(preserveLocked.style_lock[field], src[field], `保留模式的 ${field} 必须锁死在源片值`);
}

// ---- 镜头内部的逐拍动作 action_beats ----
// 一个不间断机位里可能有好几个回合，整镜一句概括会把因果吃掉；下面这一串保证拍点能被记住、拆开、用上。
const stepped = projected.beats[1];
assert.equal(stepped.action_beats.length, analysis.beats[1].action_beats.length);
assert.ok(stepped.action_beats.every(s => s.actor_ids.every(id => id.startsWith('CHAR_'))));   // 投影后不能漏出 ROLE_*
assert.deepEqual(suggestSplitPoint(stepped, 15), { at: 3.5, beatIndex: 1 });                   // 拆点落在两拍之间
assert.equal(suggestSplitPoint(projected.beats[0], 15), undefined);                            // 只有一拍就没有可下刀处
const splitByStep = splitPreservedBeat(projected, 1);
assert.equal(splitByStep.beats[1].end_seconds, 3.5);
assert.deepEqual(splitByStep.beats[1].action_beats.map(s => s.at_seconds), [2]);
assert.deepEqual(splitByStep.beats[2].action_beats.map(s => s.at_seconds), [3.5]);
assert.notEqual(splitByStep.beats[1].action, splitByStep.beats[2].action);                     // 动作文字跟着分开，不再两段顶着同一句
assert.doesNotThrow(() => assertPreservedDraft(splitByStep, analysis));
// 改边界时拍点必须跟着换镜，否则拍点掉出所属镜头区间，导出时才被拦
assert.deepEqual(resized.beats[0].action_beats.map(s => s.at_seconds), [0, 2]);
assert.deepEqual(resized.beats[1].action_beats.map(s => s.at_seconds), [3.5]);
assert.doesNotThrow(() => parseVideoDna(JSON.stringify(analysis)));
for (const [label, mutate, pattern] of [
  ['越界', a => { a.beats[1].action_beats[1].at_seconds = 9; }, /不在本镜/],
  ['乱序', a => { a.beats[1].action_beats.reverse(); }, /递增/],
  ['角色不存在', a => { a.beats[1].action_beats[0].actor_ids = ['ROLE_Z']; }, /不存在的角色/],
  ['指向的角色不存在', a => { a.beats[1].action_beats[0].toward_ids = ['ROLE_Z']; }, /不存在的角色/],
  ['动作为空', a => { a.beats[1].action_beats[0].action = '   '; }, /action必须是非空字符串/],
]) {
  const broken = structuredClone(analysis);
  mutate(broken);
  assert.throws(() => parseVideoDna(JSON.stringify(broken)), pattern, `${label}的拍点应当被拦下`);
}
// 发起者为空不再整份拒收：多半是画面里没人、只有镜头或环境在动（真实案例：机舱门片子第 1 拍）。
// 这一拍移出 action_beats 并记进 uncertainties，整段动作描述仍在；其余拍点照常保留。
{
  const actorless = structuredClone(analysis);
  const count = actorless.beats[1].action_beats.length;
  actorless.beats[1].action_beats[0].actor_ids = [];
  const parsed = parseVideoDna(JSON.stringify(actorless));
  assert.equal(parsed.beats[1].action_beats.length, count - 1, '没有执行角色的那一拍要移出');
  assert.ok(parsed.uncertainties.some(item => item.includes('已移出逐拍动作')), '移出必须留痕');
}
// 向后兼容：旧 DNA 没有 action_beats，解析、投影、拆镜、分镜表都要照常工作（退回按镜处理）
const legacyDna = structuredClone(analysis);
for (const b of legacyDna.beats) delete b.action_beats;
const legacy = parseVideoDna(JSON.stringify(legacyDna));
assert.ok(legacy.beats.every(b => b.action_beats === undefined));
const legacyProjected = projectPreservedDraft(legacy);
assert.ok(legacyProjected.beats.every(b => b.action_beats === undefined));
assert.equal(suggestSplitPoint(legacyProjected.beats[1], 15), undefined);
assert.equal(beatShotSegments(legacyProjected.beats).byActionBeat, false);
assert.doesNotThrow(() => splitPreservedBeat(legacyProjected, 1));
// 提示词：有拍点就逐行展开，没有就只留原来那一行（回归保护）
const preservePack = compileOriginalStory(projected, analysis, preserveBrief, characters, assets);
const longAnalysis = structuredClone(analysis);
longAnalysis.beats = [{ ...longAnalysis.beats[0], end_seconds: 33.3 }];
longAnalysis.source.duration_seconds = 33.3;
const longDraft = projectPreservedDraft(longAnalysis);
const longPack = compileOriginalStory(longDraft, longAnalysis, preserveBrief, characters, assets);
assert.equal(longDraft.beats.length, 1);
assert.equal(longPack.beats.length, 2);
assert.equal(longPack.beats.at(-1).end_seconds, 33.3);
assert.ok(longPack.seedance_asset_map.runs.every(run => run.duration_seconds <= 30));
assert.doesNotThrow(() => validateCompiledOriginalPack(longPack));
const steppedPrompt = preservePack.beats[1].video_prompt;
assert.ok(steppedPrompt.includes('\n  2s ') && steppedPrompt.includes('\n  3.5s '));
assert.ok(steppedPrompt.includes(analysis.beats[1].action_beats[1].action));
assert.ok(preservePack.seedance_asset_map.full_run.target_prompt.includes('3.5s'));            // 整片提示词同样带拍点
assert.equal(result.beats[0].video_prompt.split('\n')[1], `动作：${draft.beats[0].action}`);   // 无拍点时逐字维持原样
assert.equal(result.beats[0].video_prompt.split('\n').filter(l => l.startsWith('动作：')).length, 1);
// shots 分镜表按拍切，且时长之和仍精确等于固定档时长
const segmented = beatShotSegments(preservePack.beats);
assert.equal(segmented.byActionBeat, true);
assert.equal(segmented.segments.length, 3);                                                     // 1 拍的镜头仍按整镜算，2 拍的拆成两段
assert.ok(Math.abs(segmented.segments.reduce((sum, s) => sum + s.seconds, 0) - 5) < 0.001);     // 覆盖整段时间，不漏第一拍之前那一截
const steppedShots = vm.buildShots(segmented.segments, 15);
assert.equal(steppedShots.shots.reduce((sum, s) => sum + s.duration, 0), 15);
// 超过 15 段就整体退回按镜切，不做截断——宁可粗一点，也不能把后半段内容丢掉
const crowded = { ...preservePack.beats[1], action_beats: Array.from({ length: 16 }, (_, i) => ({ at_seconds: 2 + i * 0.1, actor_ids: ['CHAR_A'], action: `第 ${i} 拍` })) };
assert.equal(beatShotSegments([crowded]).byActionBeat, false);
// 逐镜复刻只能用于自有/已授权素材（PROJECT.md 非目标）
assert.throws(() => compileOriginalStory(projected, analysis, { ...preserveBrief, sourceRightsScope: 'third_party_reference' }, characters, assets), /自有或已获授权/);

// 这条管线不给模型任何原片输入，提示词就不该指代一个它看不见的原片。
for (const run of [...result.seedance_asset_map.runs, result.seedance_asset_map.full_run]) {
  assert.ok(!/原片|参考片|源片|参考录音/.test(run.target_prompt.replace(/不需要参考视频/g, '')));
}
// 旧草稿里存着指代原片的老负面约束时，编译要清掉而不是让导出卡死。
const staleDraft = structuredClone(draft);
staleDraft.style_lock.negative_constraints = ['不得出现原片角色身份或面孔', '不要字幕水印'];
staleDraft.concept_summary = '新故事梗概。原片摘要：某个监狱短片。风格保持一致。';
const staleCompiled = compileOriginalStory(staleDraft, analysis, brief, characters, assets);
for (const run of [...staleCompiled.seedance_asset_map.runs, staleCompiled.seedance_asset_map.full_run]) {
  assert.ok(!/原片|参考片|源片/.test(run.target_prompt.replace(/不需要参考视频/g, '')));
}
assert.ok(staleCompiled.seedance_asset_map.runs[0].target_prompt.includes('不要字幕水印'));   // 干净的那条要留下
mustPass('旧草稿清理后可导出', () => validateCompiledOriginalPack(staleCompiled));
assert.equal(dropSourceMentions('一只小狗争取话语权。原片摘要：某片。保持冷调。'), '一只小狗争取话语权。保持冷调。');
assert.equal(dropSourceMentions('不得出现原片角色面孔'), '');

// 面板路由按“有没有原视频绑定”判断，不能只认 effective_mode：
// 保留原剧情记的是 character_swap，与旧的上传无声原视频复刻线同名，之前因此掉进了老面板。
assert.ok(isTextOnlyPack(result));                                   // 重写线
const preservedPack = compileOriginalStory(projected, analysis, preserveBrief, characters, assets);
const roleTextAnalysis = structuredClone(analysis);
roleTextAnalysis.beats[0].visual_action = 'ROLE_A抬头，随后role_a放下道具。';
const roleTextDraft = projectPreservedDraft(roleTextAnalysis, preserveBrief);
const roleTextCharacters = structuredClone(characters);
roleTextCharacters[0].identity_anchors.push('ROLE_A keeps the same markings.');
roleTextCharacters[0].candidate_id = 'ROLE_A_OPTION_1';
const roleTextAssets = assets.map((a, i) => ({ ...a, candidate_id: roleTextCharacters[i].candidate_id }));
const roleTextInputs = JSON.stringify([roleTextAnalysis, roleTextDraft, roleTextCharacters, roleTextAssets]);
const roleTextPack = compileOriginalStory(roleTextDraft, roleTextAnalysis, preserveBrief, roleTextCharacters, roleTextAssets);
validateCompiledOriginalPack(roleTextPack);
assert.equal(roleTextPack.beats[0].action, 'CHAR_A抬头，随后CHAR_A放下道具。');
assert.ok(roleTextPack.character_bible[0].identity_anchors.includes('CHAR_A keeps the same markings.'));
assert.equal(roleTextPack.character_bible[0].source_role_id, 'ROLE_A');
assert.equal(roleTextPack.character_bible[0].candidate_id, 'ROLE_A_OPTION_1');
assert.equal(roleTextPack.seedance_asset_map.bindings[0].source_role_id, 'ROLE_A');
assert.equal(roleTextPack.seedance_asset_map.bindings[0].reference_prompt, roleTextCharacters[0].reference_image_prompt);
assert.doesNotMatch(roleTextPack.seedance_asset_map.full_run.target_prompt, /\bROLE_[A-Z0-9_]+\b/);
assert.equal(JSON.stringify([roleTextAnalysis, roleTextDraft, roleTextCharacters, roleTextAssets]), roleTextInputs);
const unknownRoleDraft = structuredClone(draft);
unknownRoleDraft.beats[0].action = 'ROLE_UNKNOWN moves.';
assert.throws(() => validateCompiledOriginalPack(compileOriginalStory(unknownRoleDraft, analysis, brief, characters, assets)), /泄漏了源角色/);
const styledCharacters = structuredClone(characters);
styledCharacters.forEach(c => {
  c.design_mode = 'style_variant';
  c.casting_envelope.visual_medium = '水彩插画';
});
const styledPreserved = compileOriginalStory(projected, analysis, preserveBrief, styledCharacters, assets);
assert.deepEqual(styledPreserved.beats, preservedPack.beats);
assert.ok(styledPreserved.seedance_asset_map.runs[0].target_prompt.includes('水彩插画'));
const bodyDriftCharacters = structuredClone(styledCharacters);
bodyDriftCharacters[0].body_plan = 'changed body';
assert.throws(() => compileOriginalStory(projected, analysis, preserveBrief, bodyDriftCharacters, assets), /物种、身体结构/);
assert.equal(preservedPack.remix_policy.effective_mode, 'character_swap');
assert.ok(isTextOnlyPack(preservedPack));                            // 保留线也要走新面板
const legacyPack = JSON.parse(JSON.stringify(preservedPack));
legacyPack.seedance_asset_map.bindings.push({ slot: '@Video 1', kind: 'source_video_reference', instruction: 'x' });
assert.equal(isTextOnlyPack(legacyPack), false);                     // 旧的无声原视频复刻包仍留在老面板

const ghost = JSON.parse(JSON.stringify(result));
ghost.seedance_asset_map.runs[0].target_prompt += '不要克隆参考片录音。';
mustFail('提示词提到看不见的参考片', () => validateCompiledOriginalPack(ghost));
// 角色设计必须要求候选之间和角色之间都一眼可辨，不能再写 minor/restrained。
const designTask = buildCharacterDesignInstruction(analysis, brief);
assert.ok(designTask.includes('distinguishable at a glance'));
assert.ok(designTask.includes('CROSS-ROLE SEPARATION'));
assert.ok(!designTask.includes('minor styling variations'));
assert.ok(!designTask.includes('restrained palette details'));
assert.ok(designTask.includes('never print schema field names'));

// 视频模型能力表：请求体只放这一档真正认的字段，参考图按档位收敛，超限要拦。
for (const model of vm.VIDEO_MODELS) {
  assert.ok(model.maxSeconds > 0 && model.price.unit);
  const body = vm.buildVideoRequest(model, { model: model.id, seconds: 8, resolution: model.defaultResolution, ratio: '9:16', prompt: 'p', referenceImages: ['data:a', 'data:b'] });
  assert.equal(body.model, model.id);
  if (model.resolutions.length === 0) assert.ok(!('resolution' in body));      // 画质写在模型名里的档不该收 resolution
  if (model.ratios.length === 0) assert.ok(!('ratio' in body));
  if (model.fixedSeconds !== undefined) assert.ok(!('seconds' in body));       // 固定时长档传 seconds 会被上游拒
  if (model.maxReferenceImages === 0) assert.ok(!('input_reference' in body) && !('images' in body));
  if (model.referenceStyle === 'omni') assert.ok(Array.isArray(body.images));
  if (model.referenceStyle === 'single') assert.equal(typeof body.input_reference, 'string');
}
// 参数表按官方文档核对（2026-09-09）：合计上限、单价、时长与参考图上限。
const OFFICIAL = {
  'seedance-2.5':              { max: 30, imgs: 30, price: { '480p': 4.59, '720p': 7.65, '1080p': 19.89 }, unit: 'second' },
  'seedance-2.0':              { fixed: 15, imgs: 15, total: 15, price: { flat: 22.5 }, unit: 'clip' },
  'seedance-2.0-fast':         { fixed: 15, imgs: 15, total: 15, price: { flat: 22.5 }, unit: 'clip' },
  'MiniMax-H3':                { max: 15, imgs: 9, price: { '480p': 0.75, '720p': 1.275 }, unit: 'second' },
  'grok-imagine-video':        { max: 15, imgs: 1, price: { '480p': 1.0, '720p': 1.4 }, unit: 'second' },
  'grok-imagine-video-1.5':    { max: 15, imgs: 1, price: { '480p': 1.5, '720p': 2.625, '1080p': 4.6875 }, unit: 'second' },
  'grok-video':                { max: 15, imgs: 0, price: { flat: 0.2 }, unit: 'second' },
  'minimax-h3-quantized-768p': { max: 10, imgs: 1, price: { flat: 0.28 }, unit: 'second' },
  'minimax-h3-original-768p':  { max: 15, imgs: 1, total: 1, price: { flat: 0.7 }, unit: 'second' },
  'minimax-h3-original-1080p': { max: 15, imgs: 1, total: 1, price: { flat: 1.05 }, unit: 'second' },
  'minimax-h3-original-cf-2k': { max: 15, imgs: 1, total: 1, price: { flat: 1.05 }, unit: 'second' },
};
assert.equal(vm.VIDEO_MODELS.length, Object.keys(OFFICIAL).length);
for (const [id, want] of Object.entries(OFFICIAL)) {
  const model = vm.videoModel(id);
  assert.equal(model.id, id, `${id} 没有登记`);
  assert.equal(model.price.unit, want.unit, `${id} 计费单位`);
  for (const [key, value] of Object.entries(want.price)) {
    assert.ok(Math.abs((model.price.credits[key] ?? -1) - value) < 1e-6, `${id} 的 ${key} 单价应为 ${value}，实际 ${model.price.credits[key]}`);
  }
  assert.equal(Object.keys(model.price.credits).length, Object.keys(want.price).length, `${id} 多登记了档位`);
  if (want.fixed) assert.equal(model.fixedSeconds, want.fixed, `${id} 固定时长`);
  else assert.equal(model.maxSeconds, want.max, `${id} 时长上限`);
  assert.equal(model.maxReferenceImages, want.imgs, `${id} 参考图上限`);
  assert.equal(model.maxReferenceTotal, want.total, `${id} 素材合计上限`);
  // 合计上限必须真的生效，不能只写在字段里
  if (want.total !== undefined) {
    const body = vm.buildVideoRequest(model, { model: id, seconds: 8, prompt: 'p', referenceImages: Array.from({ length: 20 }, (_, i) => `data:img${i}`) });
    const images = body.images ?? body.input_reference;
    const count = Array.isArray(images) ? images.length : images ? 1 : 0;
    assert.ok(count <= want.total, `${id} 带了 ${count} 张，超过合计上限 ${want.total}`);
  }
}
// 参考素材接受的地址形式：角色图存在本机、只能以 base64 提交，只收链接的档必须在提交前拦下。
// 依据：文档对 grok 两档与 seedance-2.0 两档明写"或 data URI"；minimax-h3-original-768p 实测报
// "input_reference must contain only http or https URLs"（2026-09-09）。
assert.deepEqual(
  vm.VIDEO_MODELS.filter(m => m.referenceUri === 'documented').map(m => m.id).sort(),
  ['grok-imagine-video', 'grok-imagine-video-1.5', 'seedance-2.0', 'seedance-2.0-fast'],
);
for (const id of ['minimax-h3-original-768p', 'minimax-h3-original-1080p', 'minimax-h3-original-cf-2k', 'minimax-h3-quantized-768p']) {
  assert.equal(vm.videoModel(id).referenceUri, 'url-only', `${id} 应标记为只收链接`);
  const issues = vm.checkVideoPlan(vm.videoModel(id), { seconds: 8, referenceImages: 3 });
  assert.ok(issues.some(i => i.level === 'block' && /只收 http\/https/.test(i.message)), `${id} 带本机角色图时必须拦下`);
}
// 文档没写、也没实测的档只警告不拦，别把可能可用的档堵死
{
  const unknownUri = { ...vm.videoModel('seedance-2.5'), referenceUri: 'unverified' };
  const issues = vm.checkVideoPlan(unknownUri, { seconds: 8, referenceImages: 3 });
  assert.ok(issues.some(i => i.level === 'warn' && /没写是否收 base64/.test(i.message)), '未实测的档应给出提醒');
  assert.ok(!issues.some(i => i.level === 'block'), '未实测不该被拦');
}
// 明写支持、或已被上游报错证实收 data: URI 的档，都不该有这类提醒
for (const id of ['seedance-2.0', 'grok-imagine-video', 'seedance-2.5', 'MiniMax-H3']) {
  const issues = vm.checkVideoPlan(vm.videoModel(id), { seconds: 8, referenceImages: 1 });
  assert.ok(!issues.some(i => /base64|http\/https/.test(i.message)), `${id} 不该提示 data URI 问题`);
}

// 参数表单由能力表推导。规则是"全暴露"：每一档都把同一组参数全列出来，
// 认的可填、不认的灰掉并写明原因——不许因为这一档不支持就整项消失，那样用户根本不知道有这个东西。
const ALL_PARAM_KEYS = ['seconds', 'resolution', 'ratio', 'size', 'generate_audio', 'seed', 'negative_prompt', 'shots', 'output_format'];
for (const model of [...vm.VIDEO_MODELS, vm.videoModel('某个没登记的档')]) {
  const specs = vm.videoParamSpecs(model);
  const keys = specs.map(spec => spec.key);
  assert.equal(new Set(keys).size, keys.length, `${model.id} 的参数项重复`);
  assert.deepEqual([...keys].sort(), [...ALL_PARAM_KEYS].sort(), `${model.id} 少列了参数项`);
  const editable = specs.filter(vm.isParamEditable).map(spec => spec.key);
  // resolution：只有真有档位的才可填
  assert.equal(editable.includes('resolution'), model.resolutions.length > 0, `${model.id} 的 resolution 可填性`);
  // 时长：固定档不可填，其余都必须可填——这是最该让人改的一项，不许写死
  assert.equal(editable.includes('seconds'), model.fixedSeconds === undefined, `${model.id} 的 seconds 可填性`);
  // seed：grok 两档传了会被拒、不认这个字段的档，都必须不可填
  if (model.seed === 'rejected' || model.seed === 'none') assert.ok(!editable.includes('seed'), `${model.id} 的 seed 不该可填`);
  // shots / negative_prompt 只有 2.0 两档能填
  assert.equal(editable.includes('shots'), model.supportsShots, `${model.id} 的 shots 可填性`);
  assert.equal(editable.includes('negative_prompt'), model.supportsNegativePrompt, `${model.id} 的 negative_prompt 可填性`);
  for (const spec of specs) {
    // 每一项都必须标明这条限制的说法从哪来，否则用户没法分辨"试过的"和"照文档抄的"
    assert.ok(['verified', 'documented', 'assumed'].includes(spec.source), `${model.id} 的 ${spec.key} 没标来源`);
    // 每个不可填项都必须说明原因，不能只是灰掉
    if (!vm.isParamEditable(spec)) assert.ok(spec.hint && spec.hint.length > 0, `${model.id} 的 ${spec.key} 不可填但没说原因`);
  }
}
// 没登记的档所有参数都是猜的，一项也不许显示成"据文档"
for (const spec of vm.videoParamSpecs(vm.videoModel('某个没登记的档'))) {
  assert.equal(spec.source, 'assumed', `未登记档的 ${spec.key} 不该标成非 assumed`);
}
// 本机探测出来的结论优先于文档，并且要把上游原话带上当凭据
{
  const probed = vm.videoParamSpecs(vm.videoModel('seedance-2.5'), { seconds: { source: 'verified', note: '上游原话', at: 1 } });
  const spec = probed.find(item => item.key === 'seconds');
  assert.equal(spec.source, 'verified');
  assert.equal(spec.evidence, '上游原话');
}
// 探测判定：报错提到了这个字段才算证实；只提到别的字段（先拦了 prompt）一律不算
assert.equal(vm.probeVerdict('seconds', 'invalid seconds: must be between 4 and 30', 1)?.source, 'verified');
assert.equal(vm.probeVerdict('seconds', 'prompt cannot be empty', 1), undefined);
assert.equal(vm.probeVerdict('generate_audio', 'unknown field generate audio', 1)?.source, 'verified');
// 各家字段名不一样，必须认别名：MiniMax-H3 把 seconds 叫 duration，只按字面找就会漏掉一条真证据。
assert.equal(vm.probeVerdict('seconds', 'duration must be between 4 and 15, or -1 to let the model choose, got 9999', 1)?.source, 'verified');
assert.equal(vm.probeVerdict('ratio', 'aspect_ratio "9999:1" is not supported', 1)?.source, 'verified');
// 但 "prompt is required" 不许被任何一项认领成自己的证据
for (const key of ['seconds', 'resolution', 'ratio', 'size', 'seed', 'negative_prompt', 'shots', 'output_format', 'generate_audio']) {
  assert.equal(vm.probeVerdict(key, 'prompt is required', 1), undefined, `${key} 不该把 prompt 报错当成自己的证据`);
}

// MiniMax-H3 的上游明写 -1 = 让模型自己定时长；这是可配的，必须摆出来，且估价按上限算不能按 0 算
{
  const h3 = vm.videoModel('MiniMax-H3');
  assert.equal(h3.autoSeconds, -1);
  const plan = vm.applySecondsOverride(h3, vm.resolveSeconds(h3, 8), -1, 8);
  assert.equal(plan.seconds, -1);
  assert.equal(plan.billedSeconds, 15, '出多长不知道，必须按上限计费，宁可报高');
  assert.ok(!plan.blocked, '-1 是合法值，不该被拦');
  assert.equal(vm.buildVideoRequest(h3, { model: 'MiniMax-H3', seconds: 8, prompt: 'p', referenceImages: [] }, { seconds: -1 }).seconds, '-1');
  // 没有这个特殊值的档，-1 仍然该被拦
  assert.ok(vm.applySecondsOverride(vm.videoModel('seedance-2.5'), vm.resolveSeconds(vm.videoModel('seedance-2.5'), 8), -1, 8).blocked);
}

// 手填时长覆盖按分镜推导的时长：范围内照发，超范围当场拦，并如实说清这一段被拉长还是被砍短。
{
  const h3 = vm.videoModel('MiniMax-H3');                 // 4–15 秒可调
  assert.equal(vm.applySecondsOverride(h3, vm.resolveSeconds(h3, 8), undefined, 8).seconds, 8);   // 没填就用自动值
  const longer = vm.applySecondsOverride(h3, vm.resolveSeconds(h3, 8), 12, 8);
  assert.equal(longer.seconds, 12);
  assert.equal(longer.padded, 4);                          // 比这一段长 4 秒，拼接时裁掉
  const shorter = vm.applySecondsOverride(h3, vm.resolveSeconds(h3, 8), 5, 8);
  assert.equal(shorter.short, 3);                          // 比这一段短 3 秒，后 3 秒演不出来
  assert.ok(vm.applySecondsOverride(h3, vm.resolveSeconds(h3, 8), 30, 8).blocked);                // 超上限
  assert.ok(vm.applySecondsOverride(h3, vm.resolveSeconds(h3, 8), 2, 8).blocked);                 // 低于下限
  // 离散档只能填它认的那几个值
  const gvm = vm.videoModel('grok-video');
  assert.equal(vm.applySecondsOverride(gvm, vm.resolveSeconds(gvm, 5), 10, 5).seconds, 10);
  assert.ok(vm.applySecondsOverride(gvm, vm.resolveSeconds(gvm, 5), 12, 5).blocked);
  // 固定时长档手填无效，照旧走自动（也就是压根不发 seconds）
  const fixed = vm.videoModel('seedance-2.0');
  assert.equal(vm.applySecondsOverride(fixed, vm.resolveSeconds(fixed, 10), 8, 10).seconds, undefined);
}
// 2026-09-10 实测上游报错纠正过的三处，别再被"照文档抄"改回去：
// seedance 系与 MiniMax-H3 的合法画幅里有 adaptive（原表漏了）；MiniMax-H3 的 1080p 上游校验能过（原表只写了两档）。
for (const id of ['seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'MiniMax-H3']) {
  assert.ok(vm.videoModel(id).ratios.includes('adaptive'), `${id} 的画幅少了 adaptive`);
}
assert.ok(vm.videoModel('MiniMax-H3').resolutions.includes('1080p'), 'MiniMax-H3 支持 1080p');
// 但它没有登记 1080p 单价，估不出价就必须当场说，不能让人看到一个不显示积分的段落自己猜
{
  const warn = vm.checkVideoPlan(vm.videoModel('MiniMax-H3'), { seconds: 8, referenceImages: 0, resolution: '1080p' })
    .find(issue => /价格表/.test(issue.message));
  assert.ok(warn && warn.level === 'warn', 'MiniMax-H3 选 1080p 要提示估不出价');
  assert.equal(vm.checkVideoPlan(vm.videoModel('MiniMax-H3'), { seconds: 8, referenceImages: 0, resolution: '720p' })
    .find(issue => /价格表/.test(issue.message)), undefined, '有价的画质不该报这条');
}

// 参考图的形状是被上游打回来才改对的，别再照火山原生文档改回 [{url,role}]：
// 中转 /v1/videos 用它自己归一化过的形状，原话是 "images must be a string or an array of strings"。
{
  const omni = vm.buildVideoRequest(vm.videoModel('seedance-2.5'),
    { model: 'seedance-2.5', seconds: 5, prompt: 'p', referenceImages: ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB'] });
  assert.deepEqual(omni.images, ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB']);
  assert.ok(omni.images.every(item => typeof item === 'string'), 'images 必须是字符串数组');
  // 单素材档只给一个，顺序档一张时给字符串、多张时给数组
  assert.equal(vm.buildVideoRequest(vm.videoModel('minimax-h3-original-768p'),
    { model: 'x', seconds: 5, prompt: 'p', referenceImages: ['https://a', 'https://b'] }).input_reference, 'https://a');
  assert.equal(vm.buildVideoRequest(vm.videoModel('seedance-2.0'),
    { model: 'x', seconds: 15, prompt: 'p', referenceImages: ['data:a'] }).input_reference, 'data:a');
}
// 实测确认收 data: URI 的档，不该再弹"没实测过、可能只收链接"的警告
for (const id of ['seedance-2.5', 'MiniMax-H3']) {
  const issues = vm.checkVideoPlan(vm.videoModel(id), { seconds: 8, referenceImages: 2 });
  assert.ok(!issues.some(issue => /还没实测|只收链接/.test(issue.message)), `${id} 不该再提示 data URI 未验证`);
}

// 手填的时长要真的发出去，而不是只在界面上好看
assert.equal(vm.buildVideoRequest(vm.videoModel('seedance-2.5'), { model: 'seedance-2.5', seconds: 4, prompt: 'p', referenceImages: [] }, { seconds: 30 }).seconds, '30');
assert.equal(vm.buildVideoRequest(vm.videoModel('seedance-2.5'), { model: 'seedance-2.5', seconds: 4, prompt: 'p', referenceImages: [] }).seconds, '4');
// 固定时长档无论怎么填都不发 seconds
assert.ok(!('seconds' in vm.buildVideoRequest(vm.videoModel('seedance-2.0'), { model: 'seedance-2.0', seconds: 15, prompt: 'p', referenceImages: [] }, { seconds: 9 })));
// 覆盖值只对认这个字段的档生效；多余的键一律丢掉，不能让上游整单拒绝
const gv = vm.buildVideoRequest(vm.videoModel('grok-video'), { model: 'grok-video', seconds: 6, prompt: 'p', referenceImages: [] },
  { seed: 42, ratio: '16:9', generate_audio: true, negative_prompt: 'x', shots: true, output_format: 'mov' });
assert.deepEqual(Object.keys(gv).sort(), ['model', 'prompt', 'seconds']);
// 认的档要如实带上用户填的值
const s20 = vm.buildVideoRequest(vm.videoModel('seedance-2.0'), { model: 'seedance-2.0', seconds: 15, prompt: 'p', referenceImages: ['data:a'], shots: [{ prompt: 'a', duration: 8 }, { prompt: 'b', duration: 7 }] },
  { seed: 42, ratio: '16:9', generate_audio: false, negative_prompt: '模糊', shots: false });
assert.equal(s20.seed, 42);
assert.equal(s20.ratio, '16:9');
assert.equal(s20.generate_audio, false);
assert.equal(s20.negative_prompt, '模糊');
assert.ok(!('shots' in s20));                       // 关掉就不发
assert.ok(!('seconds' in s20));                     // 固定时长档仍然不发 seconds
// ratio 与 size 同时给时以 ratio 为准，不发注定被忽略的 size
const both = vm.buildVideoRequest(vm.videoModel('seedance-2.5'), { model: 'seedance-2.5', seconds: 8, prompt: 'p', referenceImages: [] }, { ratio: '16:9', size: '720x1280' });
assert.equal(both.ratio, '16:9');
assert.ok(!('size' in both));
const onlySize = vm.buildVideoRequest(vm.videoModel('seedance-2.5'), { model: 'seedance-2.5', seconds: 8, prompt: 'p', referenceImages: [] }, { ratio: '', size: '720x1280' });
assert.equal(onlySize.size, '720x1280');

// 声音：各档 generate_audio 默认值不同（seedance-2.0 两档默认关，不传就是哑片），
// 而这条线的提示词明确要求原生出声，所以只要认这个字段就必须显式传 true。
const AUDIO_DEFAULT = {
  'seedance-2.5': 'on', 'seedance-2.0': 'off', 'seedance-2.0-fast': 'off', 'MiniMax-H3': 'upstream',
  'grok-imagine-video': 'on', 'grok-imagine-video-1.5': 'on', 'grok-video': 'none',
  'minimax-h3-quantized-768p': 'none', 'minimax-h3-original-768p': 'none',
  'minimax-h3-original-1080p': 'none', 'minimax-h3-original-cf-2k': 'none',
};
for (const [id, want] of Object.entries(AUDIO_DEFAULT)) {
  const model = vm.videoModel(id);
  assert.equal(model.audioDefault, want, `${id} 的 generate_audio 默认值`);
  const body = vm.buildVideoRequest(model, { model: id, seconds: 8, prompt: 'p', referenceImages: [] });
  if (want === 'none') assert.ok(!('generate_audio' in body), `${id} 不认这个字段就不该发`);
  else assert.equal(body.generate_audio, true, `${id} 必须显式要声音，否则默认关的档会出哑片`);
}
// 想要哑片时也能通过参数覆盖显式关掉
assert.equal(vm.buildVideoRequest(vm.videoModel('seedance-2.0'), { model: 'seedance-2.0', seconds: 15, prompt: 'p', referenceImages: [] }, { generate_audio: false }).generate_audio, false);

// 实测结论要能从报错里认出来：/v1/models 会列出分组里跑不了的模型，试过才知道，结论记本机避免反复踩坑。
assert.deepEqual(vm.probeFromError('中转请求失败：500 分组 video 下模型 MiniMax-H3 的可用渠道不存在 (retry)')?.state, 'no_channel');
assert.deepEqual(vm.probeFromError('400 input_reference must contain only http or https URLs')?.state, 'url_only');
assert.equal(vm.probeFromError('中转请求失败：524 中转返回 HTTP 524'), undefined);      // 超时说明不了模型能力
assert.equal(vm.probeFromError('随便一个别的错'), undefined);                           // 认不出就不乱下结论

// 只有 2.5 支持全能模式；只有 2.0 两档支持 shots 与 negative_prompt
assert.deepEqual(vm.VIDEO_MODELS.filter(m => m.supportsEditExtend).map(m => m.id), ['seedance-2.5']);
assert.deepEqual(vm.VIDEO_MODELS.filter(m => m.supportsShots).map(m => m.id).sort(), ['seedance-2.0', 'seedance-2.0-fast']);
assert.deepEqual(vm.VIDEO_MODELS.filter(m => m.supportsNegativePrompt).map(m => m.id).sort(), ['seedance-2.0', 'seedance-2.0-fast']);
// 画质写在模型名里的四档不认 resolution；ratio 上游不兑现
for (const id of ['minimax-h3-quantized-768p', 'minimax-h3-original-768p', 'minimax-h3-original-1080p', 'minimax-h3-original-cf-2k']) {
  assert.equal(vm.videoModel(id).resolutions.length, 0, `${id} 不该有 resolution 档`);
  assert.equal(vm.videoModel(id).ratioHonored, false, `${id} 的 ratio 上游不兑现`);
}

// grok-video 不收参考图：有角色时必须拦下而不是静默丢弃
assert.ok(vm.checkVideoPlan(vm.videoModel('grok-video'), { seconds: 6, referenceImages: 3 }).some(i => i.level === 'block'));
// 超过该档时长上限要拦：整片 60.2 秒在最长的 2.5（30 秒）上也跑不了
assert.ok(vm.checkVideoPlan(vm.videoModel('seedance-2.5'), { seconds: 60.2, referenceImages: 5 }).some(i => i.level === 'block'));
// 固定 15 秒档：装不下要拦，装得下但更短只提醒仍按整条计费
assert.ok(vm.checkVideoPlan(vm.videoModel('seedance-2.0'), { seconds: 19.5, referenceImages: 5 }).some(i => i.level === 'block'));
assert.ok(vm.checkVideoPlan(vm.videoModel('seedance-2.0'), { seconds: 3.7, referenceImages: 5 }).every(i => i.level !== 'block'));
// API 版提示词必须去掉即梦的 @ 绑定段，换成按序对应说明
const webPrompt = result.seedance_asset_map.runs[0].target_prompt;
const apiPrompt = vm.toApiPrompt(webPrompt, ['CHAR_A'], vm.videoModel('seedance-2.5'));
assert.ok(!webPrompt.includes('素材绑定') && webPrompt.includes('【在此绑定'));
assert.ok(!apiPrompt.includes('素材绑定') && !apiPrompt.includes('【在此绑定'));
assert.ok(apiPrompt.includes('第 1 张 = CHAR_A'));
// 参考图放不下时要在提示词里写明哪些角色没有图，而不是悄悄少给
const narrow = vm.toApiPrompt(webPrompt, ['CHAR_A', 'CHAR_B'], vm.videoModel('grok-imagine-video'));
assert.ok(narrow.includes('CHAR_B') && narrow.includes('没有参考图'));
// shots：只有 2.0 两档收；和必须精确等于固定时长，每段整数且 ≥1 秒
for (const id of ['seedance-2.5', 'MiniMax-H3', 'grok-imagine-video']) {
  const body = vm.buildVideoRequest(vm.videoModel(id), { model: id, seconds: 15, prompt: 'p', referenceImages: [], shots: [{ prompt: 'a', duration: 8 }, { prompt: 'b', duration: 7 }] });
  assert.ok(!('shots' in body));
}
assert.ok('shots' in vm.buildVideoRequest(vm.videoModel('seedance-2.0'), { model: 'seedance-2.0', seconds: 15, prompt: 'p', referenceImages: [], shots: [{ prompt: 'a', duration: 8 }, { prompt: 'b', duration: 7 }] }));
assert.equal(vm.buildShots([{ prompt: 'a', seconds: 9 }], 15), undefined);                       // 单镜不出分镜表
assert.equal(vm.buildShots(Array.from({ length: 16 }, () => ({ prompt: 'a', seconds: 1 })), 15), undefined); // 超 15 段
for (let t = 0; t < 200; t += 1) {
  const count = 2 + (t % 13);
  const plan = vm.buildShots(Array.from({ length: count }, (_, i) => ({ prompt: `p${i}`, seconds: ((t * 7 + i * 3) % 9) + 1 })), 15);
  assert.ok(plan, `第 ${t} 组没生成 shots`);
  assert.equal(plan.shots.reduce((sum, shot) => sum + shot.duration, 0), 15);
  assert.ok(plan.shots.every(shot => Number.isInteger(shot.duration) && shot.duration >= 1));
}
// 段落时长与档位对不齐时的规则：短了往上垫、长了才拦，不能差零点几秒就一律拦死。
const h3 = vm.videoModel('MiniMax-H3');
const shortPlan = vm.resolveSeconds(h3, 3.7);           // 差 0.3 秒到下限
assert.equal(shortPlan.seconds, 4);
assert.ok(Math.abs(shortPlan.padded - 0.3) < 0.001);
assert.ok(!shortPlan.blocked);
assert.ok(vm.resolveSeconds(h3, 19.5).blocked);          // 超上限才拦
assert.equal(vm.resolveSeconds(h3, 10).padded, 0);
assert.equal(vm.resolveSeconds(vm.videoModel('grok-video'), 3.7).seconds, 6);   // 离散档取第一个装得下的
assert.equal(vm.resolveSeconds(vm.videoModel('seedance-2.0'), 10).seconds, undefined); // 固定档不传 seconds
assert.equal(vm.resolveSeconds(vm.videoModel('seedance-2.0'), 10).billedSeconds, 15);  // 但按整条计费
assert.ok(vm.resolveSeconds(vm.videoModel('seedance-2.0'), 19.5).blocked);
// 重新分组只在支持 shots 时才合并镜头：没有 shots 就说不清硬切在哪，合并会糊成一段。
const shotLengths = [['b1', 19.5], ['b2', 10], ['b3', 10], ['b4', 17], ['b5', 3.7]].map(([beatId, seconds]) => ({ beatId, seconds }));
const noMerge = vm.regroupForModel(shotLengths, vm.videoModel('seedance-2.5'));
assert.ok(noMerge.groups.every(group => group.beatIds.length === 1));   // 2.5 没有 shots，一组一镜
assert.equal(noMerge.impossible.length, 0);                            // 30 秒上限装得下最长的 19.5
const h3Group = vm.regroupForModel(shotLengths, h3);
assert.deepEqual(h3Group.impossible.map(item => item.beatId), ['b1', 'b4']);   // 15 秒上限装不下这两镜
const withShots = vm.regroupForModel([{ beatId: 'a', seconds: 6 }, { beatId: 'b', seconds: 7 }], vm.videoModel('seedance-2.0'));
assert.deepEqual(withShots.groups[0].beatIds, ['a', 'b']);             // 有 shots 才允许合并

// 本机 /api/assets 链接上游访问不到，必须先转 data URI
assert.equal(vm.isSubmittableImage('/api/assets/p/a'), false);
assert.ok(vm.isSubmittableImage('https://x/y.png') && vm.isSubmittableImage('data:image/png;base64,AA'));

// 改编页「复制整片提示词」：还没设计角色也能复制，逐镜内容与正式导出的整片提示词逐字一致
{
  const quick = buildDraftFullPrompt(draft, analysis, { ...brief, storyConfirmed: false });
  const full = result.seedance_asset_map.full_run.target_prompt;
  const beatBlocks = text => text.split('\n\n').filter(block => /^\[\d/.test(block));
  assert.equal(beatBlocks(quick).length, draft.beats.length);
  assert.deepEqual(beatBlocks(quick), beatBlocks(full));
  assert.ok(!quick.includes('【在此绑定') && !quick.includes('以角色图为准'));
  assert.ok(quick.includes(`CHAR_A：${analysis.source_roles[0].species}`) && quick.includes(`外观：${analysis.source_roles[0].generalized_appearance}`));
  draft.beats.filter(b => b.dialogue.trim()).forEach(b => assert.ok(quick.includes(b.dialogue)));
  assert.ok(!/原片|参考片|源片/.test(quick));
  const preserved = projectPreservedDraft(analysis);
  assert.throws(() => buildDraftFullPrompt(preserved, analysis, { ...brief, storyMode: 'preserve', sourceRightsScope: 'third_party_reference' }), /自有或已获授权/);
  const preservedPrompt = buildDraftFullPrompt(preserved, analysis, { ...brief, storyMode: 'preserve', sourceRightsScope: 'owned_or_authorized' });
  assert.equal(beatBlocks(preservedPrompt).length, preserved.beats.length);
}

// 整片提示词质量：ROLE_* 统一成 CHAR_*、不出现「对准」自己
{
  const { actionBeatText } = await load('app/lib/original-story.ts');
  const mixed = structuredClone(draft);
  mixed.beats[0].action = `${analysis.source_roles[0].role_id}推门进来`;
  const text = buildDraftFullPrompt(mixed, analysis, { ...brief, storyConfirmed: false });
  assert.ok(!text.includes(analysis.source_roles[0].role_id) && text.includes('CHAR_A推门进来'));
  assert.ok(!actionBeatText({ at_seconds: 0, actor_ids: ['CHAR_A'], action: '洗衣服', toward_ids: ['CHAR_A'] }).includes('对准'));
  assert.ok(actionBeatText({ at_seconds: 0, actor_ids: ['CHAR_A'], action: '挥手', toward_ids: ['CHAR_B'] }).includes('对准 CHAR_B'));
}

// 整片 + 逐镜提示词，中英文：英文来自 analysis.english，改过的镜头报出来
{
  const { buildDraftPrompts } = await load('app/lib/original-story.ts');
  const { normalizeModelDrift } = await load('app/lib/normalize-drift.ts');
  const b = { ...brief, storyMode: 'preserve', sourceRightsScope: 'owned_or_authorized' };
  const long = projectPreservedDraft(analysis);
  const old = buildDraftPrompts(long, analysis, b);
  assert.match(old.englishUnavailable, /重新分析/);
  assert.match(buildDraftPrompts(draft, analysis, { ...brief, storyConfirmed: false }).englishUnavailable, /保留原剧情/);

  const withEnglish = structuredClone(analysis);
  withEnglish.english = {
    medium: 'live action', visual: 'cool green and warm gold', performance: 'tense then loose', sound: 'low drone; door slam',
    roles: analysis.source_roles.map(role => ({ role_id: role.role_id, description: `an adult ${role.role_id}` })),
    beats: analysis.beats.map(beat => ({
      beat_id: beat.beat_id, action: `EN ${beat.beat_id}`, environment: 'indoor entrance', props: ['door'], framing: 'close-up', camera_motion: 'handheld', lighting: 'cold light', sound: 'door',
      action_beats: (beat.action_beats ?? []).map((_, i) => ({ action: `step ${i} by ${beat.role_ids[0]}`, reaction: '', consequence: 'sets direction' })),
    })),
  };
  assert.deepEqual(normalizeModelDrift(structuredClone(withEnglish)).filter(f => f.path === 'english'), []);
  const set = buildDraftPrompts(long, withEnglish, b);
  assert.equal(set.englishUnavailable, '');
  assert.deepEqual(set.englishMissing, []);
  assert.equal(set.beats.length, long.beats.length);
  set.beats.forEach((s, i) => {
    assert.equal(s.beat_id, long.beats[i].beat_id);
    assert.ok(s.zh.includes(`第 ${i + 1}/${set.beats.length} 段`) && s.zh.includes('\n[0–'));
    assert.ok(s.en.includes(`part ${i + 1} of ${set.beats.length}`) && s.en.includes('\n[0–'));
    assert.ok(!/[一-鿿]/.test(s.en.replace(/Dialogue: .*/g, '')), s.en);
  });
  assert.equal(set.full.start, long.beats[0].start_seconds);
  assert.equal(set.full.end, long.beats.at(-1).end_seconds);
  assert.ok(!set.full.zh.includes('段。与前后段'));
  assert.ok(set.full.en.includes('CHAR_A: an adult CHAR_A') && !set.full.en.includes('ROLE_A'));
  assert.ok(set.full.en.includes(`EN ${analysis.beats[0].beat_id}`));

  // 用户改了一镜：英文版这一镜保留中文并报出来，其余镜头照常英文
  const edited = structuredClone(long);
  edited.beats[0].environment = '改成走廊';
  const partial = buildDraftPrompts(edited, withEnglish, b);
  assert.deepEqual(partial.englishMissing, [long.beats[0].beat_id]);
  assert.ok(partial.full.en.includes('改成走廊') && partial.full.en.includes(`EN ${analysis.beats[1].beat_id}`));

  // 英文版和中文对不上（镜头数不同）：丢掉英文、记一条修正，不拒收分析
  const broken = structuredClone(withEnglish);
  broken.english.beats.pop();
  const fixes = normalizeModelDrift(broken);
  assert.ok(!('english' in broken) && fixes.some(f => f.path === 'english'));
}

console.log('Original-story checks passed: new timeline, image-only bindings, editable dialogue, exact preservation of new actions, offscreen cast, time/text splitting, validation, legacy reference warnings.');
