import type { CharacterBible, CreativeBeat, SeedanceRun } from './types';
import { resolveCharacterEntity } from './entity-profile';

export type PromptEdit = { original: string; text: string };
export type OutputShot = { index: number; beatId: string; start: number; end: number; localChecksPassed?: boolean; issues?: string[] };
export const CREATIVE_PROMPT_LIMIT = 4000;

export function voiceSpeakers(beats: Pick<CreativeBeat, 'dialogue' | 'dialogue_speaker_ids'>[]) {
  return [...new Set(beats.flatMap(beat => beat.dialogue_speaker_ids?.length ? beat.dialogue_speaker_ids : [...(beat.dialogue ?? '').matchAll(/\b(CHAR_[A-Z0-9_]+)\s*[:：]/g)].map(match => match[1])))];
}

export function withVoiceRoles(prompt: string, characters: CharacterBible[], speakers: string[]) {
  if (!characters.length || !prompt.trim()) return prompt;
  const animals = characters.filter(character => {
    const entity = resolveCharacterEntity(character).entity_type;
    return (entity === 'animal' || entity === 'anthropomorphic_animal') && !speakers.includes(character.character_id);
  });
  const instructions = [
    speakers.length ? `对白只由 ${speakers.join('、')} 说，严格按对白标签发声，其他角色不代说。` : '没有对白，不添加人类讲话。',
    ...animals.map(character => {
      const species = resolveCharacterEntity(character).species;
      const sound = /猫|\bcat\b|kitten/i.test(species) ? '真实猫叫' : /狗|犬|\bdog\b|puppy/i.test(species) ? '真实犬吠' : `${species}的自然叫声`;
      return `${character.character_id}：${sound}，不说人话、不发人类喊叫；拟人动作不改变叫声。`;
    }),
  ].join('');
  const blocks = prompt.split(/\n\s*\n/).filter(block => !block.startsWith('发声：'));
  const at = blocks.findIndex(block => block.startsWith('声音：'));
  blocks.splice(at < 0 ? blocks.length : at, 0, `发声：${instructions}`);
  return blocks.join('\n\n');
}

export function compactCreativePrompt(prompt: string) {
  return prompt.split(/\n\s*\n/).filter(block => !/^\s*\[素材绑定/.test(block)).map(block => {
    if (/^CHAR_[A-Z0-9_]+[：:]/.test(block) && block.includes('固定特征：')) {
      const id = block.match(/^CHAR_[A-Z0-9_]+/)![0];
      const anatomy = block.match(/身体约束：[\s\S]*$/)?.[0] ?? '';
      const style = block.match(/角色美术风格：([^，。]+)[，。]/)?.[1];
      return `${id}：外观、服装以角色图为准。${style ? `风格：${style}。` : ''}${anatomy}`;
    }
    return block.replace(/^(\d+(?:\.\d+)?\s*秒)[，,]\s*\d+\s*[:：]\s*\d+[。.]?/, '$1。')
      .replace('只用角色图和以下文字分镜，不需要参考视频。', '');
  }).filter(Boolean).join('\n\n');
}

export function withPrevisBinding(prompt: string, scope: 'segment' | 'full' = 'segment') {
  const blocks = compactCreativePrompt(prompt).split(/\n\s*\n/);
  const images = blocks.filter(block => /^\s*CHAR_[A-Z0-9_]+\s*=\s*【/.test(block));
  const video = blocks.find(block => /^\s*3D 参考\s*=/.test(block)) ?? `3D 参考 = 【${scope === 'full' ? '整片 3D 预演视频' : '本段预演视频'}】；仅参考走位、构图与运镜，角色外观以图片为准。`;
  const body = blocks.filter(block => !/^\s*\[素材绑定/.test(block) && !images.includes(block) && !/^\s*3D 参考\s*=/.test(block)).join('\n\n')
    .replace('只用角色图和以下文字分镜，不需要参考视频。', '绑定本段 3D 预演作为走位、构图与运镜参考；以文字动作和角色图为准，不生成灰模外观。');
  return [...images, video, body].filter(Boolean).join('\n\n');
}

export function editedRun(run: SeedanceRun, edit?: PromptEdit): SeedanceRun {
  return edit?.original === run.target_prompt ? { ...run, target_prompt: edit.text } : run;
}

export function matchingPrevisShot(run: SeedanceRun, shots: OutputShot[], preserve: boolean) {
  if (!preserve || run.beat_ids.length !== 1) return undefined;
  return shots.find(shot => (run.beat_ids[0] === shot.beatId || run.beat_ids[0].startsWith(`${shot.beatId}_`))
    && run.source_start_seconds >= shot.start - .01 && run.source_end_seconds <= shot.end + .01);
}
