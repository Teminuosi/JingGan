// 内置提示词模板。
//
// 模板写成代码而不是数据库里的字符串，理由是它需要逻辑：
// 「有逐拍动作就逐行展开，没有就退回整镜概括」这种分支用模板语言表达很难看。
// prompt_templates 表存的是版本记录与人工覆盖，默认走这里的内置版。
//
// 版本号只增不改：v1 发布后就冻结，改了要发 v2。
// 因为线上跑过的片子记录的是「用 v1 生成」，改动 v1 的行为会让历史记录变成谎话。

import { shotCharacterIds, shotDuration, type ShotDna } from '../shot-dna/types';
import type { CompileContext, PromptSection, PromptTemplate } from './types';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function section(key: string, title: string, priority: number, lines: Array<string | false | undefined>): PromptSection | null {
  const kept = lines.filter((l): l is string => Boolean(l && clean(l)));
  return kept.length ? { key, title, priority, lines: kept.map(clean) } : null;
}

/** 一拍交锋的文字表述。与老项目 actionBeatText 同一套措辞，免得两处各写各的。 */
function frameText(frame: ShotDna['action_timeline'][number]): string {
  const actors = frame.actor_ids.filter((id) => !frame.action.includes(id));
  const toward = (frame.toward_ids ?? []).filter((id) => !frame.action.includes(id) && !(frame.reaction ?? '').includes(id));
  const tail = [
    toward.length ? `对准 ${toward.join('、')}` : '',
    frame.reaction ? `对方：${frame.reaction}` : '',
    frame.consequence ? `结果：${frame.consequence}` : '',
  ].filter(Boolean);
  return `${[actors.join('、'), frame.action].filter(Boolean).join(' ')}${tail.length ? `；${tail.join('；')}` : ''}`;
}

const SIZE_CN: Record<string, string> = {
  ECU: '大特写', CU: '特写', MCU: '近景', MS: '中景', MLS: '中全景', LS: '全景', ELS: '大远景', unknown: '',
};
const ANGLE_CN: Record<string, string> = {
  eye_level: '平视', high: '俯拍', low: '仰拍', overhead: '顶拍', dutch: '斜角',
  over_shoulder: '过肩', pov: '主观视角', unknown: '',
};
const MOVE_CN: Record<string, string> = {
  static: '固定机位', pan: '横摇', tilt: '纵摇', dolly_in: '推近', dolly_out: '拉远',
  truck: '横移', crane: '升降', handheld: '手持', zoom: '变焦', orbit: '环绕', unknown: '',
};

/** 重试时按失败分类加强对应段落。规格第十八章：不同错误用不同策略，而不是原样重跑。 */
const RETRY_REINFORCEMENT: Record<string, string> = {
  identity_drift: '严格保持角色面部特征与参考图一致，不要改变五官、发型、肤色。',
  motion_wrong: '严格按下方时间轴执行动作，每个时间点只做该做的事，不要添加额外动作。',
  camera_wrong: '镜头运动必须严格照上面的机位段执行，不要自行推拉摇移。',
  spatial_wrong: '严格遵守人物的左右站位与前后层次，不要交换位置。',
  popin: '所有人物在镜头开始时的位置已写明；没有写明入画的人物不得中途出现。',
  minor_artifact: '保持画面干净，避免多余肢体、变形的手部与穿模。',
};

/**
 * 视频模型的主模板。
 *
 * 段落顺序是刻意的：视频模型对提示词前部的权重更高，所以
 * 「谁 → 在哪 → 做什么（时间轴）→ 怎么拍 → 什么风格」按重要性从前往后排。
 * 优先级则相反地反映「超长时先砍谁」：风格、声音可以砍，动作时间轴绝不能砍。
 */
export const VIDEO_TEMPLATE_V1: PromptTemplate = {
  name: 'video-shot',
  version: 'v1',
  target: 'video',
  changelog: '初版：角色→场景→逐拍时间轴→机位→光线→风格→承接，带重试加强与 Blender 空间引用。',
  render(dna: ShotDna, ctx: CompileContext) {
    const duration = shotDuration(dna);
    const ids = shotCharacterIds(dna);
    const sections: Array<PromptSection | null> = [];

    sections.push(section('retry', '本次重点', 100, [
      ctx.retryHint ? (RETRY_REINFORCEMENT[ctx.retryHint.failureClass] ?? '') : '',
      ctx.retryHint?.note,
    ]));

    sections.push(section('cast', '人物', 90, ids.map((id) => {
      const brief = ctx.characters[id];
      const actor = dna.actors.find((a) => a.character_id === id);
      if (!brief) return `${id}`;
      const slot = brief.referenceSlot ? `（${brief.referenceSlot}）` : '';
      const place = actor && actor.screen_position !== 'center' ? `位于画面${POSITION_CN[actor.screen_position] ?? ''}` : '';
      const entry = actor?.entry_at
        ? `第 ${actor.entry_at} 秒${actor.role_in_shot || '入画'}`
        : '镜头开始时已在画面中';
      return [`${brief.name}${slot}：${brief.appearance}`, brief.wardrobe, place, entry, actor?.facing]
        .filter(Boolean).join('，');
    })));

    sections.push(section('scene', '场景', 85, [
      [dna.environment.location, dna.environment.time_of_day, dna.environment.weather].filter(Boolean).join('，'),
      dna.environment.set_dressing.length ? `场景内有：${dna.environment.set_dressing.join('、')}` : '',
    ]));

    // 动作时间轴是全片最不能丢的东西：一个 19 秒的镜头里六七个回合，
    // 压成一句概括模型就会随便演。优先级给到仅次于重试提示。
    sections.push(section('action', `动作时间轴（本镜 ${duration} 秒）`, 95,
      dna.action_timeline.length
        ? dna.action_timeline.map((f) => `${f.at}s ${frameText(f)}`)
        : [dna.summary]));

    sections.push(section('expression', '表情与视线', 70,
      dna.expression_timeline.map((f) => {
        const name = ctx.characters[f.character_id]?.name ?? f.character_id;
        return `${f.at}s ${name}：${f.expression}${f.gaze ? `，视线看向 ${ctx.characters[f.gaze]?.name ?? f.gaze}` : ''}`;
      })));

    sections.push(section('camera', '机位', 80, [
      [SIZE_CN[dna.camera.shot_size], ANGLE_CN[dna.camera.angle], MOVE_CN[dna.camera.movement]].filter(Boolean).join('，'),
      dna.camera.movement_detail,
      dna.camera.composition_notes,
      dna.camera.lens_mm ? `等效焦距约 ${dna.camera.lens_mm}mm` : '',
      dna.camera.depth_of_field !== 'unknown' ? DOF_CN[dna.camera.depth_of_field] : '',
    ]));

    sections.push(section('blender', '空间关系（已按 3D 预演锁定）', 88, [
      ctx.blenderPreview?.blocking,
      ctx.blenderPreview?.cameraPath,
    ]));

    sections.push(section('lighting', '光线', 60, [
      [dna.lighting.key_light, dna.lighting.direction, dna.lighting.color_temperature].filter(Boolean).join('，'),
      dna.lighting.practicals.length ? `画面内光源：${dna.lighting.practicals.join('、')}` : '',
      dna.lighting.mood,
    ]));

    sections.push(section('dialogue', '对白', 65, [
      // 没台词时这一段原来整个被丢掉，模型收不到任何关于人声的指令，
      // 于是自己配一段旁白。无对白必须写成一条明确的负向指令。
      dna.dialogue.text
        ? `${ctx.characters[dna.dialogue.speaker_id]?.name ?? dna.dialogue.speaker_id}（${ctx.dialogueLanguage}）：${dna.dialogue.text}${dna.dialogue.delivery ? `，${dna.dialogue.delivery}` : ''}`
        : '无对白，不要人声、旁白或说话口型',
    ]));

    sections.push(section('style', '画风', 50, [
      [dna.visual_style.medium, dna.visual_style.texture, dna.visual_style.grade].filter(Boolean).join('，'),
      dna.visual_style.palette.length ? `主色：${dna.visual_style.palette.join('、')}` : '',
      dna.visual_style.atmosphere,
      ctx.styleLock.visual,
    ]));

    sections.push(section('continuity', '承接', 55, [
      ctx.previousShot ? dna.continuity.from_previous : '',
      dna.transition_in,
    ]));

    sections.push(section('sound', '声音', 30, [dna.sound, ctx.styleLock.sound]));

    return {
      sections: sections.filter((s): s is PromptSection => s !== null),
      negative: [
        ...ctx.styleLock.negativeConstraints,
        '不要出现字幕、水印、台标',
        '不要多余的肢体或变形的手',
      ],
    };
  },
};

const POSITION_CN: Record<string, string> = {
  left: '左侧', center_left: '偏左', center: '中央', center_right: '偏右', right: '右侧', offscreen: '画外',
};
const DOF_CN: Record<string, string> = { shallow: '浅景深，背景虚化', medium: '中等景深', deep: '深景深，前后清晰', unknown: '' };

/**
 * 首帧关键帧模板。
 * 关键帧只需要「静态的第一瞬间」，所以刻意不写动作过程——写了图片模型会画出运动模糊。
 */
export const KEYFRAME_TEMPLATE_V1: PromptTemplate = {
  name: 'keyframe-first',
  version: 'v1',
  target: 'image_keyframe',
  changelog: '初版：只描述第 0 秒的静态画面，不含动作过程。',
  render(dna: ShotDna, ctx: CompileContext) {
    const first = dna.action_timeline[0];
    const sections: Array<PromptSection | null> = [
      section('frame', '画面', 90, [
        [SIZE_CN[dna.camera.shot_size], ANGLE_CN[dna.camera.angle]].filter(Boolean).join('，'),
        dna.camera.composition_notes,
      ]),
      section('cast', '人物', 85, dna.actors
        // 中途才入画的人不该出现在首帧里——这正是 pop-in 的反面：
        // 首帧画了他，视频模型反而会让他从头站到尾。
        .filter((a) => !a.entry_at)
        .map((a) => {
          const brief = ctx.characters[a.character_id];
          return [brief?.name ?? a.character_id, brief?.appearance, a.wardrobe || brief?.wardrobe,
            `位于画面${POSITION_CN[a.screen_position] ?? '中央'}`, a.facing].filter(Boolean).join('，');
        })),
      section('scene', '场景', 80, [
        [dna.environment.location, dna.environment.time_of_day].filter(Boolean).join('，'),
        dna.environment.set_dressing.join('、'),
      ]),
      section('pose', '起始姿态', 75, [first && first.at <= 0.5 ? `即将开始：${frameText(first)}` : '静止的起始姿态']),
      section('lighting', '光线', 60, [dna.lighting.key_light, dna.lighting.direction, dna.lighting.mood]),
      section('style', '画风', 55, [
        dna.visual_style.medium, dna.visual_style.texture,
        dna.visual_style.palette.length ? `主色：${dna.visual_style.palette.join('、')}` : '',
        ctx.styleLock.visual,
      ]),
    ];
    return {
      sections: sections.filter((s): s is PromptSection => s !== null),
      negative: [...ctx.styleLock.negativeConstraints, '不要运动模糊', '不要连环画分格', '不要文字'],
    };
  },
};

/** 所有内置模板。新增模板在这里注册。 */
export const BUILTIN_TEMPLATES: PromptTemplate[] = [VIDEO_TEMPLATE_V1, KEYFRAME_TEMPLATE_V1];
