import { assertRelayAccess, forwardRelay } from '../../../lib/server/relay';
import { apiError, requireOwner } from '../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertRelayAccess(request);
    await requireOwner(request);
    const { kind, payload } = await request.json() as { kind: string; payload?: unknown };
    const paths: Record<string, string> = { models: '/v1/models', chat: '/v1/chat/completions', responses: '/v1/responses', image: '/v1/images/generations', video: '/v1/videos' };
    // 视频是异步任务：提交拿 task_id，再轮询状态。任务 id 只允许安全字符，避免拼出别的上游路径。
    if (kind === 'video_task') {
      const taskId = String((payload as { taskId?: string })?.taskId ?? '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) return Response.json({ error: '任务 ID 格式无效。' }, { status: 400 });
      return await forwardRelay(request, `/v1/videos/${taskId}`, null, 'GET', { 'Content-Type': 'application/json' });
    }
    // 中转累计用量。实测 heyroute 只对 API Key 开放两个只读接口：
    // /v1/dashboard/billing/usage 给累计消耗总数，/v1/dashboard/billing/subscription 给额度与有效期；
    // 逐条调用日志（/api/log/self）要用户会话，拿 sk- Key 读不到，所以明细只能自己在本地记。
    // 累计数当里程表用：付费动作前后各读一次，差值就是这一次真实扣了多少——失败的调用也能查出扣没扣。
    if (kind === 'usage') {
      const usage = await forwardRelay(request, '/v1/dashboard/billing/usage', null, 'GET', { 'Content-Type': 'application/json' });
      if (!usage.ok) return usage;
      const quota = await forwardRelay(request, '/v1/dashboard/billing/subscription', null, 'GET', { 'Content-Type': 'application/json' });
      const used = await usage.json() as { total_usage?: number };
      const limits = quota.ok ? await quota.json() as { hard_limit_usd?: number; access_until?: number } : {};
      return Response.json({ totalUsage: used.total_usage ?? null, hardLimitUsd: limits.hard_limit_usd ?? null, accessUntil: limits.access_until ?? null });
    }
    if (!Object.hasOwn(paths, kind)) return Response.json({ error: '未知的中转操作。' }, { status: 400 });
    return await forwardRelay(request, paths[kind], kind === 'models' ? null : JSON.stringify(payload), kind === 'models' ? 'GET' : 'POST', { 'Content-Type': 'application/json' });
  } catch (error) {
    if (error instanceof Error && ['unauthorized', 'auth_not_configured', 'auth_unavailable', 'auth_profile_missing', 'account_banned', 'account_changed'].includes(error.message)) return apiError(error);
    return Response.json({ error: '中转请求无效或来源不允许。' }, { status: 400 });
  }
}
