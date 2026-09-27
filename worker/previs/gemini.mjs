import fs from 'node:fs/promises';
import { parsePlanningResponse } from './contract.mjs';

export function validateConnection(connection) {
  const url = new URL(connection.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || /(?:localhost|\.local)$/.test(url.hostname)) throw new Error('分析服务地址必须为公开 HTTPS 地址');
  if (typeof connection.apiKey !== 'string' || !connection.apiKey.trim() || /[\r\n]/.test(connection.apiKey)) throw new Error('缺少分析 Key');
  if (!/^[a-zA-Z0-9._-]+$/.test(connection.model)) throw new Error('请选择 Gemini 原生视频分析模型');
  return { baseUrl: url.origin, apiKey: connection.apiKey, model: connection.model };
}

export function createGemini(connection, { fetchImpl = fetch, onCall = () => {} } = {}) {
  const c = validateConnection(connection);
  return async ({ prompt, videos = [], signal }) => {
    const parts = [];
    for (const file of videos) {
      const bytes = await fs.readFile(file);
      if (bytes.length > 12 * 1024 * 1024) throw new Error('单段视频超过 12MB，未提交模型');
      parts.push({ inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') }, videoMetadata: { fps: 8 } });
    }
    parts.push({ text: prompt });
    await onCall({ stage: 'submitting', model: c.model });
    // Do not automatically retry ambiguous paid requests after connection loss.
    const response = await fetchImpl(`${c.baseUrl}/v1beta/models/${c.model}:generateContent`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15 * 60 * 1000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}`, 'x-goog-api-key': c.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 32768, ...(videos.length ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}) } }),
    });
    if (!response.ok) throw new Error(`视频分析服务返回 HTTP ${response.status}；请查看中转请求记录，未自动重发`);
    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('');
    await onCall({ stage: 'received', model: c.model, usage: result.usageMetadata, finishReason: result.candidates?.[0]?.finishReason });
    if (!text || result.candidates?.[0]?.finishReason === 'MAX_TOKENS') return { raw: text || '', data: null, parseError: '模型结果为空或被长度上限截断；请压缩关键帧数量但保留完整动作', usage: result.usageMetadata };
    try { return { raw: text, ...parsePlanningResponse(text), usage: result.usageMetadata }; }
    catch { return { raw: text, data: null, parseError: '返回内容不是合法 JSON，请返回完整可解析 JSON', usage: result.usageMetadata }; }
  };
}
