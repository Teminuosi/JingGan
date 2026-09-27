export const RELAY_HOSTS = new Set(['heyroute.ai', 'api.heyroute.ai', 'aheapi.com', 'www.aheapi.com']);

export function relayOrigin(base: string): string {
  const url = new URL(base);
  if (url.protocol !== 'https:' || !RELAY_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('请填写 HeyRoute 的 HTTPS 站点地址或 /v1 地址，不要填写具体接口或携带密钥。');
  }
  return url.origin;
}

export function redactRelayError(value: string, key = '', maxLength = 600): string {
  return (key ? value.split(key).join('[密钥已隐藏]') : value)
    .replace(/sk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]')
    .replace(/AIza[A-Za-z0-9_-]+/g, '[密钥已隐藏]').slice(0, maxLength);
}

export function textFromResult(value: unknown): string {
  const contentText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => part && ['text', 'output_text', undefined].includes(part.type) && typeof part.text === 'string' ? part.text : '').join('');
  };
  const extract = (input: unknown, depth: number): string => {
    if (depth > 5 || !input || typeof input !== 'object') return '';
    const data = input as Record<string, unknown>;
    if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const chat = contentText(choices[0]?.message?.content) || contentText(choices[0]?.text);
    if (chat.trim()) return chat;
    const output = Array.isArray(data.output) ? data.output : [];
    const text = output.filter(item => !item.type || item.type === 'message').map(item => contentText(item.content)).join('');
    if (text.trim()) return text;
    for (const key of ['response', 'data', 'result']) {
      const nested = extract(data[key], depth + 1);
      if (nested.trim()) return nested;
    }
    return '';
  };
  return extract(value, 0);
}

export function requireRelayText(value: unknown): string {
  const text = textFromResult(value);
  if (text.trim()) return text;
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const summary = redactRelayError(JSON.stringify({ fields: Object.keys(root), status: root.status, model: root.model, incomplete_details: root.incomplete_details }));
  throw new Error(`已收到中转返回，但未读到故事正文（不是 DNA 校验错误）。${summary}。请下载本次返回诊断；不要连续重新生成。`);
}

export async function readRelayResponse(response: Response, onEvent: (event: string) => void = () => {}): Promise<unknown> {
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try { const json = JSON.parse(raw); detail = typeof json.error === 'string' ? json.error : json.error?.message || json.message || `HTTP ${response.status}`; if (json.requestId) detail += `（请求 ID：${json.requestId}）`; } catch { detail = `HTTP ${response.status}`; }
    throw new Error(redactRelayError(`中转请求失败：${response.status} ${detail}`));
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  if (!response.body) throw new Error('中转没有返回数据流。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const finishedParts = new Map<string, string>();
  let complete: unknown;
  let normalEnd = false;
  const consume = (block: string) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || '';
    const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!raw) return;
    if (raw === '[DONE]') { normalEnd = true; return; }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('中转数据流格式错误，结果尚不能确认，请勿立即重复扣费提交。'); }
    const type = data.type?.startsWith('response.') ? data.type : event || data.type || data.event || '';
    onEvent(type);
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete' || data.error) throw new Error(redactRelayError(data.error?.message || data.message || data.response?.error?.message || '中转生成失败或输出不完整。'));
    if (type === 'completed') complete = data.data && !Array.isArray(data.data) ? data.data : data;
    if (type === 'response.completed') complete = data.response ?? data;
    if (type === 'response.output_text.delta') text += data.delta || '';
    if (type === 'response.output_text.done' && typeof data.text === 'string') finishedParts.set(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.text);
    if (data.choices?.[0]?.delta?.content) text += data.choices[0].delta.content;
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('文本输出达到长度限制，返回内容不完整。已保留上一版结果。');
    if (data.choices?.[0]?.finish_reason === 'stop') normalEnd = true;
  };
  try {
    while (complete === undefined) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consume(block);
        if (complete !== undefined) break;
      }
      if (chunk.done) { if (buffer.trim()) consume(buffer); break; }
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (complete !== undefined) {
    const streamedText = text || [...finishedParts.values()].join('');
    if (!textFromResult(complete).trim() && streamedText.trim() && complete && typeof complete === 'object') return { ...complete, output_text: streamedText };
    return complete;
  }
  if (text && normalEnd) return { output_text: text };
  throw new Error('连接结束，但未收到完成结果；可能仍在计费处理中，请先查看中转使用日志，不要连续重试。');
}
