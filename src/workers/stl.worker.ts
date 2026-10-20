import { parseSTL } from '../lib/stl';
const worker = self as unknown as { onmessage: (event: MessageEvent<File>) => void; postMessage: (value: unknown, transfer?: Transferable[]) => void };
worker.onmessage = async ({ data: file }) => {
  try {
    const limit = 100000, positions = new Float32Array(limit * 9);
    const info = await parseSTL(file, (vertices, index) => {
      // Deterministic reservoir sample keeps memory and GPU cost bounded for large STLs.
      let slot = index;
      if (index >= limit) {
        let hash = Math.imul(index ^ (index >>> 16), 0x45d9f3b);
        hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
        slot = ((hash ^ (hash >>> 16)) >>> 0) % (index + 1);
      }
      if (slot < limit) positions.set(vertices, slot * 9);
    });
    const result = positions.slice(0, Math.min(info.triangles, limit) * 9);
    worker.postMessage({ positions: result, ...info, simplified: info.triangles > limit }, [result.buffer]);
  } catch (error) { worker.postMessage({ error: error instanceof Error ? error.message : 'Could not read this STL.' }); }
};
