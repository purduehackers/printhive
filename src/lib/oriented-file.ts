import {
  poseMatrix,
  extendBounds,
  placeOnBed,
  createSTLWriter,
} from '@time-estimator/browser-preview/pose';
import { parseSTL } from './stl';

export async function bakeOrientedSTL(
  file: File,
  rotation: number[] | undefined,
  mirror: boolean,
  scale = 1,
) {
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
  return { file: result, bounds: placement.bounds };
}

/** Transform in a disposable worker before reserving the upload, so declared size matches bytes. */
export function prepareOrientedFile(
  file: File,
  rotation: number[] | undefined,
  mirror: boolean,
  signal: AbortSignal,
  scale = 1,
): Promise<File> {
  if (!rotation && !mirror && scale === 1) return Promise.resolve(file);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/orient-stl.worker.ts', import.meta.url),
      { type: 'module' },
    );
    const finish = () => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      finish();
      reject(new Error('Upload canceled.'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data.file);
    };
    worker.onerror = () => {
      finish();
      reject(new Error('Could not prepare the oriented STL.'));
    };
    worker.postMessage({ file, rotation, mirror, scale });
  });
}
