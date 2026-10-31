import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { HttpError, invariant } from './errors';
import type { STLInfo } from '../stl';

export interface ProjectMesh extends STLInfo { path: string; vertices: number }

export async function repairProjectMesh(source: string, destination: string, maxTriangles: number, timeout: number, signal?: AbortSignal): Promise<ProjectMesh> {
  invariant(!signal?.aborted && timeout > 0, 408, 'Project preparation timed out or was canceled. Select fewer or smaller models.');
  // src/lib is retained in the deployed container for Bun operational helpers.
  const child = Bun.spawn([process.execPath, resolve('src/lib/server/slicer-mesh.worker.ts'), source, destination, String(maxTriangles)], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });
  let stopped = false;
  const stop = () => { stopped = true; if (child.exitCode === null) child.kill(); };
  const timer = setTimeout(stop, timeout);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const [code, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    invariant(!stopped && !signal?.aborted, 408, 'Project preparation timed out or was canceled. Select fewer or smaller models.');
    if (code) throw new HttpError(422, 'This mesh could not be prepared. Download the STL and repair it in your slicer.', { cause: new Error(diagnostic.slice(0, 1000)) });
    const file = Bun.file(destination), header = Buffer.from(await file.slice(0, 20).arrayBuffer());
    invariant(header.length === 20 && header.toString('ascii', 0, 8) === 'TESTLM01' && header.readUInt32LE(8) === 1, 500, 'Invalid repaired mesh.');
    const vertices = header.readUInt32LE(12), triangles = header.readUInt32LE(16);
    // Reading a slice does not guarantee the original BunFile's lazy size is populated.
    const actualBytes = (await stat(destination)).size, expectedBytes = 20 + vertices * 12 + triangles * 12;
    if (!(vertices > 0 && vertices <= maxTriangles * 3 && triangles > 0 && triangles <= maxTriangles && actualBytes === expectedBytes))
      throw new HttpError(500, 'Invalid repaired mesh.', {
        cause: new Error(`Repaired mesh validation: vertices=${vertices}, triangles=${triangles}, expectedBytes=${expectedBytes}, actualBytes=${actualBytes}`),
      });
    const mesh: ProjectMesh = { path: destination, vertices, triangles, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    await meshVertices(mesh, () => {
      invariant(!stopped && !signal?.aborted, 408, 'Project preparation timed out or was canceled.');
    }, point => {
      for (let axis = 0; axis < 3; axis++) {
        invariant(Number.isFinite(point[axis]), 500, 'Invalid repaired mesh coordinate.');
        mesh.min[axis] = Math.min(mesh.min[axis], point[axis]); mesh.max[axis] = Math.max(mesh.max[axis], point[axis]);
      }
    });
    return mesh;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}

export async function meshVertices(mesh: ProjectMesh, check: () => void, accept: (point: number[]) => void) {
  const file = Bun.file(mesh.path);
  for (let first = 0; first < mesh.vertices; first += 4096) {
    check();
    const amount = Math.min(4096, mesh.vertices - first);
    const view = new DataView(await file.slice(20 + first * 12, 20 + (first + amount) * 12).arrayBuffer());
    for (let i = 0; i < amount; i++) accept([view.getFloat32(i * 12, true), view.getFloat32(i * 12 + 4, true), view.getFloat32(i * 12 + 8, true)]);
  }
}

export async function meshTriangles(mesh: ProjectMesh, check: () => void, accept: (indices: number[]) => void) {
  const file = Bun.file(mesh.path), start = 20 + mesh.vertices * 12;
  for (let first = 0; first < mesh.triangles; first += 4096) {
    check();
    const amount = Math.min(4096, mesh.triangles - first);
    const view = new DataView(await file.slice(start + first * 12, start + (first + amount) * 12).arrayBuffer());
    for (let i = 0; i < amount; i++) {
      const indices = [view.getUint32(i * 12, true), view.getUint32(i * 12 + 4, true), view.getUint32(i * 12 + 8, true)];
      invariant(indices.every(index => index < mesh.vertices), 500, 'Invalid repaired mesh index.'); accept(indices);
    }
  }
}
