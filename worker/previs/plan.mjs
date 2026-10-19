// 按镜编排的纯逻辑：本机助手（落盘）和浏览器（IndexedDB）共用同一份。
// 这里不碰文件系统，存取都经调用方给的 store，所以两边的提示词、校验、续跑规则永远一致。
import { requirementsFor, parsePlanningResponse } from './contract.mjs';
import { normalizeLibrary } from './batch.mjs';
import { LIBRARY_SCHEMA, LIBRARY_VERSION, shotResponseSchema, expandShotPlan, libraryPlanningPrompt, shotPlanningPrompt } from './shot.mjs';
import { frameCount, framingIssues } from './kinematics.mjs';

/**
 * 展开一镜并做画面检查（framing 为原片宽高时启用）：角色整镜不在画面里、镜头拍不到任何角色、
 * 东西埋在地面以下，都算没通过——这类计划渲出来就是错的，续跑时把具体问题交给模型重排。
 */
export function acceptShot(shot, library, segments, index, framing) {
  const plan = expandShotPlan(shot, library, segments, index);
  if (framing?.width && framing?.height) {
    const issues = framingIssues(plan, frameCount(segments[index].start, segments[index].end), framing.width, framing.height);
    if (issues.length) throw new Error(`画面检查未通过：${issues.join('；')}`);
  }
  return plan;
}

export function segmentsFor(analysis, maxSeconds = 12) {
  const segments = [];
  for (const [shotIndex, beat] of analysis.beats.entries()) {
    const count = Math.ceil((beat.end_seconds - beat.start_seconds) / maxSeconds);
    for (let i = 0; i < count; i++) {
      const start = +(beat.start_seconds + i * (beat.end_seconds - beat.start_seconds) / count).toFixed(6);
      const end = +(beat.start_seconds + (i + 1) * (beat.end_seconds - beat.start_seconds) / count).toFixed(6);
      segments.push({ shotIndex, part: i, beat, start, end, requirements: requirementsFor(beat, start, end) });
    }
  }
  return segments;
}

export function endState(plan) {
  return {
    actors: plan.actors.map(a => ({ ...a, keys: [a.keys.at(-1)] })),
    props: plan.props.map(p => ({ ...p, keys: [p.keys.at(-1)] })),
    camera: plan.camera.at(-1),
  };
}

export const shotFile = index => `shot-${String(index + 1).padStart(3, '0')}-response.json`;
export const LIBRARY_FILE = 'library-response.json';

/**
 * 读一份保存过的模型返回，拿到可用数据就返回，拿不到返回 undefined（交给调用方决定要不要重调）。
 * 截断的结果一律不复用：缺的内容补不回来，硬用只会渲出半截动作。
 */
export function reusableResponse(saved) {
  if (!saved) return undefined;
  if (saved.data) return saved.data;
  if (/MAX_TOKENS|截断|长度上限/.test(saved.parseError || '')) return undefined;
  try { return parsePlanningResponse(saved.raw).data; } catch { return undefined; }
}

/**
 * 按镜编排：先一次定共享库，再每镜一次。
 *
 * 每次返回都保存，下次进来先复用——所以失败后重试是「从坏掉那镜继续」，
 * 前面已经拿到的不重复计费。任何一镜失败都不自动重调：花钱的动作必须由用户点。
 *
 * store: { read(name) → 已保存对象或 undefined, write(name, value), reject(name) 把不合格结果挪开留证 }
 */
export async function planPerShot({ analysis, segments, store, model, signal, allowModelCalls, onProgress, manifest, framing }) {
  // accept 负责校验并展开；保存的结果过不了它，就不能每次续跑都拿它去撞同一堵墙。
  const obtain = async ({ file, prompt, schema, label, accept }) => {
    const reused = reusableResponse(await store.read(file));
    if (reused) {
      try { const value = accept(reused); manifest.reusedModelCalls += 1; return value; }
      catch (cause) {
        if (!allowModelCalls) throw new Error(`${label}：已保存的结果没通过检查（${cause.message}），需要重新调用模型`);
        // 以前这里直接复用：存下来的结果只要能解析就一直被拿来用，校验每次都在同一处失败，
        // 「从断点继续」永远走不下去。现在把它挪开留作证据，再为这一项重新调用一次。
        await store.reject(file);
        // 用户明确续跑后，把具体缺项交给模型；不悄悄填充不存在的机位或动作。
        prompt += `\n上次${label}的结果未通过检查：${cause.message}。请依据本镜 DNA 重新输出完整计划，补齐这些缺项；不要只返回修补片段或空数组。`;
      }
    }
    if (!allowModelCalls) throw new Error(`${label}没有可复用的已保存结果，无法免调用完成`);
    // 网络层的错（524、超时、连接断）也要带上标签，否则界面只说「全片编排失败」，
    // 看不出是共享库那一次还是第几镜死的。
    let result;
    // 已尝试调用但遇到 524 / 断线，也不能记成「本次调用 0 次」。这不是计费确认。
    manifest.newModelCalls += 1;
    try { result = await model({ prompt, videos: [], schema, signal }); }
    catch (cause) {
      // 明确没发出去的（转发服务器拒绝、超出已确认的调用次数）不算一次调用，也不留失败存档。
      if (cause?.notSubmitted) { manifest.newModelCalls -= 1; throw new Error(`${label}：${cause.message}`); }
      await store.write(file, { data: null, raw: '', parseError: cause.message, requestFailure: cause.requestFailure });
      throw new Error(`${label}：${cause.message}`);
    }
    await store.write(file, result);
    // 中转不吃 responseSchema 时会退回无约束模式；这不是失败，但用户有权知道这一次少了一层保护。
    if (result.schemaRejected && !manifest.schemaRejected) manifest.schemaRejected = true;
    if (result.parseError) throw new Error(`${label}：${result.parseError}`);
    if (!result.data) throw new Error(`${label}：模型没有返回可用内容`);
    return accept(result.data);
  };

  await onProgress({ stage: 'planning', total: segments.length, message: allowModelCalls ? '第 1 步：编排全片共用的角色、道具与姿态' : '正在校验已保存的动作计划，不调用模型' });
  const library = await obtain({
    file: LIBRARY_FILE, prompt: libraryPlanningPrompt(analysis, segments), schema: LIBRARY_SCHEMA, label: '共享库编排',
    accept: data => { if (data?.schema_version !== LIBRARY_VERSION) throw new Error(`共享库必须为 ${LIBRARY_VERSION}`); return normalizeLibrary(data); },
  });

  const plans = [];
  let previousEnd;
  for (const index of segments.keys()) {
    signal?.throwIfAborted();
    await onProgress({ stage: 'planning', index, total: segments.length, message: `第 ${index + 1}/${segments.length} 镜：编排动作` });
    try {
      const plan = await obtain({
        file: shotFile(index),
        prompt: shotPlanningPrompt(analysis, segments, index, library, previousEnd),
        schema: shotResponseSchema(segments[index], library), label: `第 ${index + 1} 镜编排`,
        accept: shot => acceptShot(shot, library, segments, index, framing),
      });
      plans.push(plan);
      previousEnd = endState(plan);
    } catch (error) {
      throw new Error(`${error.message}。前 ${index} 镜计划已通过检查；继续时复用有效结果，缺失或仍不合格的镜头需要调用模型（计费）`);
    }
  }
  return plans;
}

/**
 * 不调用模型，按 planPerShot 的同一顺序和同一校验，数出这次真正要调用几次。
 * 付费确认框必须用它：存档「有数据」不等于能复用，校验不过的那一镜续跑时会重新调用。
 * 共享库需要重调时，后面各镜能否复用取决于新的库，无法提前知道，按「都要调」从严计数（exact=false）。
 */
export async function countModelCalls({ segments, store, framing }) {
  const usable = async (file, accept) => {
    const saved = reusableResponse(await store.read(file));
    if (!saved) return undefined;
    try { return accept(saved); } catch { return undefined; }
  };
  const library = await usable(LIBRARY_FILE, data => { if (data?.schema_version !== LIBRARY_VERSION) throw new Error('version'); return normalizeLibrary(data); });
  if (!library) {
    // 一份存档都没有（第一次跑）时就是精确的全部次数；有旧镜头存档才可能少于上限。
    let anySaved = false;
    for (const index of segments.keys()) if (reusableResponse(await store.read(shotFile(index)))) { anySaved = true; break; }
    return { total: segments.length + 1, toCall: segments.length + 1, exact: !anySaved };
  }
  // 每镜的存档按自己的校验决定能否复用（与 planPerShot 相同），所以逐镜数即可。
  // 续跑时新返回可能往共享库里加姿态，影响极少；真实运行另有「不超过已确认次数」的硬上限兜底。
  let toCall = 0;
  for (const index of segments.keys()) {
    if (!await usable(shotFile(index), shot => acceptShot(shot, library, segments, index, framing))) toCall += 1;
  }
  return { total: segments.length + 1, toCall, exact: true };
}
