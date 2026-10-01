import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const readJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8'));

const validateTimeline = (beats, expectedDuration) => {
  assert.ok(Array.isArray(beats) && beats.length > 0, 'beats must be non-empty');
  let previousEnd = 0;
  for (const [index, beat] of beats.entries()) {
    assert.equal(typeof beat.start_seconds, 'number', `beat ${index + 1} start must be numeric`);
    assert.equal(typeof beat.end_seconds, 'number', `beat ${index + 1} end must be numeric`);
    assert.ok(beat.end_seconds > beat.start_seconds, `beat ${index + 1} must have positive duration`);
    assert.ok(beat.start_seconds >= previousEnd, `beat ${index + 1} must not overlap`);
    previousEnd = beat.end_seconds;
  }
  assert.ok(Math.abs(previousEnd - expectedDuration) <= 0.01, 'timeline must end at target duration');
};

const analysis = await readJson('fixtures/video-dna.v1.json');
assert.equal(analysis.schema_version, 'video-dna.v1');
assert.ok(analysis.style_dna?.pacing && analysis.style_dna?.cinematography);
assert.ok(Array.isArray(analysis.source_roles));
validateTimeline(analysis.beats, analysis.source.duration_seconds);

const pack = await readJson('fixtures/creative-pack.v1.json');
assert.equal(pack.schema_version, 'creative-pack.v1');
assert.ok(pack.differentiation_log.length >= 4, 'creative pack must change at least four axes');
assert.ok(pack.character_bible.length > 0, 'creative pack must contain characters');
const characterIds = new Set(pack.character_bible.map((character) => character.character_id));
for (const beat of pack.beats) {
  for (const id of beat.character_ids) assert.ok(characterIds.has(id), `unknown character reference: ${id}`);
  assert.ok(beat.video_prompt.trim(), `beat ${beat.beat_id} needs a prompt`);
}
validateTimeline(pack.beats, analysis.source.duration_seconds);
for (const field of ['generic_master', 'target_prompt', 'negative_prompt', 'first_frame_prompt', 'last_frame_prompt']) {
  assert.ok(pack.prompt_bundle[field]?.trim(), `prompt bundle missing ${field}`);
}
assert.equal(pack.qa.timing_valid, true);
assert.equal(pack.qa.variables_applied, true);
assert.equal(pack.qa.originality_pass, true);
assert.equal(pack.qa.source_identity_leakage, false);
assert.equal(pack.qa.source_dialogue_leakage, false);

const loadTypeScriptModule = async (relativePath) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../${relativePath}`, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
};

const validation = await loadTypeScriptModule('app/lib/validation.ts');
const compiler = await loadTypeScriptModule('app/lib/compiler.ts');
const prompts = await loadTypeScriptModule('app/lib/prompts.ts');
const schemas = await loadTypeScriptModule('app/lib/schemas.ts');
try {
  validation.parseVideoDna(JSON.stringify(analysis), analysis.source.duration_seconds);
  validation.parseCreativePack(JSON.stringify(pack), { analysis });
} catch (error) {
  throw new Error(`Runtime contract validation failed: ${error instanceof Error ? error.message : String(error)}`);
}
const legacySpeakerVisibility = structuredClone(analysis);
delete legacySpeakerVisibility.beats[0].dialogue.speaker_on_screen;
assert.equal(validation.parseVideoDna(JSON.stringify(legacySpeakerVisibility)).beats[0].dialogue.speaker_on_screen, true);
const malformedSpeakerVisibility = structuredClone(analysis);
malformedSpeakerVisibility.beats[0].dialogue.speaker_on_screen = null;
assert.throws(() => validation.parseVideoDna(JSON.stringify(malformedSpeakerVisibility)), /speaker_on_screen.*布尔值/);

const silentSpeakerAnalysis = structuredClone(analysis);
silentSpeakerAnalysis.beats[1].dialogue = {
  speaker_role: 'ROLE_A',
  speaker_on_screen: false,
  source_text: '',
  semantic_intent: '无对白',
  delivery: '',
  approx_characters: 0,
};
const projectedSilentBeats = compiler.projectCharacterSwapBeats(silentSpeakerAnalysis, [
  { source_role_id: 'ROLE_A', character_id: 'CHAR_A' },
]);
assert.deepEqual(projectedSilentBeats[1].dialogue_speaker_ids, []);
assert.equal(projectedSilentBeats[1].dialogue, '');

const offscreenAnalysis = structuredClone(analysis);
offscreenAnalysis.source_roles.push({
  ...structuredClone(offscreenAnalysis.source_roles[0]),
  role_id: 'ROLE_B',
  narrative_function: '画外对话者',
});
offscreenAnalysis.beats[1].dialogue = {
  speaker_role: 'ROLE_B',
  speaker_on_screen: false,
  source_text: 'I answer from off screen.',
  semantic_intent: '从画外回应画面内角色',
  delivery: '画外音，平静',
  approx_characters: 4,
};
const parsedOffscreenAnalysis = validation.parseVideoDna(JSON.stringify(offscreenAnalysis));
assert.deepEqual(parsedOffscreenAnalysis.beats[1].role_ids, ['ROLE_A']);
const missingOnscreenRole = structuredClone(offscreenAnalysis);
missingOnscreenRole.beats[1].dialogue.speaker_on_screen = true;
assert.throws(() => validation.parseVideoDna(JSON.stringify(missingOnscreenRole)), /画面内说话.*role_ids 漏标/);
const unknownOffscreenRole = structuredClone(offscreenAnalysis);
unknownOffscreenRole.beats[1].dialogue.speaker_role = 'ROLE_MISSING';
assert.throws(() => validation.parseVideoDna(JSON.stringify(unknownOffscreenRole)), /不存在的角色/);
const projectedOffscreenBeats = compiler.projectCharacterSwapBeats(parsedOffscreenAnalysis, [
  { source_role_id: 'ROLE_A', character_id: 'CHAR_A' },
  { source_role_id: 'ROLE_B', character_id: 'CHAR_B' },
]);
assert.deepEqual(projectedOffscreenBeats[1].character_ids, ['CHAR_A']);
assert.deepEqual(projectedOffscreenBeats[1].dialogue_speaker_ids, ['CHAR_B']);

const offscreenCreativePack = structuredClone(pack);
offscreenCreativePack.character_bible.push({
  ...structuredClone(offscreenCreativePack.character_bible[0]),
  character_id: 'CHAR_B',
});
offscreenCreativePack.beats[1].dialogue = 'CHAR_B：画外台词';
offscreenCreativePack.beats[1].dialogue_speaker_ids = ['CHAR_B'];
offscreenCreativePack.beats[1].video_prompt += ' CHAR_B：画外台词';
validation.parseCreativePack(JSON.stringify(offscreenCreativePack), { remixMode: 'full_original' });
const testSelectedCharacter = {
  ...structuredClone(pack.character_bible[0]),
  source_role_id: analysis.source_roles[0].role_id,
  candidate_id: 'ROLE_A_OPTION_1',
  design_name: '测试角色',
  design_rationale: '契约测试使用。',
  reference_image_prompt: 'x',
};
const testSelectedCharacters = [testSelectedCharacter];
const testReferenceAssets = [{ asset_id: 'asset-1', character_id: 'CHAR_A', candidate_id: 'ROLE_A_OPTION_1', uri: '/api/assets/p/a', mime_type: 'image/png', approved: true, prompt: 'x' }];
const draft = {
  schema_version: 'creative-draft.v1',
  title: pack.title,
  concept_summary: pack.concept_summary,
  differentiation_log: [...pack.differentiation_log],
  style_lock: structuredClone(pack.style_lock),
  beats: pack.beats.map((beat) => Object.fromEntries(Object.entries(beat).filter(([key]) => key !== 'video_prompt'))),
  qa: structuredClone(pack.qa),
};
validation.parseCreativeDraft(JSON.stringify(draft), { analysis, remixMode: 'full_original', selectedCharacters: testSelectedCharacters });
const sourceRoleDraft = structuredClone(draft);
sourceRoleDraft.beats[0].dialogue = 'ROLE_A：请等一下';
const normalizedSourceRoleDraft = validation.parseCreativeDraft(JSON.stringify(sourceRoleDraft), { analysis, remixMode: 'full_original', selectedCharacters: testSelectedCharacters });
assert.equal(normalizedSourceRoleDraft.beats[0].dialogue, 'CHAR_A：请等一下');
const sourceRoleCandidate = structuredClone(testSelectedCharacter);
sourceRoleCandidate.reference_prompts.turnaround_sheet = 'ROLE_A 的全身转面图';
validation.parseCreativeDraft(JSON.stringify(draft), { analysis, remixMode: 'full_original', selectedCharacters: [sourceRoleCandidate] });
const unknownSourceRoleDraft = structuredClone(draft);
unknownSourceRoleDraft.beats[0].dialogue = 'ROLE_UNKNOWN：请等一下';
assert.throws(
  () => validation.parseCreativeDraft(JSON.stringify(unknownSourceRoleDraft), { analysis, remixMode: 'full_original', selectedCharacters: testSelectedCharacters }),
  /泄漏了源角色引用：ROLE_UNKNOWN/,
);
// ---- 分析层的人工修正 ----
// 可修正 ≠ 可伪造：能改「这一镜发生了什么」，不能改时间轴、镜头数、边界、置信度那些取证事实。
// 客户端校验不算数，服务端要拿已存的那份逐项比对，所以这套断言盯的是服务端那道闸。
const editBase = validation.parseVideoDna(JSON.stringify(analysis));
const goodEdit = structuredClone(editBase);
goodEdit.beats[0].visual_action = '人工改写的整镜概括。';
goodEdit.beats[0].corrected_by_user = true;
goodEdit.beats[0].action_beats = [
  { at_seconds: 0, actor_ids: ['ROLE_A'], action: '人工补的一拍', toward_ids: ['ROLE_A'], consequence: '说明因果' },
];
assert.doesNotThrow(() => validation.assertEditableAnalysisPatch(goodEdit, editBase), '改动作与在场角色应当被放行');
assert.equal(validation.assertEditableAnalysisPatch(goodEdit, editBase).beats[0].corrected_by_user, true);
for (const [label, mutate, pattern] of [
  ['改镜头边界', (a) => { a.beats[0].end_seconds += 1; }, /时间边界属于取证事实/],
  ['改源片时长', (a) => { a.source.duration_seconds += 1; }, /源片时长属于取证事实/],
  ['删镜头', (a) => { a.beats.pop(); }, /镜头数量属于取证事实/],
  ['改编号', (a) => { a.beats[0].beat_id = 'FAKE'; }, /编号不能修改/],
  ['改置信度', (a) => { a.beats[0].confidence = 1; }, /置信度是模型给的/],
  ['拍点越界', (a) => { a.beats[0].action_beats = [{ at_seconds: 99, actor_ids: ['ROLE_A'], action: 'x' }]; }, /不在本镜/],
  ['引用不存在的角色', (a) => { a.beats[0].action_beats = [{ at_seconds: 0, actor_ids: ['ROLE_ZZZ'], action: 'x' }]; }, /不存在的角色/],
]) {
  const broken = structuredClone(editBase);
  mutate(broken);
  assert.throws(() => validation.assertEditableAnalysisPatch(broken, editBase), pattern, `${label} 应当被服务端拦下`);
}

// 分析指令必须自带 schema：中转把视频请求转成 OpenAI 兼容调用（billing_usage.source=oai_chat），
// responseSchema / responseJsonSchema 都会被丢掉，模型只能照提示词正文里的字段名写。
// 2026-09-09 实测：不写进正文时返回的是 format_type/hook/roles 这种自创结构，到解析层才报「不是 video-dna.v1」。
const analysisTask = prompts.buildAnalysisInstruction({ model: 'gemini-3.7-flash', fps: 2, mediaResolution: 'high', transcribeDialogue: true }, { durationSeconds: 60.2 });
assert.ok(analysisTask.includes('"video-dna.v1"'), '分析指令必须点名 schema_version 的字面值');
assert.ok(analysisTask.includes('action_beats'), '分析指令必须带上 action_beats 字段定义');
assert.ok(analysisTask.includes('style_dna') && analysisTask.includes('source_roles'), '分析指令必须带上完整字段结构');
assert.ok(!analysisTask.includes('additionalProperties'), '写进提示词的 schema 也要过一遍 OpenAPI 子集转换');

// 结构化输出必须走 responseSchema（OpenAPI 子集）：中转只转发这一个字段，responseJsonSchema 会被整个丢掉，
// 丢掉后模型就自由发挥、返回自己编的格式，一直到解析层才报「不是 video-dna.v1 数据」。
const dnaResponseSchema = schemas.toResponseSchema(schemas.VIDEO_DNA_SCHEMA);
const walk = (node, seen = []) => {
  if (Array.isArray(node)) return node.forEach(item => walk(item, seen));
  if (!node || typeof node !== 'object') return;
  assert.ok(!('additionalProperties' in node), 'responseSchema 里不能残留 additionalProperties');
  for (const [key, value] of Object.entries(node)) walk(value, [...seen, key]);
};
walk(dnaResponseSchema);
assert.ok(dnaResponseSchema.required.includes('schema_version'));                                  // 转换不能把 required 吃掉
assert.deepEqual(dnaResponseSchema.properties.beats.items.properties.action_beats.items.required, ['at_seconds', 'actor_ids', 'action']);
assert.ok(dnaResponseSchema.properties.beats.items.properties.additionalProperties === undefined); // properties 下是字段名，别被白名单误删
assert.ok('description' in dnaResponseSchema.properties.beats.items.properties.action_beats);      // 描述要留着，模型靠它写内容
for (const [name, schema] of Object.entries(schemas)) {
  if (typeof schema !== 'object' || !schema?.type) continue;
  assert.doesNotThrow(() => walk(schemas.toResponseSchema(schema)), `${name} 转换后仍有不被支持的关键字`);
}
assert.ok(!('character_bible' in schemas.CREATIVE_DRAFT_SCHEMA.properties));
assert.ok(!('prompt_bundle' in schemas.CREATIVE_DRAFT_SCHEMA.properties));
assert.ok(!('video_prompt' in schemas.CREATIVE_DRAFT_SCHEMA.properties.beats.items.properties));
assert.ok(schemas.COMPILED_CREATIVE_PACK_SCHEMA.required.includes('remix_policy'));
assert.ok(schemas.COMPILED_CREATIVE_PACK_SCHEMA.required.includes('seedance_asset_map'));
const castingFields = ['apparent_age_band', 'gender_expression', 'regional_visual_context', 'build_silhouette', 'hair_grooming', 'wardrobe_function', 'visual_medium'];
const sourceRoleSchema = schemas.VIDEO_DNA_SCHEMA.properties.source_roles.items;
const compiledCharacterSchema = schemas.COMPILED_CREATIVE_PACK_SCHEMA.properties.character_bible.items;
const proposalCandidateSchema = schemas.CHARACTER_PROPOSALS_SCHEMA.properties.role_sets.items.properties.candidates.items;
for (const schema of [sourceRoleSchema, compiledCharacterSchema, proposalCandidateSchema]) {
  assert.ok(schema.required.includes('casting_envelope'));
  for (const field of castingFields) assert.ok(schema.properties.casting_envelope.required.includes(field));
}
const compiledPack = compiler.compileCreativePrompts(pack, {
  mode: 'full_original',
  sourceRightsScope: 'third_party_reference',
  newConcept: pack.concept_summary,
  characterBrief: '',
  dialogueBrief: '',
  voiceBrief: '',
  settingBrief: '',
  targetModel: 'Seedance',
  aspectRatio: '9:16',
  outputLanguage: '中文',
  locks: { pacing: true, camera: true, lighting: true, performance: true, sound: true, narrative: true },
  analysis,
  selectedCharacters: testSelectedCharacters,
  referenceAssets: testReferenceAssets,
});
validation.validateCompiledCreativePack(compiledPack, analysis, false, testSelectedCharacters);
assert.equal(compiledPack.seedance_asset_map.bindings[0].slot, '@Image 1');
assert.equal(compiledPack.seedance_asset_map.bindings[0].source_role_id, analysis.source_roles[0].role_id);
assert.equal(compiledPack.seedance_asset_map.bindings[0].candidate_id, testSelectedCharacter.candidate_id);
assert.equal(compiledPack.seedance_asset_map.bindings[0].reference_prompt, testSelectedCharacter.reference_image_prompt);
assert.equal(compiledPack.seedance_asset_map.bindings[0].approved, true);
assert.ok(compiledPack.prompt_bundle.target_prompt.includes('无声参考视频'));
assert.doesNotMatch(compiledPack.prompt_bundle.target_prompt, /@(?:Image|Video)\b/i);
assert.ok(compiledPack.prompt_bundle.target_prompt.includes('VISUAL-ONLY'));
assert.equal(compiledPack.remix_policy.effective_mode, 'full_original');
assert.equal(compiledPack.seedance_asset_map.runs.length, 1);
assert.ok(compiledPack.seedance_asset_map.runs[0].duration_seconds <= 30);
const longAnalysis = structuredClone(analysis);
longAnalysis.source.duration_seconds = 31.3;
longAnalysis.beats.at(-1).end_seconds = 31.3;
const longSourcePack = structuredClone(pack);
longSourcePack.beats.at(-1).end_seconds = 31.3;
const longCompiledPack = compiler.compileCreativePrompts(longSourcePack, {
  mode: 'full_original',
  sourceRightsScope: 'third_party_reference',
  newConcept: longSourcePack.concept_summary,
  characterBrief: '',
  dialogueBrief: '',
  voiceBrief: '',
  settingBrief: '',
  targetModel: 'Seedance',
  aspectRatio: '9:16',
  outputLanguage: '中文',
  locks: { pacing: true, camera: true, lighting: true, performance: true, sound: true, narrative: true },
  analysis: longAnalysis,
  selectedCharacters: testSelectedCharacters,
  referenceAssets: testReferenceAssets,
});
validation.validateCompiledCreativePack(longCompiledPack, longAnalysis, false, testSelectedCharacters);
assert.equal(longCompiledPack.seedance_asset_map.runs.length, 2);
assert.equal(longCompiledPack.seedance_asset_map.runs[0].source_start_seconds, 0);
assert.equal(longCompiledPack.seedance_asset_map.runs.at(-1).source_end_seconds, 31.3);
assert.ok(longCompiledPack.seedance_asset_map.runs.every((run) => run.duration_seconds <= 30));
assert.ok(longCompiledPack.prompt_bundle.target_prompt.includes('SEEDANCE MULTI-RUN PLAN'));
for (const beat of longSourcePack.beats) {
  assert.equal(longCompiledPack.seedance_asset_map.runs.filter((run) => run.beat_ids.includes(beat.beat_id)).length, 1);
}
assert.equal(longCompiledPack.seedance_asset_map.runs.filter((run) => run.target_prompt.includes('新台词')).length, 1);
const singleLongBeatPack = structuredClone(pack);
singleLongBeatPack.beats = [{
  ...structuredClone(singleLongBeatPack.beats[0]),
  beat_id: 'SHOT_LONG',
  start_seconds: 0,
  end_seconds: 31.3,
  dialogue: 'CHAR_A：这句对白只能表演一次，不能在下一段重新开始。',
}];
assert.throws(
  () => compiler.compileCreativePrompts(singleLongBeatPack, {
    mode: 'full_original',
    sourceRightsScope: 'third_party_reference',
    newConcept: singleLongBeatPack.concept_summary,
      characterBrief: '',
      dialogueBrief: '',
      voiceBrief: '',
      settingBrief: '',
    targetModel: 'Seedance',
    aspectRatio: '9:16',
    outputLanguage: '中文',
    locks: { pacing: true, camera: true, lighting: true, performance: true, sound: true, narrative: true },
    analysis: longAnalysis,
    selectedCharacters: testSelectedCharacters,
    referenceAssets: testReferenceAssets,
  }),
  /避免跨段重复动作或对白/,
);
const splitInsideBeat = structuredClone(longCompiledPack);
splitInsideBeat.seedance_asset_map.runs[0].source_end_seconds = 1.3;
splitInsideBeat.seedance_asset_map.runs[0].duration_seconds = 1.3;
splitInsideBeat.seedance_asset_map.runs[1].source_start_seconds = 1.3;
splitInsideBeat.seedance_asset_map.runs[1].duration_seconds = 30;
assert.throws(
  () => validation.validateCompiledCreativePack(splitInsideBeat, longAnalysis, false, testSelectedCharacters),
  /在镜头 B01 中途分段/,
);
const oversizedRun = structuredClone(longCompiledPack);
oversizedRun.seedance_asset_map.runs[0].duration_seconds = 30.1;
assert.throws(
  () => validation.validateCompiledCreativePack(oversizedRun, longAnalysis, false, testSelectedCharacters),
  /duration_seconds 与源区间不一致|超过 30 秒单次上限/,
);
const missingAssetBinding = structuredClone(compiledPack);
delete missingAssetBinding.seedance_asset_map.bindings[0].asset_id;
assert.throws(
  () => validation.validateCompiledCreativePack(missingAssetBinding, analysis),
  /asset_id必须是非空字符串|缺少已确认参考图 asset_id/,
);
const wrongCandidateBinding = structuredClone(compiledPack);
wrongCandidateBinding.seedance_asset_map.bindings[0].candidate_id = 'ROLE_A_OPTION_2';
assert.throws(
  () => validation.validateCompiledCreativePack(wrongCandidateBinding, analysis, false, testSelectedCharacters),
  /与已选角色方案不一致/,
);
assert.throws(
  () => compiler.compileCreativePrompts(pack, {
    mode: 'full_original',
    sourceRightsScope: 'third_party_reference',
    newConcept: pack.concept_summary,
    characterBrief: '',
    dialogueBrief: '',
    voiceBrief: '',
    settingBrief: '',
    targetModel: 'Seedance',
    aspectRatio: '9:16',
    outputLanguage: '中文',
    locks: { pacing: true, camera: true, lighting: true, performance: true, sound: true, narrative: true },
    analysis,
    selectedCharacters: testSelectedCharacters,
    referenceAssets: [{ ...testReferenceAssets[0], candidate_id: 'ROLE_A_OPTION_2' }],
  }),
  /匹配提示词的已确认参考图/,
);
const selectiveLocksPack = compiler.compileCreativePrompts(pack, {
  mode: 'light_remix',
  sourceRightsScope: 'third_party_reference',
  newConcept: pack.concept_summary,
  characterBrief: '',
  dialogueBrief: '',
  voiceBrief: '',
  settingBrief: '',
  targetModel: 'Seedance',
  aspectRatio: '9:16',
  outputLanguage: '中文',
  locks: { pacing: true, camera: false, lighting: false, performance: true, sound: false, narrative: false },
  analysis,
  selectedCharacters: testSelectedCharacters,
  referenceAssets: testReferenceAssets,
});
assert.equal(selectiveLocksPack.seedance_asset_map.bindings.filter((binding) => binding.kind === 'source_video_reference').length, 1);
assert.ok(selectiveLocksPack.prompt_bundle.target_prompt.includes('无声参考视频'));
assert.doesNotMatch(selectiveLocksPack.prompt_bundle.target_prompt, /@Video/i);
const duplicateDifferentiationAxis = structuredClone(pack);
duplicateDifferentiationAxis.differentiation_log = ['身份轴：A', '身份轴：B', '对白轴：C', '场景轴：D'];
assert.throws(
  () => validation.parseCreativePack(JSON.stringify(duplicateDifferentiationAxis), { analysis, remixMode: 'full_original' }),
  /重复轴/,
);
const baseBrief = {
  mode: 'character_swap',
  sourceRightsScope: 'owned_or_authorized',
  newConcept: '',
  characterBrief: '',
  dialogueBrief: '',
  voiceBrief: '年轻、自然、略带俏皮的全新中文声线，不模仿原片。',
  settingBrief: '',
  targetModel: 'Seedance',
  aspectRatio: '9:16',
  outputLanguage: '中文',
  locks: { pacing: true, camera: true, lighting: true, performance: true, sound: true, narrative: true },
};
assert.throws(
  () => compiler.compileCreativePrompts(pack, { ...baseBrief, sourceRightsScope: 'unselected', analysis, selectedCharacters: testSelectedCharacters, referenceAssets: testReferenceAssets }),
  /明确选择参考素材范围/,
);
const characterSwapSource = structuredClone(pack);
const characterSwapAnalysis = structuredClone(analysis);
characterSwapAnalysis.beats[0].dialogue.source_text = "Don't touch it. Keep your hands exactly where they are, and do not change another word of this sentence.";
characterSwapSource.differentiation_log = ['身份轴：只替换角色身份', '对白轴：等义本地化为中文'];
characterSwapSource.beats[0].action = '模型错误改写的动作';
characterSwapSource.beats[0].environment = '模型错误改写的场景';
characterSwapSource.beats[0].dialogue = 'CHAR_A：模型错误改写的对白';
const characterSwapPack = compiler.compileCreativePrompts(characterSwapSource, { ...baseBrief, analysis: characterSwapAnalysis, selectedCharacters: testSelectedCharacters, referenceAssets: testReferenceAssets });
validation.validateCompiledCreativePack(characterSwapPack, characterSwapAnalysis, false, testSelectedCharacters);
assert.equal(characterSwapPack.remix_policy.effective_mode, 'character_swap');
assert.match(characterSwapPack.prompt_bundle.target_prompt, /VISUAL-ONLY reference/i);
assert.doesNotMatch(characterSwapPack.prompt_bundle.target_prompt, /@Video/i);
assert.ok(characterSwapPack.prompt_bundle.target_prompt.includes('无声参考视频'));
assert.ok(characterSwapPack.prompt_bundle.target_prompt.includes('Generate the final synchronized audio natively'));
// 配音语言必须跟着 outputLanguage 走，不能再硬写 ENGLISH：选了中文却让模型说英文就是静默降级。
assert.ok(characterSwapPack.prompt_bundle.target_prompt.includes('1. VOICES (中文)'));
assert.doesNotMatch(characterSwapPack.prompt_bundle.target_prompt, /ENGLISH VOICES/);
assert.ok(characterSwapPack.prompt_bundle.target_prompt.includes('2. ORIGINAL INSTRUMENTAL MUSIC'));
assert.ok(characterSwapPack.prompt_bundle.target_prompt.includes('3. ORIGINAL AMBIENCE & SFX'));
assert.ok(characterSwapPack.prompt_bundle.target_prompt.includes(baseBrief.voiceBrief));
assert.ok(characterSwapPack.prompt_bundle.negative_prompt.includes('English dialogue wording drift'));
assert.equal(characterSwapPack.beats[0].action, characterSwapAnalysis.beats[0].visual_action);
assert.equal(characterSwapPack.beats[0].environment, characterSwapAnalysis.beats[0].environment);
assert.ok(!characterSwapPack.beats[0].dialogue.includes('模型错误改写的对白'));
assert.ok(characterSwapPack.beats[0].dialogue.includes(characterSwapAnalysis.beats[0].dialogue.source_text));
assert.ok(characterSwapPack.seedance_asset_map.runs[0].target_prompt.includes(characterSwapAnalysis.beats[0].dialogue.source_text));
assert.ok(characterSwapPack.prompt_bundle.target_prompt.includes(characterSwapPack.beats[0].sound));

// 无对白的片子（故事页「翻译」选「无」）：提示词必须明确禁止配音，也不再声明对白语言。
// 只是不写台词不够——Seedance 会自己补一段人声，用户选的「无」就等于没生效。
const silentAnalysis = structuredClone(characterSwapAnalysis);
// 真正没有对白的源片：既没有台词原文，也没有说话人。只清台词会被
// applyLocalizedDialogue 判「有说话人却缺原对白」，那是另一条正确的闸。
for (const beat of silentAnalysis.beats) { beat.dialogue.source_text = ''; beat.dialogue.speaker_role = ''; beat.dialogue.approx_characters = 0; }
const silentSource = structuredClone(characterSwapSource);
for (const beat of silentSource.beats) beat.dialogue = '';
const silentPack = compiler.compileCreativePrompts(silentSource, { ...baseBrief, analysis: silentAnalysis, selectedCharacters: testSelectedCharacters, referenceAssets: testReferenceAssets });
for (const prompt of [silentPack.prompt_bundle.target_prompt, silentPack.seedance_asset_map.runs[0].target_prompt]) {
  assert.ok(prompt.includes('1. NO SPEECH'), '无对白时必须出现 NO SPEECH 指令');
  assert.doesNotMatch(prompt, /1\. VOICES/);
  assert.doesNotMatch(prompt, /Language: 中文|language 中文/);
  assert.ok(prompt.includes('无对白：不得生成任何人声'), '单镜提示词必须逐镜禁止人声');
  assert.doesNotMatch(prompt, /Speak only the supplied|speak the written/);
}
// 标题、梗概、差异轴都会进 [PROJECT] 行，不能再自称「英文原对白」。
assert.equal(silentPack.remix_policy.effective_mode, 'character_swap');
assert.ok(silentPack.differentiation_log.some((entry) => entry.includes('没有对白')));
assert.doesNotMatch(silentPack.prompt_bundle.target_prompt, /英文原对白/);
assert.doesNotMatch(characterSwapPack.prompt_bundle.target_prompt, /英文原对白/);
validation.validateCompiledCreativePack(silentPack, silentAnalysis, false, testSelectedCharacters);
assert.deepEqual(
  characterSwapPack.seedance_asset_map.bindings.map((binding) => [binding.slot, binding.kind]),
  [
    ['@Image 1', 'character_reference'],
    ['@Video 1', 'source_video_reference'],
  ],
);
assert.doesNotMatch(JSON.stringify(characterSwapPack), /@Audio\b/);
for (const run of characterSwapPack.seedance_asset_map.runs) {
  assert.match(run.target_prompt, /无声参考视频/i);
  assert.match(run.target_prompt, /Generate the final synchronized audio natively/i);
  assert.doesNotMatch(run.target_prompt, /@Audio\b/);
  assert.doesNotMatch(run.target_prompt, /@(?:Image|Video)\b/i);
}
const sourceRoleAnalysis = structuredClone(characterSwapAnalysis);
sourceRoleAnalysis.beats[0].visual_action = 'ROLE_A 抬手示意停下';
sourceRoleAnalysis.style_dna.performance.gesture_language = 'ROLE_A 使用克制的小幅手势';
const sourceRoleCompileCharacter = structuredClone(testSelectedCharacter);
sourceRoleCompileCharacter.appearance = 'ROLE_A 对应的新角色外形';
const normalizedCharacterSwapPack = compiler.compileCreativePrompts(characterSwapSource, {
  ...baseBrief,
  analysis: sourceRoleAnalysis,
  selectedCharacters: [sourceRoleCompileCharacter],
  referenceAssets: testReferenceAssets,
});
validation.validateCompiledCreativePack(normalizedCharacterSwapPack, sourceRoleAnalysis, false, [sourceRoleCompileCharacter]);
assert.equal(normalizedCharacterSwapPack.beats[0].action, 'CHAR_A 抬手示意停下');
assert.equal(normalizedCharacterSwapPack.character_bible[0].appearance, 'CHAR_A 对应的新角色外形');
assert.ok(!/\bROLE_A\b/.test(normalizedCharacterSwapPack.prompt_bundle.target_prompt));
assert.equal(normalizedCharacterSwapPack.seedance_asset_map.bindings[0].source_role_id, 'ROLE_A');
assert.equal(normalizedCharacterSwapPack.seedance_asset_map.bindings[0].candidate_id, 'ROLE_A_OPTION_1');
const unexpectedDialogueAudio = structuredClone(characterSwapPack);
unexpectedDialogueAudio.seedance_asset_map.bindings.push({
  slot: '@Audio 1',
  kind: 'dialogue_audio_reference',
  instruction: 'Legacy dialogue stem.',
});
assert.throws(
  () => validation.validateCompiledCreativePack(unexpectedDialogueAudio, characterSwapAnalysis, false, testSelectedCharacters),
  /必须包含每个角色的一张参考图和一份无声原视频/,
);
const audibleSourceVideo = structuredClone(characterSwapPack);
audibleSourceVideo.seedance_asset_map.bindings.push({ slot: '@Video 2', kind: 'source_video_reference', instruction: 'Use another source video with its original sound.' });
assert.throws(
  () => validation.validateCompiledCreativePack(audibleSourceVideo, characterSwapAnalysis, false, testSelectedCharacters),
  /必须包含每个角色的一张参考图和一份无声原视频|必须且只能绑定一份无声原视频/,
);
const sourceAudioDependency = structuredClone(characterSwapPack);
sourceAudioDependency.seedance_asset_map.runs[0].target_prompt += '\nUse @Video 1 audio as a timing and voice reference.';
assert.throws(
  () => validation.validateCompiledCreativePack(sourceAudioDependency, characterSwapAnalysis, false, testSelectedCharacters),
  /不得残留|不得把原视频音轨作为生成依赖/,
);
const offscreenCharacter = {
  ...structuredClone(testSelectedCharacter),
  source_role_id: 'ROLE_B',
  character_id: 'CHAR_B',
  candidate_id: 'ROLE_B_OPTION_1',
  design_name: '画外对话者',
  reference_image_prompt: 'y',
};
const offscreenReferenceAsset = {
  ...structuredClone(testReferenceAssets[0]),
  asset_id: 'asset-2',
  character_id: 'CHAR_B',
  candidate_id: 'ROLE_B_OPTION_1',
  prompt: 'y',
};
const offscreenCharacterSwapSource = structuredClone(characterSwapSource);
offscreenCharacterSwapSource.beats[1].dialogue = 'CHAR_B：我在画外回应你';
const compiledOffscreenPack = compiler.compileCreativePrompts(offscreenCharacterSwapSource, {
  ...baseBrief,
  analysis: parsedOffscreenAnalysis,
  selectedCharacters: [testSelectedCharacter, offscreenCharacter],
  referenceAssets: [...testReferenceAssets, offscreenReferenceAsset],
});
validation.validateCompiledCreativePack(compiledOffscreenPack, parsedOffscreenAnalysis, false, [testSelectedCharacter, offscreenCharacter]);
assert.deepEqual(compiledOffscreenPack.beats[1].character_ids, ['CHAR_A']);
assert.deepEqual(compiledOffscreenPack.beats[1].dialogue_speaker_ids, ['CHAR_B']);
assert.ok(compiledOffscreenPack.beats[1].dialogue.includes('I answer from off screen.'));
assert.ok(compiledOffscreenPack.beats[1].video_prompt.includes('画外音=CHAR_B'));
assert.ok(compiledOffscreenPack.beats[1].video_prompt.includes('不得出镜'));
assert.throws(() => compiler.compileCreativePrompts(characterSwapSource, { ...baseBrief, analysis, selectedCharacters: testSelectedCharacters }), /匹配提示词的已确认参考图/);
const changedCharacterSwap = structuredClone(characterSwapPack);
changedCharacterSwap.beats[0].action = '再次篡改动作';
assert.throws(
  () => validation.validateCompiledCreativePack(changedCharacterSwap, characterSwapAnalysis, false, testSelectedCharacters),
  /未保持源 analysis/,
);
const invalidCharacterSwapAxes = structuredClone(characterSwapPack);
invalidCharacterSwapAxes.differentiation_log.push('视觉轴：额外改变画面风格');
assert.throws(
  () => validation.validateCompiledCreativePack(invalidCharacterSwapAxes, characterSwapAnalysis, false, testSelectedCharacters),
  /身份轴与对白保留轴/,
);

const insufficientLightRemix = structuredClone(pack);
insufficientLightRemix.differentiation_log = ['身份轴', '对白轴'];
assert.throws(
  () => validation.parseCreativePack(JSON.stringify(insufficientLightRemix), { analysis, remixMode: 'light_remix' }),
  /至少需要 3 个不同差异轴/,
);

const proposalCasting = analysis.source_roles[0].casting_envelope;
const proposalTemplate = {
  ...pack.character_bible[0],
  source_role_id: analysis.source_roles[0].role_id,
  character_id: 'CHAR_A',
  role_function: analysis.source_roles[0].narrative_function,
  design_name: '原创角色方向',
  design_rationale: '与剧情功能相匹配，同时避开源人物身份。',
  appearance: [
    proposalCasting.apparent_age_band,
    proposalCasting.gender_expression,
    proposalCasting.regional_visual_context,
    proposalCasting.build_silhouette,
    proposalCasting.hair_grooming,
    proposalCasting.visual_medium,
  ].join('；'),
  wardrobe: proposalCasting.wardrobe_function,
  continuity_lock: [...pack.character_bible[0].continuity_lock, '配色不变'],
  reference_image_prompt: `原创成年角色身份参考图，锁定选角范围：${Object.values(proposalCasting).join('；')}。3:4，干净背景，无文字、Logo 或水印。`,
};
const characterProposals = {
  schema_version: 'character-proposals.v1',
  role_sets: [{
    source_role_id: analysis.source_roles[0].role_id,
    role_function: analysis.source_roles[0].narrative_function,
    candidates: Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(proposalTemplate),
      candidate_id: `ROLE_A_OPTION_${index + 1}`,
      design_name: `原创角色方向 ${index + 1}`,
    })),
  }],
};
validation.parseCharacterProposals(JSON.stringify(characterProposals), analysis.source_roles);
const characterJson = JSON.stringify(characterProposals);
const parsedCharacters = validation.parseCharacterProposals(characterJson, analysis.source_roles);
assert.deepEqual(validation.parseCharacterProposals(`角色方案如下：\n\`\`\`json\n${characterJson}\n\`\`\`\n已完成。`, analysis.source_roles), parsedCharacters);
assert.deepEqual(validation.parseCharacterProposals(`角色方案如下：\n${characterJson}\n已完成。`, analysis.source_roles), parsedCharacters);
const withQuotedBraces = JSON.stringify({ ...characterProposals, note: 'literal } [ { and "quotes"' });
assert.deepEqual(validation.parseCharacterProposals(`说明\n${withQuotedBraces}`, analysis.source_roles), validation.parseCharacterProposals(withQuotedBraces, analysis.source_roles));
assert.throws(() => validation.parseCharacterProposals(characterJson.slice(0, -1), analysis.source_roles), /角色设计模型.*不完整/);
assert.throws(() => validation.parseCharacterProposals(`${characterJson}\n${characterJson}`, analysis.source_roles), /多份 JSON/);
assert.throws(() => validation.parseCharacterProposals(characterJson.slice(0, -1) + ',}', analysis.source_roles), /没有可解析/);
assert.throws(() => validation.parseCharacterProposals('未生成角色方案', analysis.source_roles), /角色设计模型.*没有可解析/);
const fragmentProposals = structuredClone(characterProposals);
fragmentProposals.role_sets.push({ ...structuredClone(characterProposals.role_sets[0]), source_role_id: 'ROLE_FRAGMENT_B', candidates: characterProposals.role_sets[0].candidates.map(c => ({ ...structuredClone(c), source_role_id: 'ROLE_FRAGMENT_B', character_id: 'CHAR_B', candidate_id: c.candidate_id + '_B' })) });
const fragmentRoles = fragmentProposals.role_sets.map(r => r.source_role_id);
const splitCharacterJson = JSON.stringify({ ...fragmentProposals, role_sets: fragmentProposals.role_sets.slice(0, 1) }) + ',' + fragmentProposals.role_sets.slice(1).map(r => JSON.stringify(r)).join(',') + ']}';
assert.deepEqual(validation.parseCharacterProposals(splitCharacterJson, fragmentRoles), validation.parseCharacterProposals(JSON.stringify(fragmentProposals), fragmentRoles));
const duplicateRoleJson = JSON.stringify(characterProposals) + ',' + JSON.stringify(characterProposals.role_sets[0]);
assert.throws(() => validation.parseCharacterProposals(duplicateRoleJson, analysis.source_roles), /重复了源角色/);
assert.throws(() => validation.parseCharacterProposals(splitCharacterJson.slice(0, -4), fragmentRoles), /不完整|括号/);
const roleVariants = structuredClone(characterProposals);
roleVariants.role_sets[0].candidates[0].role_function = 'Candidate-specific performance note';
const normalizedRoleVariants = validation.parseCharacterProposals(JSON.stringify(roleVariants), analysis.source_roles);
assert.equal(normalizedRoleVariants.role_sets[0].candidates[0].role_function, roleVariants.role_sets[0].role_function);
assert.equal(normalizedRoleVariants.role_sets[0].candidates[0].original_role_function, 'Candidate-specific performance note');
const sourceStyleCasting = {
  apparent_age_band: '20–24 岁年轻成年人',
  gender_expression: '清爽克制的男性表达',
  regional_visual_context: '当代东亚年轻男性短视频选角语境',
  build_silhouette: '高挑清瘦、窄腰薄肌，不做健美壮硕体型',
  hair_grooming: '自然黑色蓬松中短发，干净精致',
  wardrobe_function: '黑色正式西装制造禁欲感并支持露腹身材展示，不改运动街头装',
  visual_medium: '真人写实竖屏手机短视频，不做插画或 3D 卡通',
};
const castingAnalysis = structuredClone(analysis);
castingAnalysis.source_roles[0].casting_envelope = structuredClone(sourceStyleCasting);
const castingInstruction = prompts.buildCharacterDesignInstruction(castingAnalysis, baseBrief);
assert.match(castingInstruction, /one source_match followed by 3 style_variant/);
assert.doesNotMatch(castingInstruction, /vary identity geometry.*age\/energy/i);
for (const value of Object.values(sourceStyleCasting)) assert.ok(castingInstruction.includes(value));
const castingAppearance = [
  sourceStyleCasting.apparent_age_band,
  sourceStyleCasting.gender_expression,
  sourceStyleCasting.regional_visual_context,
  sourceStyleCasting.build_silhouette,
  sourceStyleCasting.hair_grooming,
  sourceStyleCasting.visual_medium,
].join('；');
const castingCandidate = {
  ...structuredClone(characterProposals.role_sets[0].candidates[0]),
  casting_envelope: structuredClone(sourceStyleCasting),
  appearance: `${castingAppearance}；原创五官组合，不复刻源人物。`,
  wardrobe: sourceStyleCasting.wardrobe_function,
  reference_image_prompt: `原创男性角色身份图，锁定选角范围：${Object.values(sourceStyleCasting).join('；')}；新五官，不复刻源人物；3:4，无文字。`,
};
const castingProposals = {
  schema_version: 'character-proposals.v1',
  role_sets: [{
    source_role_id: 'ROLE_A',
    role_function: castingAnalysis.source_roles[0].narrative_function,
    candidates: Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(castingCandidate),
      candidate_id: `ROLE_A_CASTING_OPTION_${index + 1}`,
      design_name: `同赛道原创身份 ${index + 1}`,
    })),
  }],
};
validation.parseCharacterProposals(JSON.stringify(castingProposals), castingAnalysis.source_roles);
const castingWithoutVerbatimCopies = structuredClone(castingProposals);
castingWithoutVerbatimCopies.role_sets[0].candidates[0].appearance = '同一选角赛道内的原创五官组合与稳定轮廓。';
castingWithoutVerbatimCopies.role_sets[0].candidates[0].wardrobe = '服装细节保持适合原片动作与构图。';
castingWithoutVerbatimCopies.role_sets[0].candidates[0].reference_image_prompt = '原创角色身份参考图，干净背景，无文字。';
validation.parseCharacterProposals(JSON.stringify(castingWithoutVerbatimCopies), castingAnalysis.source_roles);
const castingDrifts = {
  apparent_age_band: '35–45 岁成熟成年人',
  gender_expression: '强势粗犷的男性表达',
  regional_visual_context: '欧美成熟商务男模视觉语境',
  build_silhouette: '宽厚健美、重肌肉体型',
  hair_grooming: '浅金色贴头短发',
  wardrobe_function: '宽松运动街头装',
  visual_medium: '夸张 3D 卡通角色设定图',
};
for (const [field, value] of Object.entries(castingDrifts)) {
  const drifted = structuredClone(castingProposals);
  drifted.role_sets[0].candidates[0].casting_envelope[field] = value;
  assert.throws(
    () => validation.parseCharacterProposals(JSON.stringify(drifted), castingAnalysis.source_roles),
    new RegExp(`选角范围.*${field}`),
  );
}
const sourceFaceCopy = structuredClone(castingProposals);
sourceFaceCopy.role_sets[0].candidates[0].design_rationale = '必须一比一复刻原视频人物的五官和长相。';
assert.throws(
  () => validation.parseCharacterProposals(JSON.stringify(sourceFaceCopy), castingAnalysis.source_roles),
  /不得复刻源人物的具体五官或身份/,
);
const castingReferenceAsset = {
  ...structuredClone(testReferenceAssets[0]),
  candidate_id: castingCandidate.candidate_id,
  prompt: castingCandidate.reference_image_prompt,
};
const castingCompiledPack = compiler.compileCreativePrompts(characterSwapSource, {
  ...baseBrief,
  analysis: castingAnalysis,
  selectedCharacters: [castingCandidate],
  referenceAssets: [castingReferenceAsset],
});
validation.validateCompiledCreativePack(castingCompiledPack, castingAnalysis, false, [castingCandidate]);
assert.deepEqual(castingCompiledPack.character_bible[0].casting_envelope, sourceStyleCasting);
for (const value of Object.values(sourceStyleCasting)) assert.ok(castingCompiledPack.prompt_bundle.target_prompt.includes(value));
assert.match(castingCompiledPack.prompt_bundle.target_prompt, /new fictional identity/i);
const compilerCastingDrift = structuredClone(castingCandidate);
compilerCastingDrift.casting_envelope.build_silhouette = '宽厚健美、重肌肉体型';
assert.throws(
  () => compiler.compileCreativePrompts(characterSwapSource, {
    ...baseBrief,
    analysis: castingAnalysis,
    selectedCharacters: [compilerCastingDrift],
    referenceAssets: [castingReferenceAsset],
  }),
  /改变了源片选角风格/,
);
const instructionWithoutRoleIds = structuredClone(analysis);
delete instructionWithoutRoleIds.beats[0].role_ids;
const projectedInstruction = prompts.buildRemixInstruction(
  instructionWithoutRoleIds,
  baseBrief,
  [characterProposals.role_sets[0].candidates[0]],
  [{
    asset_id: 'asset-1',
    project_id: 'project-1',
    character_id: 'CHAR_A',
    candidate_id: 'ROLE_A_OPTION_1',
    kind: 'identity_sheet',
    uri: '/api/assets/project-1/asset-1',
    mime_type: 'image/png',
    prompt: characterProposals.role_sets[0].candidates[0].reference_image_prompt,
    approved: true,
    created_at: new Date(0).toISOString(),
  }],
);
const lockedBlock = projectedInstruction.match(/<locked_character_bible_json>\s*([\s\S]*?)\s*<\/locked_character_bible_json>/)?.[1] ?? '';
assert.ok(lockedBlock.includes('CHAR_A'));
assert.ok(!lockedBlock.includes('candidate_id'));
assert.ok(projectedInstruction.includes('"dialogue_speaker_ids":["CHAR_A"]'));
const tooFewProposals = structuredClone(characterProposals);
tooFewProposals.role_sets[0].candidates.pop();
assert.throws(() => validation.parseCharacterProposals(JSON.stringify(tooFewProposals), ['ROLE_A']), /恰好生成 4 个/);

const legacyAnalysisWithoutEntityProfile = structuredClone(analysis);
for (const field of ['entity_type', 'species', 'body_plan', 'anthropomorphism_level']) delete legacyAnalysisWithoutEntityProfile.source_roles[0][field];
const normalizedLegacyAnalysis = validation.parseVideoDna(JSON.stringify(legacyAnalysisWithoutEntityProfile));
assert.equal(normalizedLegacyAnalysis.source_roles[0].entity_type, 'human');
const legacyAnalysisWithoutCasting = structuredClone(analysis);
delete legacyAnalysisWithoutCasting.source_roles[0].casting_envelope;
const normalizedLegacyCasting = validation.parseVideoDna(JSON.stringify(legacyAnalysisWithoutCasting));
assert.ok(normalizedLegacyCasting.source_roles[0].casting_envelope.apparent_age_band.includes(analysis.source_roles[0].generalized_appearance));
assert.ok(normalizedLegacyCasting.source_roles[0].casting_envelope.visual_medium.includes(analysis.style_dna.visual.medium));
const legacyPackWithoutCasting = structuredClone(pack);
delete legacyPackWithoutCasting.character_bible[0].casting_envelope;
const normalizedLegacyPackCasting = validation.parseCreativePack(JSON.stringify(legacyPackWithoutCasting), { analysis });
assert.ok(normalizedLegacyPackCasting.character_bible[0].casting_envelope.apparent_age_band.includes(pack.character_bible[0].appearance));

const animalAnalysis = structuredClone(analysis);
animalAnalysis.source_roles[0] = {
  ...animalAnalysis.source_roles[0],
  entity_type: 'animal',
  species: '家猫 / domestic cat',
  body_plan: '自然四足家猫身体结构，完整猫科骨架与长尾',
  anthropomorphism_level: 'none',
  casting_envelope: {
    apparent_age_band: '年轻成年家猫',
    gender_expression: '不强调人类性别表达',
    regional_visual_context: '当代家庭宠物短片视觉语境',
    build_silhouette: '自然四足、圆脸、完整猫科骨架与长尾',
    hair_grooming: '短毛橘色虎斑，白色前爪',
    wardrobe_function: '不穿人类服装，只佩戴墨绿色项圈',
    visual_medium: '写实家庭宠物手机短片',
  },
  narrative_function: '调皮拆家但依恋主人的橘猫主角',
  generalized_appearance: '圆脸橘色虎斑家猫，白色前爪，绿色眼睛，墨绿色项圈。',
  silhouette: '自然四足家猫轮廓，圆头、三角耳、长尾。',
  wardrobe_logic: '不穿人类服装，只佩戴墨绿色项圈。',
  continuity_anchors: ['橘色虎斑', '白色前爪', '绿色眼睛', '墨绿色项圈'],
};
animalAnalysis.beats.forEach((beat) => {
  beat.role_ids = ['ROLE_A'];
  beat.dialogue = { speaker_role: '', speaker_on_screen: false, source_text: '', semantic_intent: '无对白', delivery: '', approx_characters: 0 };
});
const animalCandidate = {
  ...structuredClone(testSelectedCharacter),
  candidate_id: 'ROLE_A_CAT_OPTION_1',
  entity_type: 'animal',
  species: '家猫 / domestic cat',
  body_plan: '自然四足家猫身体结构，完整猫科骨架与长尾',
  anthropomorphism_level: 'none',
  casting_envelope: structuredClone(animalAnalysis.source_roles[0].casting_envelope),
  design_name: '薄荷项圈橘猫',
  appearance: `${animalAnalysis.source_roles[0].casting_envelope.apparent_age_band}；${animalAnalysis.source_roles[0].casting_envelope.gender_expression}；${animalAnalysis.source_roles[0].casting_envelope.regional_visual_context}；${animalAnalysis.source_roles[0].casting_envelope.build_silhouette}；${animalAnalysis.source_roles[0].casting_envelope.hair_grooming}；${animalAnalysis.source_roles[0].casting_envelope.visual_medium}；绿色眼睛。`,
  wardrobe: animalAnalysis.source_roles[0].casting_envelope.wardrobe_function,
  identity_anchors: ['橘色虎斑', '白色前爪', '绿色眼睛', '墨绿色项圈'],
  continuity_lock: ['保持自然四足猫科骨架', '虎斑与白爪位置不变', '长尾与项圈不变'],
  reference_image_prompt: `同一只自然四足橘色虎斑家猫完整角色设定图；锁定选角范围：${Object.values(animalAnalysis.source_roles[0].casting_envelope).join('；')}；绿色眼睛、墨绿色项圈；禁止人形化，禁止成人身体，禁止人类服装。`,
  reference_prompts: {
    turnaround_sheet: '同一只自然四足橘色虎斑家猫的正面、左右侧面、背面和全身完整转面图。',
    expression_sheet: '同一只自然四足橘色虎斑家猫的六种猫科表情与姿态，不做人类表情。',
    hero_portrait: '自然四足橘色虎斑家猫主视觉，白色前爪、绿色眼睛、长尾、墨绿色项圈。',
    negative_prompt: '禁止人形、成人、双足站立、人类手脚、人类服装、物种漂移与身体结构漂移。',
  },
};
const animalProposals = {
  schema_version: 'character-proposals.v1',
  role_sets: [{
    source_role_id: 'ROLE_A',
    role_function: animalAnalysis.source_roles[0].narrative_function,
    candidates: Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(animalCandidate),
      candidate_id: `ROLE_A_CAT_OPTION_${index + 1}`,
      design_name: `自然橘猫方案 ${index + 1}`,
      role_function: animalAnalysis.source_roles[0].narrative_function,
    })),
  }],
};
validation.parseCharacterProposals(JSON.stringify(animalProposals), animalAnalysis.source_roles);
const humanizedAnimalProposals = structuredClone(animalProposals);
humanizedAnimalProposals.role_sets[0].candidates[0].entity_type = 'human';
humanizedAnimalProposals.role_sets[0].candidates[0].species = '人类 / human';
humanizedAnimalProposals.role_sets[0].candidates[0].body_plan = '成年双足人类身体结构';
assert.throws(
  () => validation.parseCharacterProposals(JSON.stringify(humanizedAnimalProposals), animalAnalysis.source_roles),
  /改变了源角色的物种、身体结构或拟人程度/,
);
const animalSourcePack = structuredClone(pack);
animalSourcePack.differentiation_log = ['身份轴：只替换动物身份', '对白轴：源片无对白，保持静默'];
animalSourcePack.beats.forEach((beat) => { beat.dialogue = ''; });
const animalReferenceAsset = {
  ...structuredClone(testReferenceAssets[0]),
  asset_id: 'animal-asset-1',
  candidate_id: animalCandidate.candidate_id,
  prompt: animalCandidate.reference_image_prompt,
};
const animalPack = compiler.compileCreativePrompts(animalSourcePack, {
  ...baseBrief,
  analysis: animalAnalysis,
  selectedCharacters: [animalCandidate],
  referenceAssets: [animalReferenceAsset],
});
validation.validateCompiledCreativePack(animalPack, animalAnalysis, false, [animalCandidate]);
assert.equal(animalPack.character_bible[0].entity_type, 'animal');
assert.equal(animalPack.character_bible[0].species, '家猫 / domestic cat');
for (const anchor of ['家猫 / domestic cat', '自然四足家猫身体结构，完整猫科骨架与长尾', '橘色虎斑', '墨绿色项圈']) {
  assert.ok(JSON.stringify(animalPack).includes(anchor));
}
assert.doesNotMatch(JSON.stringify(animalPack), /natural skin|face, hair|handedness|extra limbs|duplicate people|synchronized lip movement/i);
assert.ok(animalPack.beats.every((beat) => !beat.dialogue));
assert.ok(animalPack.beats.every((beat) => beat.video_prompt.includes('非人角色不得强加人嘴')));

const legacyAnimalAnalysis = structuredClone(animalAnalysis);
for (const field of ['entity_type', 'species', 'body_plan', 'anthropomorphism_level']) delete legacyAnimalAnalysis.source_roles[0][field];
const normalizedLegacyAnimal = validation.parseVideoDna(JSON.stringify(legacyAnimalAnalysis));
assert.equal(normalizedLegacyAnimal.source_roles[0].entity_type, 'animal');
assert.equal(normalizedLegacyAnimal.source_roles[0].species, '家猫 / domestic cat');

// Anatomy stays locked while art direction may vary; legacy proposals retain their old contract.
const variedCats = structuredClone(animalProposals);
variedCats.role_sets[0].candidates.forEach((candidate, index) => {
  candidate.design_mode = index === 0 ? 'source_match' : 'style_variant';
  if (index > 0) {
    candidate.casting_envelope.visual_medium = ['水彩插画', '风格化3D', '写实摄影'][index - 1];
    candidate.casting_envelope.hair_grooming = '自然猫毛，银灰斑纹';
  }
});
validation.parseCharacterProposals(JSON.stringify(variedCats), animalAnalysis.source_roles, 4, true);
assert.throws(() => validation.parseCharacterProposals(JSON.stringify(animalProposals), animalAnalysis.source_roles, 4, true), /第一套/);
const noSourceMatch = structuredClone(variedCats);
noSourceMatch.role_sets[0].candidates[0].design_mode = 'style_variant';
assert.throws(() => validation.parseCharacterProposals(JSON.stringify(noSourceMatch), animalAnalysis.source_roles), /第一套/);
const changedBaseline = structuredClone(variedCats);
changedBaseline.role_sets[0].candidates[0].casting_envelope.visual_medium = '水彩插画';
assert.throws(() => validation.parseCharacterProposals(JSON.stringify(changedBaseline), animalAnalysis.source_roles), /选角范围.*visual_medium/);
for (const [field, changed] of [['species', '人类'], ['body_plan', '人形躯干与手掌'], ['entity_type', 'human'], ['anthropomorphism_level', 'full']]) {
  const invalid = structuredClone(variedCats);
  invalid.role_sets[0].candidates[1][field] = changed;
  assert.throws(() => validation.parseCharacterProposals(JSON.stringify(invalid), animalAnalysis.source_roles), /物种、身体结构或拟人程度/);
}
const changedBuild = structuredClone(variedCats);
changedBuild.role_sets[0].candidates[1].casting_envelope.build_silhouette = '人的身材与手脚';
assert.throws(() => validation.parseCharacterProposals(JSON.stringify(changedBuild), animalAnalysis.source_roles), /选角范围.*build_silhouette/);
const proseHumanized = structuredClone(variedCats);
proseHumanized.role_sets[0].candidates[1].appearance = 'A cat with a human torso and human hands.';
assert.throws(() => validation.parseCharacterProposals(JSON.stringify(proseHumanized), animalAnalysis.source_roles), /文字把自然动物/);
const naturalPoses = structuredClone(variedCats);
naturalPoses.role_sets[0].candidates[1].appearance = 'Natural feline anatomy. No human torso or human hands. Briefly stands to hold a tool in the specified shot.';
validation.parseCharacterProposals(JSON.stringify(naturalPoses), animalAnalysis.source_roles);
const variantCat = variedCats.role_sets[0].candidates[1];
const variantPack = compiler.compileCreativePrompts(animalSourcePack, {
  ...baseBrief, analysis: animalAnalysis, selectedCharacters: [variantCat],
  referenceAssets: [{ ...animalReferenceAsset, candidate_id: variantCat.candidate_id, prompt: variantCat.reference_image_prompt }],
});
validation.validateCompiledCreativePack(variantPack, animalAnalysis, false, [variantCat]);
assert.ok(variantPack.prompt_bundle.target_prompt.includes('水彩插画'));
assert.ok(variantPack.prompt_bundle.target_prompt.includes('不改变骨架'));
const behavingCat = structuredClone(legacyAnimalAnalysis);
behavingCat.source_roles[0].performance_traits = ['会说话，拟人化地做饭，站立拿工具'];
assert.equal(validation.parseVideoDna(JSON.stringify(behavingCat)).source_roles[0].entity_type, 'animal');
const humanoidCat = structuredClone(behavingCat);
humanoidCat.source_roles[0].silhouette = '猫头，人形躯干，人的手掌';
assert.equal(validation.parseVideoDna(JSON.stringify(humanoidCat)).source_roles[0].entity_type, 'anthropomorphic_animal');

const duplicateShot = structuredClone(analysis);
duplicateShot.beats[1].beat_id = duplicateShot.beats[0].beat_id;
assert.throws(() => validation.parseVideoDna(JSON.stringify(duplicateShot)), /重复 ID/);

const silentBeatWithEmptyIntent = structuredClone(analysis);
silentBeatWithEmptyIntent.beats[1].dialogue.semantic_intent = '';
const normalizedSilentBeat = validation.parseVideoDna(JSON.stringify(silentBeatWithEmptyIntent));
assert.equal(normalizedSilentBeat.beats[1].dialogue.semantic_intent, '无对白');

const silentBeatWithNullIntent = structuredClone(analysis);
silentBeatWithNullIntent.beats[1].dialogue.semantic_intent = null;
const normalizedNullSilentBeat = validation.parseVideoDna(JSON.stringify(silentBeatWithNullIntent));
assert.equal(normalizedNullSilentBeat.beats[1].dialogue.semantic_intent, '无对白');

const spokenBeatWithEmptyIntent = structuredClone(analysis);
spokenBeatWithEmptyIntent.beats[0].dialogue.semantic_intent = '';
const normalizedSpokenBeat = validation.parseVideoDna(JSON.stringify(spokenBeatWithEmptyIntent));
assert.equal(normalizedSpokenBeat.beats[0].dialogue.semantic_intent, '意图未识别');
assert.ok(normalizedSpokenBeat.uncertainties.some((item) => item.includes(normalizedSpokenBeat.beats[0].beat_id)));

const invalidSemanticIntent = structuredClone(analysis);
invalidSemanticIntent.beats[0].dialogue.semantic_intent = null;
assert.throws(() => validation.parseVideoDna(JSON.stringify(invalidSemanticIntent)), /semantic_intent必须是非空字符串/);

const undeclaredGap = structuredClone(analysis);
undeclaredGap.beats[1].start_seconds = 2.2;
// 这条只测时间轴 gap；第一拍本来压在原起点上，跟着挪一下，免得先被拍点越界拦住。
undeclaredGap.beats[1].action_beats[0].at_seconds = 2.2;
assert.throws(() => validation.parseVideoDna(JSON.stringify(undeclaredGap)), /未显式声明的 gap/);

const explicitOverlap = structuredClone(analysis);
explicitOverlap.beats[1].start_seconds = 1.8;
explicitOverlap.beats[1].timeline_exception = { kind: 'overlap', duration_seconds: 0.2, reason: '测试叠化' };
validation.parseVideoDna(JSON.stringify(explicitOverlap));

const invalidQa = structuredClone(pack);
invalidQa.qa.originality_pass = false;
assert.throws(() => validation.parseCreativePack(JSON.stringify(invalidQa), { analysis }), /原创性未通过/);

const unknownSpeaker = structuredClone(pack);
unknownSpeaker.beats[0].dialogue = 'CHAR_MISSING：“新台词”';
assert.throws(() => validation.parseCreativePack(JSON.stringify(unknownSpeaker), { analysis }), /不存在的角色/);

const dialogueSource = structuredClone(analysis);
dialogueSource.beats[0].dialogue.source_text = '不要回头看那扇门';
const leakedDialogue = structuredClone(pack);
leakedDialogue.beats[0].dialogue = 'CHAR_A：“不要回头看那扇门”';
assert.throws(
  () => validation.parseCreativePack(JSON.stringify(leakedDialogue), { analysis: dialogueSource }),
  /复用了源对白/,
);

const nonAtomicShot = structuredClone(pack);
nonAtomicShot.beats[0].framing = '近景切到中景';
assert.throws(() => validation.parseCreativePack(JSON.stringify(nonAtomicShot), { analysis }), /原子镜头/);

const missingPromptBlock = structuredClone(compiledPack);
missingPromptBlock.beats[0].video_prompt = missingPromptBlock.beats[0].video_prompt.replace(
  '[CONTINUITY]',
  '[BROKEN BLOCK]',
);
assert.throws(() => validation.validateCompiledCreativePack(missingPromptBlock, analysis), /缺少区块/);

const missingCharacterAnchor = structuredClone(compiledPack);
missingCharacterAnchor.prompt_bundle.target_prompt = missingCharacterAnchor.prompt_bundle.target_prompt.replaceAll('短发', '');
assert.throws(() => validation.validateCompiledCreativePack(missingCharacterAnchor, analysis), /没有自包含角色/);

console.log('Contract smoke tests passed: video-dna.v1, character-proposals.v1 and Seedance creative-pack.v1');
