import type { APIContext } from 'astro';
import * as oidc from 'openid-client';
import { config } from './config';
import { invariant } from './errors';
import { signInWithId } from './member-auth';
import { normalizeEmail } from './validation';

const ISSUER = new URL('https://id.purduehackers.com/api/auth');
const TRANSACTION_COOKIE = 'printhive_id_transaction';
const CALLBACK_PATH = '/sign-in/id/callback';
const SCOPES = 'openid profile email roles';

let discovered: Promise<oidc.Configuration> | undefined;
function provider() {
  const clientId = process.env.PURDUE_HACKERS_CLIENT_ID;
  const secret = process.env.PURDUE_HACKERS_CLIENT_SECRET;
  invariant(clientId, 503, 'Purdue Hackers ID sign-in is not configured.');
  const isLocalTest = process.env.NODE_ENV === 'test' && process.env.PRINTHIVE_LOCAL_ID === 'true'
    && config().origin === 'http://127.0.0.1:4323';
  const issuer = isLocalTest ? new URL('http://127.0.0.1:4324') : ISSUER;
  discovered ??= oidc.discovery(issuer, clientId, undefined,
    secret ? oidc.ClientSecretPost(secret) : oidc.None(),
    { execute: isLocalTest ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
      : [oidc.enableNonRepudiationChecks], timeout: 10 },
  ).catch(error => {
    discovered = undefined;
    throw error;
  });
  return discovered;
}

export function afterSignIn(value: string | null) {
  return value === '/submit' || value === '/operator' || value === '/manage-prints' ? value : '/';
}

export function idSignInRetry(context: APIContext) {
  try {
    const cookie = context.cookies.get(TRANSACTION_COOKIE)?.value;
    return afterSignIn(cookie ? JSON.parse(cookie).next : null);
  } catch {
    return '/';
  }
}

export async function startIdSignIn(context: APIContext, returnTo: string | null) {
  const server = await provider();
  const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(server, {
    redirect_uri: config().origin + CALLBACK_PATH,
    scope: SCOPES,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  context.cookies.set(TRANSACTION_COOKIE, JSON.stringify({ verifier, state, nonce, next: afterSignIn(returnTo) }), {
    path: CALLBACK_PATH, maxAge: 600, sameSite: 'lax', httpOnly: true, secure: config().production,
  });
  return context.redirect(url.href, 303);
}

export async function completeIdSignIn(context: APIContext) {
  const cookie = context.cookies.get(TRANSACTION_COOKIE)?.value;
  context.cookies.delete(TRANSACTION_COOKIE, { path: CALLBACK_PATH });
  invariant(cookie, 400, 'This sign-in attempt expired. Start again.');
  const { verifier, state, nonce, next } = JSON.parse(cookie);
  invariant([verifier, state, nonce].every(value => typeof value === 'string' && value.length > 0),
    400, 'This sign-in attempt is invalid. Start again.');
  const server = await provider();
  const url = new URL(CALLBACK_PATH + context.url.search, config().origin);
  const tokens = await oidc.authorizationCodeGrant(server, url, {
    pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce,
  });
  const claims = tokens.claims();
  invariant(claims?.sub, 401, 'Purdue Hackers ID did not return an account.');
  const info = await oidc.fetchUserInfo(server, tokens.access_token, claims.sub);
  const email = info.email_verified === true ? normalizeEmail(info.email) : null;
  const organizer = Array.isArray(info.roles) && info.roles.includes('organizer');
  const profileName = info.name || [info.given_name, info.family_name].filter(Boolean).join(' ') || info.preferred_username;
  const displayName = typeof profileName === 'string' ? profileName.trim().slice(0, 100) : undefined;
  await signInWithId(context, claims.sub, email, organizer, displayName);
  return context.redirect(afterSignIn(next), 303);
}
