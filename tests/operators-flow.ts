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

  // Materials & colours flow
  assert.equal((await request('/operator/manage-materials', 'GET', undefined, '')).status, 302);
  assert.equal((await request('/operator/manage-materials', 'GET', undefined, newCookie)).status, 200);

  // Public can view materials
  const publicMats = await request('/api/materials', 'GET', undefined, '');
  assert.equal(publicMats.status, 200);
  const initialMats = await publicMats.json();
  assert.equal(initialMats.some((m: { name: string }) => m.name === 'PLA'), true);

  // Unauthorized cannot mutate materials
  assert.equal((await request('/api/materials', 'POST', { name: 'PETG' }, '')).status, 401);
  assert.equal((await request('/api/materials', 'POST', { name: 'PETG' }, newCookie, 'https://evil.test')).status, 403);

  // Add material
  const addMatRes = await request('/api/materials', 'POST', { name: 'PETG', colors: [{ name: 'clear', code: '#e2e8f0' }] }, newCookie);
  assert.equal(addMatRes.status, 201);
  const { material: petg } = await addMatRes.json();
  assert.equal(petg.name, 'PETG');
  assert.equal(petg.colors[0].name, 'clear');

  // Add colour to material
  const addColRes = await request(`/api/materials/${petg.id}/colors`, 'POST', { name: 'black', code: '#353832' }, newCookie);
  assert.equal(addColRes.status, 201);
  const { color: petgBlack } = await addColRes.json();
  assert.equal(petgBlack.name, 'black');

  // Set default material & colour (with auth and CSRF checks)
  assert.equal((await request(`/api/materials/${petg.id}/default`, 'POST', undefined, '')).status, 401);
  assert.equal((await request(`/api/materials/${petg.id}/default`, 'POST', undefined, newCookie, 'https://evil.test')).status, 403);
  const setDefMatRes = await request(`/api/materials/${petg.id}/default`, 'POST', undefined, newCookie);
  assert.equal(setDefMatRes.status, 200);
  const { materials: afterDefMat } = await setDefMatRes.json();
  assert.equal(afterDefMat.find((m: { id: number }) => m.id === petg.id).is_default, true);

  assert.equal((await request(`/api/materials/${petg.id}/colors/${petgBlack.id}/default`, 'POST', undefined, '')).status, 401);
  const setDefColRes = await request(`/api/materials/${petg.id}/colors/${petgBlack.id}/default`, 'POST', undefined, newCookie);
  assert.equal(setDefColRes.status, 200);
  const { materials: afterDefCol } = await setDefColRes.json();
  assert.equal(
    afterDefCol.find((m: { id: number }) => m.id === petg.id).colors.find((c: { id: number }) => c.id === petgBlack.id).is_default,
    true,
  );

  // Delete colour (which was default, promoting 'clear' back to default)
  const delColRes = await request(`/api/materials/${petg.id}/colors/${petgBlack.id}`, 'DELETE', undefined, newCookie);
  assert.equal(delColRes.status, 200);

  // Cannot delete last colour
  const delLastColRes = await request(`/api/materials/${petg.id}/colors/${petg.colors[0].id}`, 'DELETE', undefined, newCookie);
  assert.equal(delLastColRes.status, 400);

  // Delete material
  const delMatRes = await request(`/api/materials/${petg.id}`, 'DELETE', undefined, newCookie);
  assert.equal(delMatRes.status, 200);

  console.log('Operator management passed: authorization, CSRF, create/edit/remove, session revocation, reactivation, materials/colours, and last-operator protection.');
}
