import { apiError, noStoreJson } from '../../../lib/server/auth';
import { assertLocalClaim, verifiedUser } from '../../../lib/server/auth-session';
import { claimLocalProjects, listProjects } from '../../../lib/server/project-store';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    assertLocalClaim(request);
    const owner = (await verifiedUser(request)).id;
    if (request.headers.get('x-mirror-account-id') && request.headers.get('x-mirror-account-id') !== owner) throw new Error('account_changed');
    const input = await request.json() as { action?: string; ids?: unknown };
    if (input.action === 'list') return noStoreJson({ projects: await listProjects('local_seedy') });
    if (input.action !== 'claim' || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) return noStoreJson({ error: '请选择需要认领的本机项目。' }, { status: 400 });
    await claimLocalProjects(owner, [...new Set(input.ids)] as string[]);
    return noStoreJson({ projects: await listProjects(owner) });
  } catch (error) { return apiError(error); }
}
