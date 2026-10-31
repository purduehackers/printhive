import { readFullMesh } from '../lib/mesh';
import { MAX_THUMBNAIL_TRIANGLES } from '../lib/thumbnail-mesh';
import { DEFAULT_LIMITS } from '@time-estimator/browser-preview';
import { poseMatrix, placeOnBed, extendBounds } from '@time-estimator/browser-preview/pose';
import { applyTransform } from '@time-estimator/browser-preview/geometry';

self.onmessage = async ({ data }) => {
  try {
    const matrix = poseMatrix(data.rotation, data.mirror, data.scale);
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    // A partial set of faces creates noisy holes, not a lower-detail solid model.
    // Skip optional artwork above the memory budget instead of rendering an incomplete mesh.
    const { positions } = await readFullMesh(data.file, { ...DEFAULT_LIMITS, maxTriangles: MAX_THUMBNAIL_TRIANGLES });
    for (let i = 0; i < positions.length; i += 3) extendBounds(bounds, matrix, positions.subarray(i, i + 3));
    const placement = placeOnBed(matrix, bounds);
    for (let i = 0; i < positions.length; i += 3)
      positions.set(applyTransform(placement.sourceToPlate, positions.subarray(i, i + 3)), i);
    self.postMessage({ positions, triangles: positions.length / 9, ...placement.bounds }, [positions.buffer]);
  } catch { self.postMessage(null); }
};
