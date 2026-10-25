import { parseSTL } from '../lib/stl';
import {
  poseMatrix,
  extendBounds,
  placeOnBed,
} from '@time-estimator/browser-preview/pose';
import { applyTransform } from '@time-estimator/browser-preview/geometry';
import { createPlacementHull } from '@time-estimator/browser-preview/three';

self.onmessage = async ({
  data,
}: MessageEvent<{
  file: File;
  rotation: number[];
  mirror: boolean;
  scale?: number;
  hull?: boolean;
}>) => {
  try {
    const { file, rotation, mirror, hull, scale = 1 } = data;
    const matrix = poseMatrix(rotation, mirror, scale);
    const rotated = {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
    const limit = 1_000_000;
    const chunks: Float32Array[] = [];
    let chunk = new Float32Array(32768 * 9),
      used = 0;
    const info = await parseSTL(file, (vertices, index) => {
      for (let i = 0; i < 9; i += 3)
        extendBounds(rotated, matrix, vertices.slice(i, i + 3));
      if (index < limit) {
        if (used === chunk.length) {
          chunks.push(chunk);
          chunk = new Float32Array(32768 * 9);
          used = 0;
        }
        chunk.set(vertices, used);
        used += 9;
      } else {
        let hash = Math.imul(index ^ (index >>> 16), 0x45d9f3b);
        hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
        const slot = ((hash ^ (hash >>> 16)) >>> 0) % (index + 1);
        if (slot < limit)
          (chunks[Math.floor(slot / 32768)] ?? chunk).set(
            vertices,
            (slot % 32768) * 9,
          );
      }
    });
    const positions = new Float32Array(Math.min(info.triangles, limit) * 9);
    let offset = 0;
    for (const part of chunks) {
      positions.set(part, offset);
      offset += part.length;
    }
    positions.set(chunk.subarray(0, used), offset);
    const placement = placeOnBed(matrix, rotated);
    const placeVertices = (vertices: Float32Array) => {
      for (let i = 0; i < vertices.length; i += 3)
        vertices.set(
          applyTransform(placement.sourceToPlate, vertices.subarray(i, i + 3)),
          i,
        );
    };
    // Center on the CPU before conversion to GPU floats, including far-offset CAD meshes.
    placeVertices(positions);
    let hullPositions: Float32Array<ArrayBuffer> | undefined;
    if (hull) {
      // Include all vertices for hull placement; never infer a bed face from a display sample.
      const { readFullMesh } = await import('../lib/mesh');
      const { DEFAULT_LIMITS } =
        await import('@time-estimator/browser-preview');
      const full =
        info.triangles <= limit
          ? positions
          : (await readFullMesh(file, { ...DEFAULT_LIMITS })).positions;
      if (full !== positions) placeVertices(full);
      const geometry = createPlacementHull(full);
      hullPositions = new Float32Array(geometry.getAttribute('position').array);
      geometry.dispose();
    }
    self.postMessage(
      {
        positions,
        min: placement.bounds.min,
        max: placement.bounds.max,
        hullPositions,
      },
      hullPositions
        ? [positions.buffer, hullPositions.buffer]
        : [positions.buffer],
    );
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : 'Could not read this STL.',
    });
  }
};
