'use client';
import { useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { loadConnection, relayRequest, roles } from '../lib/relay-client';
import { redactRelayError, requireRelayText } from '../lib/relay-protocol';

/**
 * 失败提示下面的「AI 帮我分析原因」：用户自己的文本模型把报错翻译成「为什么 + 怎么办 + 有没有可能扣费」。
 * 只在点按钮时调用（花一点 token），报错里的密钥先抹掉再发。
 * 镜感已知的失败原因写进提示词当底稿，让模型照事实说，而不是自己猜。
 */
const KNOWN_CAUSES = `镜感已知的失败原因（只在和报错对得上时引用）：
- 413 / Payload Too Large：单次请求超过约 100MB（Cloudflare 上限）。分析视频是整段 base64 发出去的，原片超过 45MB 镜感会先自动压缩；仍失败说明视频太长，要先剪短或导出 480p。还没计费。
- 524 / A timeout occurred：中转等上游超过 100 秒没返回被断开。可能已计费，先查中转站使用日志；调低「思考强度」或剪短视频再试。
- 502 / 503：中转站或上游临时不可用，一般未计费，等一两分钟或换模型。
- 401 / 403 / API Key 无效：「AI 服务设置」里的 Key 填错、过期、余额不足或没有该模型权限。
- 429 / quota / rate limit：限流或额度不足，稍后再试或换模型。
- Failed to fetch / 网络：本机网络、代理或中转站地址不通。
- IMAGE_SAFETY / 安全策略：角色描述里有真人名、品牌仿制或像未成年人的描述。
- 传输途中断了 / JSON 不完整：流式返回断在半路，可能已计费，先在上传页「已经有分析结果？」恢复，别直接重试。
- 未登录 / unauthorized：登录过期，重新登录（博客账号可直接登录）。`;

/** 报错会发给「文本」角色的中转，可能和分析/出图不是同一家，所以四个角色存的 Key 原文都要抹掉。 */
function redact(text: string) {
  let out = text;
  for (const role of roles) {
    const key = loadConnection(role).apiKey.trim();
    if (key.length >= 6) out = out.split(key).join('[密钥已隐藏]');
  }
  return redactRelayError(out, '', 8000)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [密钥已隐藏]')
    .replace(/(api[_-]?key|token|authorization|x-goog-api-key|x-relay-key)(["'=:\s]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2[密钥已隐藏]');
}

export function ErrorDiagnose({ stage, error, context }: { stage: string; error: string; context?: Record<string, string | number | undefined> }) {
  const [busy, setBusy] = useState(false);
  // 答案记住是对哪条报错的：换了一条报错，旧答案自动不显示，免得挂在新错误下面。
  const [result, setResult] = useState<{ for: string; answer?: string; failure?: string }>({ for: '' });
  if (!error) return null;
  const answer = result.for === error ? result.answer ?? '' : '';
  const failure = result.for === error ? result.failure ?? '' : '';
  const setFailure = (text: string) => setResult({ for: error, failure: text });

  const run = async () => {
    if (!loadConnection('text').apiKey || !loadConnection('text').model) {
      setFailure('要先在右上角「AI 服务设置」里配好文本模型，才能用 AI 分析原因。');
      return;
    }
    setBusy(true); setResult({ for: '' });
    try {
      const lines = Object.entries(context ?? {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `- ${k}：${v}`).join('\n');
      const prompt = `你是「镜感」（AI 视频复刻网站）的客服技术支持。用户在「${stage}」这一步失败了，看不懂报错。请用大白话中文回答，总共不超过 180 字，分三行：
原因：一句话说清楚是什么问题（别复述英文原文）
怎么办：给 1–3 个具体能照做的步骤
扣费：这次大概率扣没扣费（说不准就说「不确定，请看中转站使用日志」）
不要编造报错里没有的信息；对不上已知原因时就照报错字面推断，并说明是推断。

${KNOWN_CAUSES}

报错原文：
${redact(error).slice(0, 4000)}
${lines ? `\n当时的情况：\n${redact(lines)}` : ''}`;
      // 不走 runRelayTask：那是给付费主任务用的，会缓存结果、失败后再点会弹「可能已扣费」确认框，帮助按钮用不着这么重。
      const config = loadConnection('text');
      const payload = config.protocol === 'responses'
        ? { model: config.model, input: prompt, stream: true, max_output_tokens: 1200 }
        : { model: config.model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 1200 };
      const text = requireRelayText(await relayRequest(config, config.protocol, payload));
      setResult({ for: error, answer: text.trim() });
    } catch (cause) {
      setFailure(`AI 分析也没成功：${redact(cause instanceof Error ? cause.message : String(cause))}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-2">
      {!answer && <button type="button" onClick={() => void run()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200/25 bg-emerald-300/[0.08] px-3 py-1.5 text-xs text-emerald-100 transition hover:bg-emerald-300/[0.15] disabled:opacity-50">
        {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Sparkles size={12} />}{busy ? 'AI 正在分析原因…' : 'AI 帮我分析原因'}
      </button>}
      {answer && <div className="mt-1 whitespace-pre-wrap rounded-lg border border-emerald-200/20 bg-emerald-300/[0.06] px-3 py-2.5 text-xs leading-6 text-emerald-50/90"><p className="mb-1 flex items-center gap-1.5 font-semibold text-emerald-200"><Sparkles size={12} />AI 分析（仅供参考）</p>{answer}</div>}
      {failure && <p className="mt-1 text-xs leading-5 text-amber-100/80">{failure}</p>}
    </div>
  );
}
