import { assertLocalRelay, forwardRelay } from '../../../lib/server/relay';
import { apiError, requireOwner } from '../../../lib/server/auth';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    assertLocalRelay(request);
    await requireOwner(request);
    const form = await request.formData();
    if (!(form.get('image') instanceof File) || !form.get('model') || !form.get('prompt')) return Response.json({ error: '改图需要原图、模型和修改要求。' }, { status: 400 });
    return await forwardRelay(request, '/v1/images/edits', form);
  } catch (error) {
    if (error instanceof Error && ['unauthorized', 'auth_not_configured', 'auth_unavailable', 'auth_profile_missing', 'account_banned', 'account_changed'].includes(error.message)) return apiError(error);
    return Response.json({ error: '改图请求格式无效。' }, { status: 400 });
  }
}
