// Shared by the server validator and preview worker. Only a small file slice is held at a time.
export interface STLInfo { triangles: number; min: number[]; max: number[] }
export async function parseSTL(blob: Blob, triangle?: (vertices: number[], index: number) => void): Promise<STLInfo> {
  const info: STLInfo = { triangles: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const fail = () => { throw new Error('Invalid STL. Use a complete ASCII or binary STL with finite coordinates.'); };
  function accept(vertices: number[]) {
    for (let i = 0; i < 9; i++) {
      const n = vertices[i];
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) fail();
      info.min[i % 3] = Math.min(info.min[i % 3], n);
      info.max[i % 3] = Math.max(info.max[i % 3], n);
    }
    triangle?.(vertices, info.triangles);
    info.triangles++;
  }
  const header = await blob.slice(0, 84).arrayBuffer();
  const count = header.byteLength === 84 ? new DataView(header).getUint32(80, true) : 0;
  if (count > 0 && 84 + count * 50 <= blob.size) {
    for (let first = 0; first < count; first += 1024) {
      const amount = Math.min(1024, count - first);
      const data = new DataView(await blob.slice(84 + first * 50, 84 + (first + amount) * 50).arrayBuffer());
      for (let i = 0; i < amount; i++) {
        const offset = i * 50;
        // STL normals are advisory. Orca recomputes damaged normals from the finite vertices.
        accept(Array.from({ length: 9 }, (_, j) => data.getFloat32(offset + 12 + j * 4, true)));
      }
    }
  } else {
    // Standard line-oriented ASCII STL; names following solid/endsolid may contain spaces.
    let pending = '', state = 0, vertices: number[] = [], opened = false, closed = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const normal = /^facet\s+normal\s+\S+\s+\S+\s+\S+$/i;
    const vertex = new RegExp(`^vertex\\s+(${number})\\s+(${number})\\s+(${number})$`, 'i');
    function line(raw: string) {
      const s = raw.trim();
      if (!s) return;
      if (s.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) fail();
      if (state === 0) {
        if (!/^solid(?:\s.*)?$/i.test(s)) fail();
        opened = true; closed = false; state = 1;
      } else if (state === 1) {
        if (/^endsolid(?:\s.*)?$/i.test(s)) { closed = true; state = 0; return; }
        const match = normal.exec(s);
        if (!match) fail();
        state = 2;
      } else if (state === 2) {
        if (!/^outer\s+loop$/i.test(s)) fail();
        vertices = []; state = 3;
      } else if (state >= 3 && state <= 5) {
        const match = vertex.exec(s);
        if (!match) fail();
        vertices.push(...match!.slice(1).map(Number)); state++;
      } else if (state === 6) {
        if (!/^endloop$/i.test(s)) fail();
        state = 7;
      } else {
        if (!/^endfacet$/i.test(s)) fail();
        accept(vertices); state = 1;
      }
    }
    for (let offset = 0; offset < blob.size; offset += 65536) {
      pending += decoder.decode(await blob.slice(offset, offset + 65536).arrayBuffer(), { stream: true });
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop()!;
      for (const value of lines) line(value);
      if (pending.length > 4096) fail();
    }
    pending += decoder.decode();
    if (pending) line(pending);
    if (!opened || !closed || state !== 0) fail();
  }
  if (!info.triangles) fail();
  return info;
}
