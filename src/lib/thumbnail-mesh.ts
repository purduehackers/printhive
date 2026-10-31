export interface ThumbnailMesh {
  positions: Float32Array;
  min: number[];
  max: number[];
  triangles: number;
}
export const MAX_THUMBNAIL_TRIANGLES = 1_000_000;
interface CachedMesh extends ThumbnailMesh { rotation: number[]; mirror: boolean; scale: number }
let meshes = new WeakMap<File, CachedMesh>();

// Reuse geometry already read by the interactive preview, without retaining files removed from the form.
export function rememberThumbnailMesh(file: File, mesh: CachedMesh) {
  // Share the current preview's complete array, with no copy or holes from dropping faces.
  // Keep only one model so a batch cannot retain a large mesh for every file.
  meshes = new WeakMap();
  if (mesh.triangles > MAX_THUMBNAIL_TRIANGLES || mesh.positions.length !== mesh.triangles * 9) return;
  meshes.set(file, mesh);
}
export function findThumbnailMesh(file: File, rotation: number[], mirror: boolean, scale: number) {
  const mesh = meshes.get(file);
  return mesh && mesh.mirror === mirror && mesh.scale === scale &&
    mesh.rotation.every((value, index) => value === rotation[index]) ? mesh : null;
}
