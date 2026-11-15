import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const issuer = 'http://127.0.0.1:4324';
const redirect = 'http://127.0.0.1:4323/sign-in/id/callback';
export const localClientId = 'printhive-local';
const profiles = {
  organizer: { sub: 'local-organizer', given_name: 'Test', family_name: 'Organizer', email: 'organizer@purdue.edu', roles: ['organizer'] },
  member: { sub: 'local-member', given_name: 'Test', family_name: 'ID Member', email: 'id-member@purdue.edu', roles: [] },
};

export function startLocalId() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = [{ ...publicKey.export({ format: 'jwk' }), kid: 'local', use: 'sig', alg: 'EdDSA' }];
  type Grant = { profile: typeof profiles[keyof typeof profiles]; nonce: string; challenge: string; expires: number };
  const codes = new Map<string, Grant>(), tokens = new Map<string, Grant>();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  return Bun.serve({
    hostname: '127.0.0.1', port: 4324, development: false,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/openid-configuration') return json({
        issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
        userinfo_endpoint: issuer + '/userinfo', jwks_uri: issuer + '/jwks', response_types_supported: ['code'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['EdDSA'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      });
      if (url.pathname === '/jwks') return json({ keys });
      if (url.pathname === '/authorize') {
        const query = url.searchParams;
        const nonce = query.get('nonce'), state = query.get('state'), challenge = query.get('code_challenge');
        if (query.get('client_id') !== localClientId || query.get('redirect_uri') !== redirect ||
          query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' ||
          !nonce || !state || !challenge) return json({ error: 'invalid_request' }, 400);
        if (request.method === 'GET') return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1"><title>Local Purdue Hackers ID</title>
          <style>body{font:1rem system-ui;max-width:32rem;margin:4rem auto;padding:1rem}button{display:block;margin:1rem 0;padding:.75rem}</style>
          <h1>Local Purdue Hackers ID</h1><p>Choose a test account for PrintHive.</p>
          <form method="post"><button name="profile" value="organizer">Sign in as organizer</button>
          <button name="profile" value="member">Sign in as ID member</button></form></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
        if (request.method !== 'POST' || request.headers.get('origin') !== issuer) return json({ error: 'invalid_request' }, 400);
        const selected = (await request.formData()).get('profile');
        const profile = selected === 'organizer' ? profiles.organizer : selected === 'member' ? profiles.member : null;
        if (!profile) return json({ error: 'invalid_request' }, 400);
        const code = randomUUID();
        codes.set(code, { profile, nonce, challenge, expires: Date.now() + 60000 });
        const target = new URL(redirect);
        target.search = new URLSearchParams({ state, code, iss: issuer }).toString();
        return Response.redirect(target, 303);
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        const code = form.get('code') ?? '', grant = codes.get(code);
        codes.delete(code);
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!grant || grant.expires <= Date.now() || challenge !== grant.challenge ||
          form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== localClientId ||
          form.get('redirect_uri') !== redirect) return json({ error: 'invalid_grant' }, 400);
        const accessToken = randomUUID();
        tokens.set(accessToken, { ...grant, expires: Date.now() + 60000 });
        const now = Math.floor(Date.now() / 1000);
        const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const claims = { iss: issuer, aud: localClientId, sub: grant.profile.sub, nonce: grant.nonce, iat: now, exp: now + 60 };
        const jwt = encode({ alg: 'EdDSA', kid: 'local' }) + '.' + encode(claims);
        return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 60,
          id_token: jwt + '.' + sign(null, Buffer.from(jwt), privateKey).toString('base64url') });
      }
      if (url.pathname === '/userinfo') {
        const token = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
        const grant = tokens.get(token);
        tokens.delete(token);
        return grant && grant.expires > Date.now() ? json({ ...grant.profile, email_verified: true })
          : json({ error: 'invalid_token' }, 401);
      }
      return json({ error: 'not_found' }, 404);
    },
  });
}
