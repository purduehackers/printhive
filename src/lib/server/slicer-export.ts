import { mkdir, mkdtemp, rename, rm, readdir, stat, unlink } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { HttpError, invariant } from './errors';
import { filePath } from './storage';
import { seal, unseal } from './tokens';
import { parseSTL } from '../stl';
import { MAX_FILE_BYTES, reference, type Job } from '../shared';
import { EXPORT_TTL, MAX_EXPORT_JOBS, SLICERS, slicerLaunchUrl, type SlicerExportRequest, type SlicerExportResult, type SupportChoice } from '../slicer';
import { writeProjectZip, type ProjectEntry } from './project-zip';
import { objectSettings } from './slicer-settings';
import { logWarning } from './log';
import { appOrigin } from './http';
import { repairProjectMesh, meshVertices, meshTriangles, type ProjectMesh } from './slicer-mesh';

const MAX_INPUT_BYTES = MAX_FILE_BYTES;
const MAX_TRIANGLES = 5_000_000;
const GENERATION_TTL = 90_000;
let generating = false;
const xml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const directory = () => join(config().dataDir, 'slicer-exports');

export function exportRequest(input: unknown): SlicerExportRequest {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid slicer request.');
  const body = input as Record<string, unknown>;
  // Ignore the former printer field so already-open operator tabs can still export.
  invariant(Object.keys(body).every(key => ['ids', 'slicer', 'printer'].includes(key)), 400, 'Unsupported export option.');
  invariant(SLICERS.some(slicer => slicer.id === body.slicer), 400, 'Choose a supported slicer.');
  invariant(Array.isArray(body.ids) && body.ids.length > 0 && body.ids.length <= MAX_EXPORT_JOBS &&
    body.ids.every(id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) && new Set(body.ids).size === body.ids.length,
  400, `Choose between 1 and ${MAX_EXPORT_JOBS} different prints.`);
  return { ids: body.ids as string[], slicer: body.slicer as SlicerExportRequest['slicer'] };
}

export async function cleanupSlicerExports(now = Date.now()) {
  const dir = directory();
  for (const name of await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!/^[a-f0-9-]{36}\.3mf$/.test(name) && !/^building-[A-Za-z0-9_-]+$/.test(name)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info || info.mtimeMs > now - EXPORT_TTL - GENERATION_TTL) continue;
    if (name.startsWith('building-')) await rm(path, { recursive: true, force: true });
    else await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function downloadSlicerProject(token: string, request?: Request) {
  let id: string;
  try { id = unseal(token, 'slicer-export').id; }
  catch (error) {
    if (error instanceof HttpError) throw new HttpError(error.status, 'This project link is invalid or expired. Prepare the project again.');
    throw error;
  }
  const file = Bun.file(join(directory(), `${id}.3mf`));
  invariant(await file.exists(), 404, 'This project is no longer available. Prepare it again.');
  let start = 0, end = file.size - 1;
  const range = request?.headers.get('range');
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= file.size ||
      (match[2] && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) < Number(match[1]))))
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'no-store' } });
    start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end);
  }
  return new Response(file.slice(start, end + 1).stream(), { status: range ? 206 : 200, headers: {
    'Content-Type': 'model/3mf', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
    'Content-Disposition': `attachment; filename="printhive-${reference(id)}.3mf"`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}

interface ExportPart { job: Job; info: ProjectMesh; supports: SupportChoice; id: number; x: number; y: number }

// Spread copies out without assuming a printer's bed dimensions or changing scale.
function arrange(parts: ExportPart[]) {
  let x = 5;
  for (const part of parts) {
    part.x = x; part.y = 5;
    x += part.info.max[0] - part.info.min[0] + 6;
  }
}

async function writeModel(path: string, parts: ExportPart[], slicer: SlicerExportRequest['slicer'], check: () => void, meshOnly = false) {
  const prusa = slicer === 'prusa';
  const fd = openSync(path, 'wx', 0o600);
  let buffer = '';
  const emit = (text: string) => { buffer += text; if (buffer.length >= 65536) flush(); };
  const flush = () => { if (buffer) { const bytes = Buffer.from(buffer); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); buffer = ''; } };
  try {
    emit(`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"${!prusa && !meshOnly ? ' xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"' : ''}>`);
    emit(prusa ? '<metadata name="Application">PrusaSlicer-2.9.4</metadata><metadata name="slic3rpe:Version3mf">1</metadata>' :
      `<metadata name="Application">BambuStudio-${slicer === 'orca' ? '2.3.2' : '02.04.00.70'}</metadata><metadata name="BambuStudio:3mfVersion">1</metadata>`);
    // Orca 2.3.2 predates its dedicated version tag. Keep its native legacy marker;
    // newer Orca releases recognize this format too, while 2.3.2 rejects newer markers.
    emit('<resources>');
    const unique = parts.filter((part, index) => parts.findIndex(other => other.job.id === part.job.id) === index);
    if (!prusa && !meshOnly) {
      // Match the native production-extension layout. Older Orca assumes project
      // objects refer to a distinct mesh resource rather than containing the mesh.
      for (const part of unique) emit(`<object id="${part.id}" type="model" p:UUID="${randomUUID()}"><components><component p:path="/3D/Objects/part-${part.id}.model" objectid="${part.id - 1}" p:UUID="${randomUUID()}"/></components></object>`);
      emit('</resources><build>');
      for (const part of parts) emit(`<item objectid="${part.id}" transform="1 0 0 0 1 0 0 0 1 ${part.x} ${part.y} 0" printable="1" p:UUID="${randomUUID()}"/>`);
      emit('</build></model>'); flush(); return;
    }
    // Copies share geometry through build instances and retain their object's overrides.
    for (const part of unique) {
      emit(`<object id="${meshOnly ? part.id - 1 : part.id}" type="model" name="Print ${reference(part.job.id)}"><mesh><vertices>`);
      // Use Orca's repaired, shared vertex indices. Expanding STL face vertices
      // into separate 3MF indices would disconnect every face from its neighbors.
      await meshVertices(part.info, check, point => {
        const px = part.job.mirror ? part.info.max[0] - point[0] : point[0] - part.info.min[0];
        emit(`<vertex x="${px}" y="${point[1] - part.info.min[1]}" z="${point[2] - part.info.min[2]}"/>`);
      });
      emit('</vertices><triangles>');
      await meshTriangles(part.info, check, indices =>
        emit(`<triangle v1="${indices[0]}" v2="${indices[part.job.mirror ? 2 : 1]}" v3="${indices[part.job.mirror ? 1 : 2]}"/>`));
      emit('</triangles></mesh></object>');
    }
    emit('</resources><build>');
    if (!meshOnly) for (const part of parts) emit(`<item objectid="${part.id}" transform="1 0 0 0 1 0 0 0 1 ${part.x} ${part.y} 0" printable="1"/>`);
    emit('</build></model>'); flush();
  } finally { closeSync(fd); }
}

function modelSettings(parts: ExportPart[], request: SlicerExportRequest) {
  const prusa = request.slicer === 'prusa';
  const metadata = (key: string, value: string) => `<metadata ${prusa ? 'type="object" ' : ''}key="${xml(key)}" value="${xml(value)}"/>`;
  let result = '<?xml version="1.0" encoding="UTF-8"?><config>';
  const unique = parts.filter((part, index) => parts.findIndex(other => other.job.id === part.job.id) === index);
  for (const part of unique) {
    result += `<object id="${part.id}" instances_count="${part.job.copies}">`;
    result += metadata('name', `Print ${reference(part.job.id)}`);
    for (const [key, value] of Object.entries(objectSettings(part.job, part.supports, request.slicer))) result += metadata(key, value);
    result += prusa ? `<volume firstid="0" lastid="${part.info.triangles - 1}"/>` :
      `<part id="${part.id - 1}" subtype="normal_part"><metadata key="name" value="Print ${reference(part.job.id)}"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/></part>`;
    result += '</object>';
  }
  if (!prusa) {
    result += '<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="PrintHive"/><metadata key="locked" value="false"/>';
    const instances = new Map<number, number>();
    for (const part of parts) {
      const index = instances.get(part.id) ?? 0; instances.set(part.id, index + 1);
      result += `<model_instance><metadata key="object_id" value="${part.id}"/><metadata key="instance_id" value="${index}"/><metadata key="identify_id" value="${part.id * 100 + index}"/></model_instance>`;
    }
    result += '</plate>';
  }
  return result + '</config>';
}

export async function createSlicerProject(input: unknown, signal?: AbortSignal, httpRequest?: Request): Promise<SlicerExportResult> {
  const request = exportRequest(input);
  invariant(!generating, 429, 'Another project is being prepared. Try again shortly.');
  generating = true;
  let temporary: string | undefined;
  try {
    await cleanupSlicerExports();
    const sql = await db();
    const jobs: Job[] = [];
    for (const id of request.ids) {
      const [job]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id} AND confirmed_at IS NOT NULL AND upload_state = 'ready'`;
      invariant(job, 404, 'One of the selected prints is unavailable. Refresh the queue.'); jobs.push(job);
    }
    const material = jobs[0].material.toUpperCase();
    invariant(jobs.every(job => job.material.toUpperCase() === material && job.color.toLowerCase() === jobs[0].color.toLowerCase()), 422,
      'Select prints with the same material and color for one project.');
    invariant(jobs.reduce((bytes, job) => bytes + job.file_size, 0) <= MAX_INPUT_BYTES, 413, 'Select at most 500 MiB of STL files for a project.');
    const deadline = Date.now() + GENERATION_TTL;
    const check = () => invariant(!signal?.aborted && Date.now() < deadline, 408, 'Project preparation timed out or was canceled. Select fewer or smaller models.');
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(directory(), 'building-'));
    const parts: ExportPart[] = [];
    let triangles = 0;
    for (const [index, job] of jobs.entries()) {
      const supports = job.supports === 'operator' ? 'none' : job.supports as SupportChoice;
      const file = Bun.file(filePath(job.storage_key));
      invariant(await file.exists(), 404, 'An STL file is missing. Contact the administrator.');
      invariant(file.size === job.file_size, 409, 'An STL changed on disk. Contact the administrator.');
      await parseSTL(file, () => { check(); invariant(++triangles <= MAX_TRIANGLES, 413, 'Select models with at most 5 million triangles in total.'); });
      const info = await repairProjectMesh(filePath(job.storage_key), join(temporary, `mesh-${index}.bin`), MAX_TRIANGLES, deadline - Date.now(), signal);
      check();
      for (let copy = 0; copy < job.copies; copy++) parts.push({ job, supports, info, id: (index + 1) * (request.slicer === 'prusa' ? 1 : 2), x: 0, y: 0 });
    }
    arrange(parts);
    const prusa = request.slicer === 'prusa';
    const modelPath = join(temporary, 'model.xml');
    await writeModel(modelPath, parts, request.slicer, check);
    const meshFiles: { name: string; path: string }[] = [];
    if (!prusa) for (const part of parts.filter((part, index) => parts.findIndex(other => other.job.id === part.job.id) === index)) {
      const path = join(temporary, `part-${part.id}.xml`);
      await writeModel(path, [part], request.slicer, check, true);
      meshFiles.push({ name: `3D/Objects/part-${part.id}.model`, path });
    }
    check();
    async function* meshChunks(path: string) {
      for await (const chunk of Bun.file(path).stream()) { check(); yield chunk; }
    }
    const entries: ProjectEntry[] = [
      { name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/plain"/></Types>' },
      { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
      { name: '3D/3dmodel.model', content: meshChunks(modelPath) },
      // No project_settings.config/Slic3r_PE.config or embedded presets: importing
      // a global config makes slicers replace local presets with project defaults.
      // Keep only object overrides so the operator's calibrated presets remain in use.
      { name: prusa ? 'Metadata/Slic3r_PE_model.config' : 'Metadata/model_settings.config', content: modelSettings(parts, request) },
    ];
    if (!prusa) {
      entries.push({ name: '3D/_rels/3dmodel.model.rels', content: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        meshFiles.map((file, index) => `<Relationship Target="/${file.name}" Id="mesh${index}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('') + '</Relationships>' });
      for (const file of meshFiles) entries.push({ name: file.name, content: meshChunks(file.path) });
    }
    const artifactId = randomUUID(), archive = join(temporary, 'project.3mf');
    await writeProjectZip(archive, entries); check();
    await rename(archive, join(directory(), `${artifactId}.3mf`));
    const expiresAt = Date.now() + EXPORT_TTL, token = seal(artifactId, 'slicer-export', expiresAt);
    // Native downloaders derive filenames from the last slash of the *whole* URL.
    // This query suffix gives both downloaders a clean basename while keeping the secret out of paths/logs.
    const downloadUrl = `${appOrigin(httpRequest)}/api/slicer-projects?token=${token}&filename=/printhive-${reference(artifactId)}.3mf`;
    return { downloadUrl, launchUrl: slicerLaunchUrl(request.slicer, downloadUrl), expiresAt };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(error => logWarning('slicer.cleanup_failed', error));
    generating = false;
  }
}
