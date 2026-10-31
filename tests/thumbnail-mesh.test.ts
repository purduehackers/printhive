import { test, expect } from 'bun:test';
import { rememberThumbnailMesh, findThumbnailMesh, MAX_THUMBNAIL_TRIANGLES } from '../src/lib/thumbnail-mesh';

const rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mesh = (triangles: number) => ({ positions: new Float32Array(triangles * 9), triangles,
  min: [0, 0, 0], max: [1, 1, 1], rotation, mirror: false, scale: 1 });

test('thumbnail cache retains every face above the former sampling limit without copying geometry', () => {
  const file = new File([], 'dense.stl'), original = mesh(141376);
  rememberThumbnailMesh(file, original);
  expect(findThumbnailMesh(file, rotation, false, 1)?.positions).toBe(original.positions);
  expect(findThumbnailMesh(file, rotation, false, 1)?.positions.length).toBe(141376 * 9);
  expect(findThumbnailMesh(file, rotation, true, 1)).toBeNull();
  expect(findThumbnailMesh(file, rotation, false, 2)).toBeNull();
});

test('partial viewport samples never become thumbnail geometry', () => {
  const file = new File([], 'sampled.stl');
  rememberThumbnailMesh(file, { ...mesh(10), triangles: 20 });
  expect(findThumbnailMesh(file, rotation, false, 1)).toBeNull();
  rememberThumbnailMesh(file, { ...mesh(10), triangles: MAX_THUMBNAIL_TRIANGLES + 1 });
  expect(findThumbnailMesh(file, rotation, false, 1)).toBeNull();
});

test('only the current preview is retained across a batch', () => {
  const first = new File([], 'first.stl'), second = new File([], 'second.stl');
  rememberThumbnailMesh(first, mesh(1));
  rememberThumbnailMesh(second, mesh(2));
  expect(findThumbnailMesh(first, rotation, false, 1)).toBeNull();
  expect(findThumbnailMesh(second, rotation, false, 1)?.triangles).toBe(2);
});
