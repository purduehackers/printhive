import { findThumbnailMesh, type ThumbnailMesh } from './thumbnail-mesh';
import { previewColor } from './shared';

interface Part { file: File; rotation: number[]; mirror: boolean; scale: number; color: string }

async function readMesh(part: Part, signal: AbortSignal): Promise<ThumbnailMesh | null> {
  const cached = findThumbnailMesh(part.file, part.rotation, part.mirror, part.scale);
  if (cached) return cached;
  if (signal.aborted) return null;
  return new Promise(resolve => {
    const worker = new Worker(new URL('../workers/thumbnail.worker.ts', import.meta.url), { type: 'module' });
    const finish = (mesh: ThumbnailMesh | null) => {
      clearTimeout(timer); worker.terminate(); signal.removeEventListener('abort', abort); resolve(mesh);
    };
    const abort = () => finish(null);
    // Optional artwork must never keep a slow or unsupported device busy indefinitely.
    const timer = setTimeout(abort, 750);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => finish(data);
    worker.onerror = () => finish(null);
    worker.postMessage(part);
  });
}

export function preparePrintThumbnails(parts: Part[], signal: AbortSignal): Promise<Blob | null>[] {
  // One small renderer is shared by the whole batch and disposed when finished.
  let renderer: import('three').WebGLRenderer | undefined;
  let three: Promise<typeof import('three')> | undefined;
  let previous: Promise<unknown> = Promise.resolve();
  const results = parts.map(part => {
    const task = previous.then(async () => {
      try {
        if (signal.aborted) return null;
        const mesh = await readMesh(part, signal);
        if (!mesh || signal.aborted) return null;
        const T = await (three ??= import('three'));
        renderer ??= new T.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(128, 128, false);
        renderer.setPixelRatio(1);
        renderer.toneMapping = T.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.85;
        const geometry = new T.BufferGeometry();
        const count = mesh.positions.length / 9, stride = Math.max(1, Math.ceil(count / 100_000));
        const positions = new Float32Array(Math.ceil(count / stride) * 9);
        for (let i = 0, j = 0; i < count; i += stride, j += 9)
          positions.set(mesh.positions.subarray(i * 9, i * 9 + 9), j);
        geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
        geometry.computeVertexNormals();
        const color = new T.Color(previewColor(part.color));
        // Near-white filament gets light-gray shading so its silhouette survives small thumbnails on light backgrounds.
        if (Math.min(color.r, color.g, color.b) > 0.7) color.multiplyScalar(0.65);
        const material = new T.MeshStandardMaterial({ color, roughness: 0.7, side: T.DoubleSide });
        try {
          const scene = new T.Scene();
          scene.background = new T.Color('#ffffff');
          const object = new T.Mesh(geometry, material);
          // STL plate coordinates are Z-up. Normalize first to keep far-offset CAD files precise.
          const size = Math.max(...mesh.max.map((value, index) => value - mesh.min[index]));
          if (!Number.isFinite(size) || size <= 0) return null;
          object.scale.setScalar(1 / size);
          object.position.set(...mesh.min.map((value, index) => -(value + mesh.max[index]) / (2 * size)) as [number, number, number]);
          scene.add(object, new T.HemisphereLight('#ffffff', '#667080', 2));
          const light = new T.DirectionalLight('#ffffff', 3); light.position.set(3, -4, 6); scene.add(light);
          const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
          camera.up.set(0, 0, 1); camera.position.set(3, -4, 3); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
          // Fit visible model vertices rather than its box corners, with an 8% margin.
          const projected = new T.Box3();
          const point = new T.Vector3();
          for (let i = 0; i < positions.length; i += 3) {
            point.fromArray(positions, i).multiplyScalar(1 / size).add(object.position).applyMatrix4(camera.matrixWorldInverse);
            projected.expandByPoint(point);
          }
          const extent = Math.max(projected.max.x - projected.min.x, projected.max.y - projected.min.y) * 0.54;
          const cx = (projected.max.x + projected.min.x) / 2, cy = (projected.max.y + projected.min.y) / 2;
          camera.left = cx - extent; camera.right = cx + extent; camera.bottom = cy - extent; camera.top = cy + extent; camera.updateProjectionMatrix();
          renderer.render(scene, camera);
          // Encode immediately after the single render; preserveDrawingBuffer stays disabled.
          return await new Promise<Blob | null>(resolve => renderer!.domElement.toBlob(blob => resolve(blob && blob.size <= 65536 ? blob : null), 'image/png'));
        } finally { geometry.dispose(); material.dispose(); }
      } catch { return null; }
    });
    previous = task;
    return task;
  });
  void previous.finally(() => { renderer?.dispose(); renderer?.forceContextLoss(); });
  return results;
}

export async function uploadPrintThumbnail(id: string, capability: string, thumbnail: Promise<Blob | null>, signal: AbortSignal) {
  try {
    // Preparation runs alongside STL preparation/reservation. Only allow a brief final wait.
    let timeout: ReturnType<typeof setTimeout>;
    const blob = await Promise.race([thumbnail, new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 150); })]);
    clearTimeout(timeout!);
    if (!blob || signal.aborted) return;
    await fetch(`/api/submissions/${id}/thumbnail`, { method: 'PUT',
      headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'image/png' }, body: blob,
      signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
    });
  } catch { /* Thumbnails are optional; submitting the print takes priority. */ }
}
