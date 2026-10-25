import { installSupportWorker } from '@time-estimator/browser-preview/worker';
import { PreviewError } from '@time-estimator/browser-preview';
import { parseSTL } from '../lib/stl';

installSupportWorker<File>({
  async decodeMesh(file, limits) {
    if (!(file instanceof Blob) || file.size > 64 * 1024 * 1024) {
      throw new PreviewError('mesh_limit', 'File exceeds the local support preview budget');
    }
    // Full triangles, never the reservoir-sampled display geometry. The parser is shared
    // with existing PrintHive validation rather than adding another STL implementation.
    const positions = new Float32Array(limits.maxTriangles * 9);
    const info = await parseSTL(file, (vertices, index) => {
      if (index >= limits.maxTriangles) throw new PreviewError('mesh_limit', 'Too many triangles for local support generation');
      positions.set(vertices, index * 9);
    });
    return { positions: positions.slice(0, info.triangles * 9) };
  },
});
