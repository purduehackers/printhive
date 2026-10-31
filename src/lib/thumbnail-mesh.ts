export interface ThumbnailMesh {
  positions: Float32Array;
  min: number[];
  max: number[];
}
interface CachedMesh extends ThumbnailMesh { rotation: number[]; mirror: boolean; scale: number }
const meshes = new WeakMap<File, CachedMesh>();

// Reuse geometry already read by the interactive preview, without retaining files removed from the form.
export function rememberThumbnailMesh(file: File, mesh: CachedMesh) {
  const count = mesh.positions.length / 9, stride = Math.max(1, Math.ceil(count / 100_000));
  let positions = mesh.positions;
  if (stride > 1) {
    positions = new Float32Array(Math.ceil(count / stride) * 9);
    for (let i = 0, j = 0; i < count; i += stride, j += 9)
      positions.set(mesh.positions.subarray(i * 9, i * 9 + 9), j);
  }
  meshes.set(file, { positions, min: mesh.min, max: mesh.max, rotation: mesh.rotation, mirror: mesh.mirror, scale: mesh.scale });
}
export function findThumbnailMesh(file: File, rotation: number[], mirror: boolean, scale: number) {
  const mesh = meshes.get(file);
  return mesh && mesh.mirror === mirror && mesh.scale === scale &&
    mesh.rotation.every((value, index) => value === rotation[index]) ? mesh : null;
}
