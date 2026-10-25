import {
  poseMatrix,
  extendBounds,
  placeOnBed,
  createSTLWriter,
} from '@time-estimator/browser-preview/pose';
import { parseSTL } from '../lib/stl';

self.onmessage = async ({
  data,
}: MessageEvent<{
  file: File;
  rotation?: number[];
  mirror: boolean;
  scale?: number;
}>) => {
  try {
    const { file, rotation, mirror, scale = 1 } = data;
    const matrix = poseMatrix(rotation, mirror, scale);
    const bounds = {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
    const info = await parseSTL(file, (vertices) => {
      for (let i = 0; i < 9; i += 3)
        extendBounds(bounds, matrix, vertices.slice(i, i + 3));
    });
    const placement = placeOnBed(matrix, bounds);
    const writer = createSTLWriter(info.triangles, placement.sourceToPlate);
    await parseSTL(file, (vertices) => writer.addTriangle(vertices));
    const result = new File([writer.finish()], file.name, {
      type: 'application/octet-stream',
      lastModified: file.lastModified,
    });
    self.postMessage({ file: result, bounds: placement.bounds });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error
          ? error.message
          : 'Could not prepare orientation.',
    });
  }
};
