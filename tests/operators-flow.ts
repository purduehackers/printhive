import assert from 'node:assert/strict';

export async function operatorsFlow(origin: string, cookie: string) {
  const request = (path: string, method = 'GET', body?: unknown, session = cookie, requestOrigin = origin) => fetch(origin + path, {
    method, headers: { Origin: requestOrigin, Cookie: session, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const signIn = async (username: string, password: string, status = 200) => {
    const response = await request('/api/login', 'POST', { username, password }, '');
    assert.equal(response.status, status, await response.clone().text());
    return response.headers.get('set-cookie')?.split(';')[0] ?? '';
  };
  assert.equal((await request('/operator/manage-operators', 'GET', undefined, '')).status, 302);
  assert.equal((await request('/api/operators', 'GET', undefined, '')).status, 401);
  for (const [path, method] of [['/api/operators', 'POST'], ['/api/operators/1', 'PATCH'], ['/api/operators/1', 'DELETE']]) {
    assert.equal((await request(path, method, {}, '')).status, 401);
    assert.equal((await request(path, method, {}, cookie, 'https://evil.test')).status, 403);
  }
  const listed = await request('/api/operators');
  assert.equal(listed.status, 200);
  const initial = await listed.json();
  assert.equal(initial.length, 1);
  assert.deepEqual(Object.keys(initial[0]).sort(), ['id', 'username']);
  const original = initial[0];
  assert.equal((await request('/api/operators', 'POST', null)).status, 400);
  assert.equal((await request('/api/operators', 'POST', { username: 'second', password: 'short' })).status, 400);
  const added = await request('/api/operators', 'POST', { username: 'second', password: 'second-password-123' });
  assert.equal(added.status, 201, await added.clone().text());
  const { operator: second } = await added.json();
  assert.deepEqual(Object.keys(second).sort(), ['id', 'username']);
  assert.equal((await request('/api/operators', 'POST', { username: 'second', password: 'different-password' })).status, 409);
  const secondCookie = await signIn('second', 'second-password-123');
  assert.equal((await request('/operator/manage-operators', 'GET', undefined, secondCookie)).status, 200);
  assert.equal((await request(`/api/operators/${second.id}`, 'PATCH', { username: 'renamed', password: '' })).status, 200);
  assert.equal((await request('/api/operators', 'GET', undefined, secondCookie)).status, 200);
  assert.equal((await request(`/api/operators/${second.id}`, 'PATCH', { username: 'renamed', password: 'replacement-password' })).status, 200);
  assert.equal((await request('/api/operators', 'GET', undefined, secondCookie)).status, 401);
  await signIn('renamed', 'second-password-123', 401);
  const resetCookie = await signIn('renamed', 'replacement-password');
  assert.equal((await request(`/api/operators/${second.id}`, 'DELETE')).status, 200);
  assert.equal((await request('/api/operators', 'GET', undefined, resetCookie)).status, 401);
  await signIn('renamed', 'replacement-password', 401);
  const lastRemoval = await request(`/api/operators/${original.id}`, 'DELETE');
  assert.equal(lastRemoval.status, 409);
  assert.match((await lastRemoval.json()).error, /last active operator/);
  // Reactivation uses fresh credentials and does not revive any prior session.
  const restored = await request('/api/operators', 'POST', { username: 'renamed', password: 'restored-password' });
  assert.equal(restored.status, 201);
  assert.equal((await restored.json()).operator.id, second.id);
  assert.equal((await request('/api/operators', 'GET', undefined, resetCookie)).status, 401);
  const restoredCookie = await signIn('renamed', 'restored-password');
  const selfRemove = await request(`/api/operators/${second.id}`, 'DELETE', undefined, restoredCookie);
  assert.equal(selfRemove.status, 200);
  assert.equal((await selfRemove.json()).signInRequired, true);
  assert.equal((await request('/api/operators', 'GET', undefined, restoredCookie)).status, 401);
  const selfReset = await request(`/api/operators/${original.id}`, 'PATCH', { username: original.username, password: 'changed-own-password' });
  assert.equal(selfReset.status, 200);
  assert.equal((await selfReset.json()).signInRequired, true);
  assert.equal((await request('/api/operators', 'GET', undefined, cookie)).status, 401);
  const newCookie = await signIn(original.username, 'changed-own-password');
  assert.deepEqual(await (await request('/api/operators', 'GET', undefined, newCookie)).json(), [original]);
  console.log('Operator management passed: authorization, CSRF, create/edit/remove, session revocation, reactivation, and last-operator protection.');
}
