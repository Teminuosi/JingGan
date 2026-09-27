import { actionBeatLines } from './original-story';
import type { CreativePack, VideoDnaAnalysis } from './types';

export function formatTime(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}s` : `${rounded.toFixed(1)}s`;
}

export function creativePackToMarkdown(pack: CreativePack): string {
  const seedanceAssets = pack.seedance_asset_map
    ? `# Seedance 参考素材映射\n\n${pack.seedance_asset_map.bindings.map((binding) => `- **${binding.slot}**：${binding.instruction}`).join('\n')}\n\n${pack.seedance_asset_map.usage_note}\n\n`
    : '';
  const fullRun = pack.seedance_asset_map?.full_run;
  const seedanceFullRun = fullRun
    ? `# Seedance 整片一次生成\n\n新故事 ${formatTime(fullRun.source_start_seconds)}–${formatTime(fullRun.source_end_seconds)}｜${fullRun.beat_ids.length} 镜｜${fullRun.target_prompt.length.toLocaleString()} / ${fullRun.character_limit.toLocaleString()} 字符${fullRun.within_character_limit ? '' : '（已超安全长度）'}\n\n${fullRun.assembly_instruction}\n\n${fullRun.target_prompt}\n\n`
    : '';
  const seedanceRuns = pack.seedance_asset_map?.runs?.length
    ? `# Seedance 分段执行（测试或回退用）\n\n${pack.seedance_asset_map.runs.map((run) => `## ${run.run_id}｜${pack.remix_policy?.effective_mode === 'full_original' ? '新故事' : '源视频'} ${formatTime(run.source_start_seconds)}–${formatTime(run.source_end_seconds)}\n\n${run.assembly_instruction}\n\n${run.target_prompt}`).join('\n\n---\n\n')}\n\n`
    : '';
  const dialogueTimeline = pack.beats
    .filter((beat) => Boolean(beat.dialogue.trim()))
    .map((beat) => `- **${formatTime(beat.start_seconds)}–${formatTime(beat.end_seconds)}｜${beat.dialogue_speaker_ids?.join('、') || '说话人待核'}**：${beat.dialogue}`)
    .join('\n');
  const characters = pack.character_bible
    .map(
      (character) => `## ${character.character_id}｜${character.role_function}

**身份锚点：** ${character.identity_anchors.join('；')}

**形象：** ${character.appearance}

**服装：** ${character.wardrobe}

**表演：** ${character.performance}

### 角色五视图提示词

${character.reference_prompts.turnaround_sheet}

### 表情表提示词

${character.reference_prompts.expression_sheet}

### 主视觉肖像提示词

${character.reference_prompts.hero_portrait}

### 角色负面提示词

${character.reference_prompts.negative_prompt}`,
    )
    .join('\n\n---\n\n');

  const beats = pack.beats
    .map(
      (beat) => `### ${beat.beat_id}｜${formatTime(beat.start_seconds)}–${formatTime(beat.end_seconds)}

- 叙事功能：${beat.story_function}
- 角色：${beat.character_ids.join('、') || '无'}
- 动作：${beat.action}
${actionBeatLines(beat).map((line) => `  -${line.replace(/^ {2}/, ' ')}`).join('\n')}${beat.action_beats?.length ? '\n' : ''}- 表演：${beat.performance}
- 场景：${beat.environment || pack.concept_summary}
- 道具：${(beat.props ?? []).join('、') || '无'}
- 镜头：${beat.framing}；${beat.camera_motion}
- 灯光：${beat.lighting}
- 连续性：${beat.continuity}
- 对白：${beat.dialogue || '无'}
- 声音：${beat.sound}

**逐镜头视频提示词**

${beat.video_prompt}`,
    )
    .join('\n\n');

  return `# ${pack.title}

${pack.concept_summary}

${pack.remix_policy ? `**创作模式：** ${pack.remix_policy.effective_mode}（请求：${pack.remix_policy.requested_mode}；素材范围：${pack.remix_policy.source_rights_scope}）` : ''}

## 锁定与替换记录

${pack.differentiation_log.map((item) => `- ${item}`).join('\n')}

# ${pack.remix_policy?.effective_mode === 'full_original' ? '已确认的新对白时间表' : '英文原对白时间表'}

${dialogueTimeline || '- 本片无对白'}

# 角色圣经

${characters}

# 逐镜头生成包

${beats}

${seedanceAssets}${seedanceFullRun}${seedanceRuns}# 总提示词

## 通用版

${pack.prompt_bundle.generic_master}

## ${pack.prompt_bundle.target_model} 版

${pack.prompt_bundle.target_prompt}

## 首帧提示词

${pack.prompt_bundle.first_frame_prompt}

## 尾帧提示词

${pack.prompt_bundle.last_frame_prompt}

## 负面提示词

${pack.prompt_bundle.negative_prompt}
`;
}

export function analysisToMarkdown(analysis: VideoDnaAnalysis): string {
  const beats = analysis.beats
    .map(
      (beat) => `### ${beat.beat_id}｜${formatTime(beat.start_seconds)}–${formatTime(beat.end_seconds)}

${beat.narrative_function}：${beat.visual_action}

- 镜头：${beat.framing}；${beat.camera_motion}
- 构图：${beat.composition}
- 灯光：${beat.lighting}
- 声音：${beat.sound}
- 对白意图：${beat.dialogue.semantic_intent}
- 置信度：${Math.round(beat.confidence * 100)}%`,
    )
    .join('\n\n');

  return `# 视频 DNA 分析

${analysis.source.one_line_summary}

- 类型：${analysis.source.format_type}
- 时长：${formatTime(analysis.source.duration_seconds)}
- 画幅：${analysis.source.aspect_ratio}
- 钩子：${analysis.style_dna.hook_pattern}

## 建议保留

${analysis.preserve_recommendations.map((item) => `- ${item}`).join('\n')}

## 建议替换

${analysis.replace_recommendations.map((item) => `- ${item}`).join('\n')}

## 时间轴

${beats}
`;
}

export function downloadText(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
