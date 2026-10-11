// SSE 读取：把 streamGenerateContent 的分片拼回完整文本。
//
// 编排调用使用流式，减少等待整份 JSON 生成完才开始接收的风险。
// 流式不能保证避免 524：上游排队或思考期间不发首包，仍可能撞上中转的等待上限。
// 此时不知道上游到底生成完没有、有没有计费，不能自动重发。
// 分析链路（app/lib/gemini.ts）早就因为同样的 524 改成了流式，这里补上。
//
// 流式的第二个好处：半路断了，手里已经有一截文本，存下来至少能看出断在哪。

/** 一个分片里真正的正文。thought 分片是模型的思考过程，不是结果，不能拼进去。 */
const textOf = candidate => (candidate?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('');

/**
 * 读完整条 SSE 流。
 * @param body web ReadableStream
 * @param sink 累加器，调用方持有——半路抛错时也能拿到已收到的部分
 */
export async function readSseText(body, sink) {
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = flush => {
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      consume(line);
    }
    if (flush && buffer.trim()) { consume(buffer.trim()); buffer = ''; }
  };
  const consume = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let value;
    // 单个分片解析不了就跳过：它是传输层的残片，不代表整体结果坏了。
    try { value = JSON.parse(payload); } catch { return; }
    const candidate = value.candidates?.[0];
    const piece = textOf(candidate);
    if (piece) { sink.text += piece; sink.chunks += 1; }
    if (candidate?.finishReason) sink.finishReason = candidate.finishReason;
    if (value.usageMetadata) sink.usage = value.usageMetadata;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
  return sink;
}

export const newSink = () => ({ text: '', chunks: 0, usage: undefined, finishReason: undefined });
