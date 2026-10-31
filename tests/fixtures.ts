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
