import { test, expect } from 'bun:test';
import {
  PreviewResultCache,
  previewCacheKey,
  runtimeCacheIdentity,
} from '../src/lib/preview-cache';
import type { FastSupportPreview } from '@time-estimator/browser-preview';

const preview = (vertexCount = 3) =>
  ({
    vertexCount,
    shapes: [],
    estimatedSeconds: 42,
  }) as unknown as FastSupportPreview;
const profile = {
  id: 'profile',
  label: 'Profile',
  configuration: { layer_height: '0.2', nested: { b: 2, a: 1 } },
};
const options = {
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mirror: false,
  scale: 1,
  infill: 15,
  walls: 2,
  layerHeight: 0.2,
  supports: 'tree',
};

test('preview keys cover effective configuration, engine and physical settings', () => {
  const key = previewCacheKey('engine', profile, options);
  expect(
    previewCacheKey(
      'engine',
      {
        ...profile,
        configuration: { nested: { a: 1, b: 2 }, layer_height: '0.2' },
      },
      options,
    ),
  ).toBe(key);
  for (const change of [
    { scale: 1.5 },
    { mirror: true },
    { infill: 30 },
    { walls: 6 },
    { layerHeight: 0.12 },
    { supports: 'normal' },
    { rotation: [0, 1, 0, 1, 0, 0, 0, 0, -1] },
  ])
    expect(
      previewCacheKey('engine', profile, { ...options, ...change }),
    ).not.toBe(key);
  expect(previewCacheKey('another-engine', profile, options)).not.toBe(key);
  expect(
    previewCacheKey(
      'engine',
      { ...profile, configuration: { layer_height: '.3' } },
      options,
    ),
  ).not.toBe(key);
});

test('file identity, LRU eviction and file removal prevent stale or unbounded retained results', () => {
  const a = new File(['aaa'], 'part.stl'),
    b = new File(['bbb'], 'part.stl'),
    c = new File(['ccc'], 'other.stl');
  const cache = new PreviewResultCache(1000000, 2),
    result = preview();
  cache.set(a, 'settings', result);
  expect(cache.get(b, 'settings')).toBeUndefined();
  expect(cache.get(a, 'other-settings')).toBeUndefined();
  cache.set(b, 'settings', preview());
  expect(cache.get(a, 'settings')).toBe(result);
  cache.set(c, 'settings', preview());
  expect(cache.get(b, 'settings')).toBeUndefined();
  expect(cache.get(a, 'settings')).toBe(result);
  cache.retain([c]);
  expect(cache.get(a, 'settings')).toBeUndefined();
  const bounded = new PreviewResultCache(14500);
  bounded.set(a, 'settings', preview(100));
  bounded.set(b, 'settings', preview(100));
  expect(bounded.get(a, 'settings')).toBeUndefined();
  bounded.set(c, 'settings', preview(100000));
  expect(bounded.get(c, 'settings')).toBeUndefined();
  expect(bounded.get(b, 'settings')).toBeDefined();
});

test('runtime cache identity binds all assets and rejects an unknown shape schema', () => {
  const manifest = {
    schemaVersion: 1,
    kind: 'orca-cubby-serial',
    supportShapesVersion: 1,
    engine: { version: '2.4.2' },
    module: { sha256: 'a'.repeat(64) },
    wasm: { sha256: 'b'.repeat(64) },
    data: { sha256: 'c'.repeat(64) },
  };
  expect(runtimeCacheIdentity(manifest).wasmSha256).toBe('b'.repeat(64));
  expect(
    runtimeCacheIdentity({ ...manifest, wasm: { sha256: 'd'.repeat(64) } }).key,
  ).not.toBe(runtimeCacheIdentity(manifest).key);
  expect(() =>
    runtimeCacheIdentity({ ...manifest, supportShapesVersion: 2 }),
  ).toThrow();
});
