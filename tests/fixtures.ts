import { deflateSync } from 'node:zlib';

export function thumbnailPNG() {
  function chunk(type: string, data: Buffer) {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(128 * (1 + 128 * 3), 190);
  for (let y = 0; y < 128; y++) pixels[y * (1 + 128 * 3)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export const asciiSTL = `solid test
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop
endfacet
endsolid test
`;
export function binarySTL(triangles = 1) {
  const bytes = new Uint8Array(84 + triangles * 50), view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);
  for (let i = 0; i < triangles; i++) {
    view.setFloat32(84 + i * 50 + 8, 1, true);
    view.setFloat32(84 + i * 50 + 24, 10, true);
    view.setFloat32(84 + i * 50 + 40, 10, true);
  }
  return bytes;
}
export const submission = (overrides = {}) => ({
  title: 'Test bracket', email: 'test@purdue.edu', notes: 'Private notes',
  original_filename: 'bracket.stl', file_size: new Blob([asciiSTL]).size, ...overrides,
});

export function tetraSTL(seam = 0) {
  const vertices = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  return 'solid tetra\n' + faces.map((face, index) => 'facet normal 0 0 0\nouter loop\n' + face.map(vertex => {
    const point = vertices[vertex].slice();
    if (index === 1 && vertex === 0) point[0] += seam;
    return `vertex ${point.join(' ')}\n`;
  }).join('') + 'endloop\nendfacet\n').join('') + 'endsolid tetra\n';
}
