import { writeFile } from 'node:fs/promises';
import { readSTL } from '@time-estimator/browser-preview/stl';

// Disposable Bun process: Orca's synchronous WASM repair cannot block the web
// process, and all importer memory is released when this process exits.
try {
  const [source, destination, limit] = process.argv.slice(2);
  if (!source || !destination || !/^\d+$/.test(limit ?? '')) throw new Error('Missing mesh import arguments.');
  const mesh = await readSTL(Bun.file(source), { limits: { maxTriangles: Number(limit) } });
  const header = Buffer.alloc(20);
  header.write('TESTLM01'); header.writeUInt32LE(1, 8);
  header.writeUInt32LE(mesh.positions.length / 3, 12); header.writeUInt32LE(mesh.indices.length / 3, 16);
  await writeFile(destination, (function* () {
    yield header;
    yield new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
    yield new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);
  })(), { flag: 'wx', mode: 0o600 });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Mesh import failed.');
  process.exitCode = 1;
}
