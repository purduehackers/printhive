import type { APIRoute } from 'astro';
import { clientIP, errorResponse, json, rateLimit, smallBody } from '../../lib/server/http';
import { reserve, reserveBatch, upload, finalizeBatch, publicQueue, updateStatus, batchUpdateStatus, updateJobGroup } from '../../lib/server/jobs';
import { login, logout, requireOperator } from '../../lib/server/auth';
import { db } from '../../lib/server/db';
import { filePath } from '../../lib/server/storage';
import { invariant } from '../../lib/server/errors';
import { reference } from '../../lib/shared';
import { addOperator, editOperator, listOperators, removeOperator } from '../../lib/server/operators';
import { addColor, addMaterial, listMaterialsWithColors, removeColor, removeMaterial, setDefaultColor, setDefaultMaterial } from '../../lib/server/materials';
import { VERIFIED_EMAIL_COOKIE, getVerifiedEmail, unseal } from '../../lib/server/tokens';
import { storeThumbnail, readThumbnail } from '../../lib/server/thumbnails';
import { createSlicerProject, downloadSlicerProject } from '../../lib/server/slicer-export';
import { operatorQueue } from '../../lib/server/jobs';
import { pushStatus, subscribeDevice, revokeDevice, testDevice } from '../../lib/server/push';

export const ALL: APIRoute = async (context) => {
  const { request, params } = context, path = params.path ?? '', method = request.method;
  try {
    if (path === 'queue' && method === 'GET') return json(await publicQueue());
    if (path === 'operator/queue' && method === 'GET') {
      await requireOperator(context);
      const query = new URL(request.url).searchParams;
      return json(await operatorQueue(query.get('status'), query.get('page')));
    }
    if (path === 'push' && ['GET', 'POST', 'DELETE'].includes(method)) {
      const operator = await requireOperator(context);
      if (method === 'GET') return json(await pushStatus(context, operator.id));
      rateLimit('push:' + operator.id, 30, 900000);
      if (method === 'POST') return json(await subscribeDevice(context, operator.id, await smallBody(request)), 201);
      await revokeDevice(context);
      return json({ enabled: false });
    }
    if (path === 'push/test' && method === 'POST') {
      const operator = await requireOperator(context);
      rateLimit('push-test:' + operator.id, 5, 900000);
      return json(await testDevice(context, operator.id));
    }
    if (path === 'health' && method === 'GET') {
      const sql = await db(); await sql`SELECT id FROM jobs LIMIT 1`;
      return json({ ok: true });
    }
    if (path === 'slicer-projects' && method === 'POST') {
      const operator = await requireOperator(context);
      rateLimit('slicer-export:' + operator.id, 20, 15 * 60 * 1000);
      return json(await createSlicerProject(await smallBody(request), request.signal, request), 201);
    }
    if (path === 'slicer-projects' && method === 'GET') {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      return await downloadSlicerProject(token, request);
    }
    if (path === 'verified-email' && method === 'DELETE') {
      context.cookies.delete(VERIFIED_EMAIL_COOKIE, { path: '/' });
      return json({ ok: true });
    }
    if (path === 'submissions' && method === 'POST') {
      rateLimit('submit:' + clientIP(context), 15, 3600000);
      const body = await smallBody(request);
      return json(await reserve(body, { verifiedEmail: getVerifiedEmail(context) }), 201);
    }
    if (path === 'submissions/batch' && method === 'POST') {
      rateLimit('submit:' + clientIP(context), 15, 3600000);
      const body = await smallBody(request);
      return json(await reserveBatch(body, { verifiedEmail: getVerifiedEmail(context) }), 201);
    }
    if (path === 'submissions/batch/finalize' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      return json(await finalizeBatch(token, undefined, { verifiedEmail: getVerifiedEmail(context) }));
    }
    const uploadMatch = /^submissions\/([a-f0-9-]{36})\/file$/.exec(path);
    const thumbnailUpload = /^submissions\/([a-f0-9-]{36})\/thumbnail$/.exec(path);
    if (thumbnailUpload && method === 'PUT') {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      await storeThumbnail(thumbnailUpload[1], token, request);
      return json({ ok: true });
    }
    const thumbnailRead = /^print-thumbnails\/([a-f0-9-]{36})$/.exec(path);
    if (thumbnailRead && method === 'GET') {
      const token = new URL(request.url).searchParams.get('token');
      if (token) invariant(unseal(token, 'thumbnail').id === thumbnailRead[1], 403, 'This thumbnail belongs to another print.');
      else await requireOperator(context);
      return await readThumbnail(thumbnailRead[1], token ? undefined : request);
    }
    if (uploadMatch && method === 'PUT') {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const deferEmail = new URL(request.url).searchParams.get('batch') === '1';
      return json(await upload(uploadMatch[1], token, request, undefined, { deferEmail, verifiedEmail: getVerifiedEmail(context) }));
    }
    if (path === 'login' && method === 'POST') {
      rateLimit('login:' + clientIP(context), 10, 900000);
      const body = await smallBody(request);
      invariant(body && typeof body === 'object', 400, 'Invalid login.');
      rateLimit('account:' + String(body.username).toLowerCase().slice(0, 64), 20, 900000);
      await login(context, body.username, body.password);
      return json({ ok: true });
    }
    if (path === 'logout' && method === 'POST') {
      await logout(context); return context.redirect('/operator/login', 303);
    }
    if (path === 'materials' && method === 'GET') {
      return json(await listMaterialsWithColors());
    }
    if (path === 'materials' && method === 'POST') {
      const actor = await requireOperator(context);
      rateLimit('materials:' + actor.id, 60, 900000);
      return json({ material: await addMaterial(actor.id, await smallBody(request)) }, 201);
    }
    const materialMatch = /^materials\/([1-9][0-9]*)$/.exec(path);
    if (materialMatch && method === 'DELETE') {
      const actor = await requireOperator(context), id = Number(materialMatch[1]);
      rateLimit('materials:' + actor.id, 60, 900000);
      await removeMaterial(actor.id, id);
      return json({ ok: true, materials: await listMaterialsWithColors() });
    }
    const materialDefaultMatch = /^materials\/([1-9][0-9]*)\/default$/.exec(path);
    if (materialDefaultMatch && ['POST', 'PATCH'].includes(method)) {
      const actor = await requireOperator(context), id = Number(materialDefaultMatch[1]);
      rateLimit('materials:' + actor.id, 60, 900000);
      return json({ materials: await setDefaultMaterial(actor.id, id) });
    }
    const materialColorMatch = /^materials\/([1-9][0-9]*)\/colors$/.exec(path);
    if (materialColorMatch && method === 'POST') {
      const actor = await requireOperator(context), materialId = Number(materialColorMatch[1]);
      rateLimit('materials:' + actor.id, 60, 900000);
      return json({ color: await addColor(actor.id, materialId, await smallBody(request)) }, 201);
    }
    const colorDeleteMatch = /^materials\/([1-9][0-9]*)\/colors\/([1-9][0-9]*)$/.exec(path);
    if (colorDeleteMatch && method === 'DELETE') {
      const actor = await requireOperator(context), materialId = Number(colorDeleteMatch[1]), colorId = Number(colorDeleteMatch[2]);
      rateLimit('materials:' + actor.id, 60, 900000);
      await removeColor(actor.id, materialId, colorId);
      return json({ ok: true, materials: await listMaterialsWithColors() });
    }
    const colorDefaultMatch = /^materials\/([1-9][0-9]*)\/colors\/([1-9][0-9]*)\/default$/.exec(path);
    if (colorDefaultMatch && ['POST', 'PATCH'].includes(method)) {
      const actor = await requireOperator(context), materialId = Number(colorDefaultMatch[1]), colorId = Number(colorDefaultMatch[2]);
      rateLimit('materials:' + actor.id, 60, 900000);
      return json({ materials: await setDefaultColor(actor.id, materialId, colorId) });
    }
    if (path === 'operators' && ['GET', 'POST'].includes(method)) {
      const actor = await requireOperator(context);
      if (method === 'GET') return json(await listOperators());
      rateLimit('operators:' + actor.id, 60, 900000);
      return json({ operator: await addOperator(actor.id, await smallBody(request)) }, 201);
    }
    const operatorMatch = /^operators\/([1-9][0-9]*)$/.exec(path);
    if (operatorMatch && ['PATCH', 'DELETE'].includes(method)) {
      const actor = await requireOperator(context), id = Number(operatorMatch[1]);
      invariant(Number.isSafeInteger(id), 400, 'Invalid operator ID.');
      rateLimit('operators:' + actor.id, 60, 900000);
      if (method === 'DELETE') {
        await removeOperator(actor.id, id);
        if (actor.id === id) await logout(context);
        return json({ ok: true, signInRequired: actor.id === id });
      }
      const body = await smallBody(request);
      const operator = await editOperator(actor.id, id, body);
      const signInRequired = actor.id === id && typeof body.password === 'string' && body.password !== '';
      if (signInRequired) await logout(context);
      return json({ operator, signInRequired });
    }
    const downloadMatch = /^jobs\/([a-f0-9-]{36})\/file$/.exec(path);
    if (downloadMatch && method === 'GET') {
      await requireOperator(context);
      const sql = await db();
      const [job] = await sql`SELECT storage_key, original_filename FROM jobs WHERE id = ${downloadMatch[1]} AND confirmed_at IS NOT NULL`;
      invariant(job, 404, 'Print not found.');
      const file = Bun.file(filePath(job.storage_key));
      invariant(await file.exists(), 404, 'The STL file is missing. Contact the administrator.');
      const safeStem = String(job.original_filename ?? 'part.stl').replace(/\.stl$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'part';
      return new Response(file.stream(), { headers: { 'Content-Type': 'application/octet-stream',
        'Content-Length': String(file.size), 'Content-Disposition': `attachment; filename="printhive-${reference(downloadMatch[1])}-${safeStem}.stl"`,
        'Cache-Control': 'no-store' } });
    }
    const statusMatch = /^jobs\/([a-f0-9-]{36})\/status$/.exec(path);
    if (statusMatch && method === 'POST') {
      const operator = await requireOperator(context), body = await smallBody(request);
      invariant(body && typeof body === 'object', 400, 'Invalid status update.');
      return json(await updateStatus(statusMatch[1], body.status, body.version, operator.id, { feedback: body.feedback }));
    }
    if (path === 'jobs/batch-status' && method === 'POST') {
      const operator = await requireOperator(context), body = await smallBody(request);
      invariant(body && typeof body === 'object', 400, 'Invalid status update.');
      rateLimit('status:' + operator.id, 120, 900000);
      const items = (body as any).items ?? (body as any).ids;
      return json(await batchUpdateStatus(items, (body as any).status, operator.id, { feedback: (body as any).feedback }));
    }
    if (path === 'jobs/group' && ['POST', 'PATCH'].includes(method)) {
      const operator = await requireOperator(context), body = await smallBody(request);
      invariant(body && typeof body === 'object', 400, 'Invalid group update.');
      rateLimit('group:' + operator.id, 120, 900000);
      return json(await updateJobGroup((body as any).ids, (body as any).group_name, operator.id, { ungroup: Boolean((body as any).ungroup) }));
    }
    return json({ error: 'Endpoint not found.' }, 404);
  } catch (error) { return errorResponse(error, request); }
};
