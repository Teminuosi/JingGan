import fs from 'node:fs/promises';
import { parsePlanningResponse } from './contract.mjs';
import { newSink, readSseText } from './stream.mjs';

export function validateConnection(connection) {
  const url = new URL(connection.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || /(?:localhost|\.local)$/.test(url.hostname)) throw new Error('分析服务地址必须为公开 HTTPS 地址');
  if (typeof connection.apiKey !== 'string' || !connection.apiKey.trim() || /[\r\n]/.test(connection.apiKey)) throw new Error('缺少分析 Key');
  if (!/^[a-zA-Z0-9._-]+$/.test(connection.model)) throw new Error('请选择 Gemini 原生视频分析模型');
  return { baseUrl: url.origin, apiKey: connection.apiKey, model: connection.model };
}

export function createGemini(connection, { fetchImpl = fetch, onCall = () => {} } = {}) {
  const c = validateConnection(connection);
  return async ({ prompt, videos = [], schema, signal }) => {
    const parts = [];
    for (const file of videos) {
      const bytes = await fs.readFile(file);
      if (bytes.length > 12 * 1024 * 1024) throw new Error('单段视频超过 12MB，未提交模型');
      parts.push({ inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') }, videoMetadata: { fps: 8 } });
    }
    parts.push({ text: prompt });
    const startedAt = Date.now();
    await onCall({ stage: 'submitting', model: c.model });
    // 带上 responseSchema 时解码受结构约束，语法上就吐不出不配对的括号——
    // 「42k 字符里错两个闭括号导致整单作废」那类事故的正手防线。
    // 走 streamGenerateContent 则是为了躲开 Cloudflare 100 秒的 524：
    // 实测一次编排调用要 75.97 秒，非流式几乎顶到阈值。
    const submit = async ({ withSchema, stream }) => fetchImpl(`${c.baseUrl}/v1beta/models/${c.model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15 * 60 * 1000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}`, 'x-goog-api-key': c.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 32768, ...(withSchema ? { responseSchema: schema } : {}), ...(videos.length ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}) } }),
    });
    // Do not automatically retry ambiguous paid requests after connection loss.
    // 下面两处回退都只在 4xx「请求被拒、未生成、未计费」时发生，不会重复扣费；
    // 且都会记下标记往上报——静默降级等于骗人。
    let streamed = true, schemaRejected = false;
    let response = await submit({ withSchema: Boolean(schema), stream: true });
    if (schema && response.status === 400) { schemaRejected = true; response = await submit({ withSchema: false, stream: true }); }
    if (response.status === 400 || response.status === 404) { streamed = false; response = await submit({ withSchema: schema && !schemaRejected, stream: false }); }
    if (!response.ok) throw new Error(`视频分析服务返回 HTTP ${response.status}；请查看中转请求记录，未自动重发`);

    const flags = { schemaRejected, streamed };
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
