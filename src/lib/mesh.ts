import { PreviewError, type Limits } from '@time-estimator/browser-preview';
import { parseSTL } from './stl';
import { MAX_FILE_BYTES } from './shared';

/** Retain all source triangles. Small files never allocate the maximum mesh budget. */
export async function readFullMesh(file: Blob, limits: Limits) {
  if (!(file instanceof Blob) || file.size > MAX_FILE_BYTES)
    throw new PreviewError('mesh_limit', 'Choose an STL up to 500 MiB.');
  const header = await file.slice(0, 84).arrayBuffer();
  const count =
    header.byteLength === 84 ? new DataView(header).getUint32(80, true) : 0;
  const binary = count > 0 && 84 + count * 50 <= file.size;
  if (binary && count > limits.maxTriangles)
    throw new PreviewError(
      'mesh_limit',
      'This model exceeds the available browser memory budget.',
    );
  const chunks: Float32Array[] = [];
  let chunk = new Float32Array(binary ? count * 9 : 32768 * 9),
    used = 0;
  const info = await parseSTL(file, (vertices, index) => {
    if (index >= limits.maxTriangles)
      throw new PreviewError(
        'mesh_limit',
        'This model exceeds the available browser memory budget.',
      );
    if (used === chunk.length) {
      chunks.push(chunk);
      chunk = new Float32Array(32768 * 9);
      used = 0;
    }
    chunk.set(vertices, used);
    used += 9;
  });
  if (!chunks.length)
    return { positions: used === chunk.length ? chunk : chunk.slice(0, used) };
  const positions = new Float32Array(info.triangles * 9);
  let offset = 0;
  for (const part of chunks) {
    positions.set(part, offset);
    offset += part.length;
  }
  positions.set(chunk.subarray(0, used), offset);
  return { positions };
}
