import { parseSTL } from '../lib/stl';
import { poseMatrix, placeOnBed, extendBounds } from '@time-estimator/browser-preview/pose';
import { applyTransform } from '@time-estimator/browser-preview/geometry';

self.onmessage = async ({ data }) => {
  try {
    const matrix = poseMatrix(data.rotation, data.mirror, data.scale);
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const limit = 100_000, sample = new Float32Array(limit * 9);
    const info = await parseSTL(data.file, (vertices, index) => {
      for (let i = 0; i < 9; i += 3) extendBounds(bounds, matrix, vertices.slice(i, i + 3));
      // A deterministic reservoir bounds memory even for very large STLs.
      let hash = Math.imul(index ^ (index >>> 16), 0x45d9f3b);
      hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
      const slot = index < limit ? index : ((hash ^ (hash >>> 16)) >>> 0) % (index + 1);
      if (slot < limit) sample.set(vertices, slot * 9);
    });
    const placement = placeOnBed(matrix, bounds);
    const positions = sample.slice(0, Math.min(info.triangles, limit) * 9);
    for (let i = 0; i < positions.length; i += 3)
      positions.set(applyTransform(placement.sourceToPlate, positions.subarray(i, i + 3)), i);
    self.postMessage({ positions, ...placement.bounds }, [positions.buffer]);
  } catch { self.postMessage(null); }
};
