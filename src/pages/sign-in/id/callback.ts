import type { APIRoute } from 'astro';
import { completeIdSignIn, idSignInRetry } from '../../../lib/server/purdue-id';
import { logFailure } from '../../../lib/server/log';

export const GET: APIRoute = async context => {
  const next = idSignInRetry(context);
  try {
    return await completeIdSignIn(context);
  } catch (error) {
    logFailure('member.id_callback_failed', error);
    return context.redirect('/sign-in?' + new URLSearchParams({ id_error: '1', next }), 303);
  }
};
