import { parsePlanningResponse } from './contract.mjs';
import { newSink, readSseText } from './stream.mjs';

export function validateConnection(connection) {
  const url = new URL(connection.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || /(?:localhost|\.local)$/.test(url.hostname)) throw new Error('分析服务地址必须为公开 HTTPS 地址');
  if (typeof connection.apiKey !== 'string' || !connection.apiKey.trim() || /[\r\n]/.test(connection.apiKey)) throw new Error('缺少分析 Key');
  if (!/^[a-zA-Z0-9._-]+$/.test(connection.model)) throw new Error('请选择 Gemini 原生视频分析模型');
  return { baseUrl: url.origin, apiKey: connection.apiKey, model: connection.model };
}

// readVideo 由本机助手注入（读磁盘）；浏览器编排不附视频，用不到它。
export function createGemini(connection, { fetchImpl = fetch, onCall = () => {}, readVideo } = {}) {
  const c = validateConnection(connection);
  return async ({ prompt, videos = [], schema, signal }) => {
    const parts = [];
    for (const file of videos) {
      if (!readVideo) throw new Error('当前环境不能附带视频');
      const bytes = await readVideo(file);
      if (bytes.length > 12 * 1024 * 1024) throw new Error('单段视频超过 12MB，未提交模型');
      parts.push({ inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') }, videoMetadata: { fps: 8 } });
    }
    parts.push({ text: prompt });
    const startedAt = Date.now();
    // 仅降低已验证支持该参数的 Gemini Pro 单镜编排延迟；不缩短输出上限或放松计划结构。
    // 默认 high 可能在首个正文分片前等待很久，流式本身无法绕过中转的首包超时。
    const thinkingLevel = !videos.length && ['gemini-3.1-pro-preview', 'gemini-3-pro-preview'].includes(c.model)
      && schema?.properties?.schema_version?.enum?.includes('motion-shot.v2') ? 'low' : undefined;
    await onCall({ stage: 'submitting', model: c.model, thinkingLevel });
    // 带上 responseSchema 时解码受结构约束，语法上就吐不出不配对的括号——
    // 「42k 字符里错两个闭括号导致整单作废」那类事故的正手防线。
    // 流式有助于及时接收分片，但上游一直不返回首包时仍会发生 524。
    // 实际失败在 125.8 秒；延长本机的 15 分钟超时不能改变中转代理的等待上限。
    const submit = async ({ withSchema, stream }) => fetchImpl(`${c.baseUrl}/v1beta/models/${c.model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15 * 60 * 1000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}`, 'x-goog-api-key': c.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 32768, ...(withSchema ? { responseSchema: schema } : {}), ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}), ...(videos.length ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}) } }),
    });
    // Do not automatically retry ambiguous paid requests after connection loss.
    // 仅保留明确 400/404 响应的兼容回退，并记录降级标记；5xx 和连接中断不重发。
    // 中转如何计费仍以其记录为准，不能仅由 HTTP 状态断言免费。
    let streamed = true, schemaRejected = false;
    const failed = async (message, details) => {
      const requestFailure = { model: c.model, ms: Date.now() - startedAt, streamed, schemaRejected, thinkingLevel, billingStatus: 'unknown', ...details };
      await onCall({ stage: 'failed', ...requestFailure });
      return Object.assign(new Error(message), { requestFailure });
    };
    let response;
    try {
      response = await submit({ withSchema: Boolean(schema), stream: true });
      // 新的延迟参数被拒时不偷偷退回高思考模式或无结构约束模式。
      if (!thinkingLevel && schema && response.status === 400) { schemaRejected = true; response = await submit({ withSchema: false, stream: true }); }
      if ((!thinkingLevel && response.status === 400) || response.status === 404) { streamed = false; response = await submit({ withSchema: schema && !schemaRejected, stream: false }); }
    } catch (cause) {
      // 调用方明确知道请求没有发到中转（例如转发服务器拒绝、超过已确认次数），原样抛出，不当成「可能已计费」。
      if (cause?.notSubmitted) throw cause;
      throw await failed('编排连接中断，无法确认上游是否生成或计费；已停止，未自动重发', { finishReason: 'NETWORK_ERROR' });
    }
    if (!response.ok) {
      const ray = response.headers.get('cf-ray') || '';
      const cfRay = /^[a-f0-9]{8,32}-[a-z0-9]{3,5}$/i.test(ray) ? ray : undefined;
      const elapsed = (Date.now() - startedAt) / 1000;
      const reason = response.status === 524 ? `中转等待上游超时（约 ${elapsed.toFixed(1)} 秒）` : '请求未取得可用结果';
      await response.body?.cancel().catch(() => {});
      throw await failed(`视频分析服务返回 HTTP ${response.status}：${reason}；无法确认是否已生成或计费，请查看中转请求记录，未自动重发`, { status: response.status, finishReason: 'HTTP_ERROR', cfRay });
    }

    const flags = { schemaRejected, streamed, ...(thinkingLevel ? { thinkingLevel } : {}) };
    const sink = newSink();
    if (streamed) {
      try { await readSseText(response.body, sink); }
      catch (cause) {
        // 半路断了也把这半截存下来：至少能看出断在哪，也能判断上游是不是已经生成完、已经计费。
        await onCall({ stage: 'received', model: c.model, ms: Date.now() - startedAt, usage: sink.usage, finishReason: 'STREAM_INTERRUPTED', chunks: sink.chunks });
        return { raw: sink.text, data: null, ...flags, parseError: `传输中途断开（已收到 ${sink.chunks} 个分片、${sink.text.length} 字符）：${cause.message}`, usage: sink.usage };
      }
    } else {
      const result = await response.json();
      sink.text = (result.candidates?.[0]?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('');
      sink.usage = result.usageMetadata;
      sink.finishReason = result.candidates?.[0]?.finishReason;
      sink.chunks = sink.text ? 1 : 0;
    }
    const ms = Date.now() - startedAt;
    await onCall({ stage: 'received', model: c.model, ms, usage: sink.usage, finishReason: sink.finishReason, chunks: sink.chunks, streamed, schemaRejected });
    if (!sink.text || sink.finishReason === 'MAX_TOKENS') return { raw: sink.text, data: null, ...flags, parseError: '模型结果为空或被长度上限截断；请压缩关键帧数量但保留完整动作', usage: sink.usage };
    try { return { raw: sink.text, ...flags, ...parsePlanningResponse(sink.text), usage: sink.usage }; }
    catch { return { raw: sink.text, data: null, ...flags, parseError: '返回内容不是合法 JSON，请返回完整可解析 JSON', usage: sink.usage }; }
  };
}
