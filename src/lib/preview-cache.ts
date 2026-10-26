import type {
  FastSupportPreview,
  PreviewProfile,
} from '@time-estimator/browser-preview';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function runtimeCacheIdentity(value: unknown) {
  const manifest = value as {
    schemaVersion?: number;
    kind?: string;
    supportShapesVersion?: number;
    engine?: unknown;
    module?: { sha256?: string };
    wasm?: { sha256?: string };
    data?: { sha256?: string };
  };
  const hashes = [
    manifest?.module?.sha256,
    manifest?.wasm?.sha256,
    manifest?.data?.sha256,
  ];
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.kind !== 'orca-cubby-serial' ||
    manifest.supportShapesVersion !== 1 ||
    hashes.some((hash) => !hash || !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error('Unsupported preview cache runtime');
  return {
    key: JSON.stringify(
      canonical({
        schema: 1,
        engine: manifest.engine,
        hashes,
        shapes: manifest.supportShapesVersion,
      }),
    ),
    wasmSha256: manifest.wasm!.sha256!,
  };
}

export function previewCacheKey(
  runtime: string,
  profile: PreviewProfile,
  options: {
    rotation: number[];
    mirror: boolean;
    scale: number;
    infill: number;
    layerHeight: number;
    supports: string;
  },
) {
  return JSON.stringify(
    canonical({
      version: 1,
      runtime,
      profile,
      ...options,
      supports:
        options.supports === 'none'
          ? 'none'
          : options.supports === 'normal'
            ? 'normal'
            : 'tree',
    }),
  );
}

/** Page-local LRU. File objects are immutable; names/sizes are never used as byte identities.
 * Cached output is read-only. Native/WASM/GPU objects are not retained.
 */
export class PreviewResultCache {
  private entries = new Map<
    number,
    { file: File; key: string; result: FastSupportPreview; bytes: number }
  >();
  private bytes = 0;
  private sequence = 0;
  constructor(
    private maxBytes = 128 * 1024 * 1024,
    private maxEntries = 20,
  ) {}

  get(file: File, key: string): FastSupportPreview | undefined {
    for (const [id, entry] of this.entries)
      if (entry.file === file && entry.key === key) {
        this.entries.delete(id);
        this.entries.set(id, entry);
        return entry.result;
      }
  }

  set(file: File, key: string, result: FastSupportPreview) {
    // Nested JS coordinates cost more than packed floats. This deliberately
    // conservative estimate bounds retained previews independently of the viewer.
    const bytes =
      result.vertexCount * 96 +
      result.shapes.length * 256 +
      key.length * 2 +
      4096;
    for (const [id, entry] of this.entries)
      if (entry.file === file && entry.key === key) this.remove(id);
    if (bytes > this.maxBytes) return;
    this.entries.set(++this.sequence, { file, key, result, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries)
      this.remove(this.entries.keys().next().value!);
  }

  retain(files: readonly File[]) {
    for (const [id, entry] of this.entries)
      if (!files.includes(entry.file)) this.remove(id);
  }

  private remove(id: number) {
    const entry = this.entries.get(id);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(id);
  }
}
