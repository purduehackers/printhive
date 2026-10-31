import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';

export interface ProjectEntry { name: string; content: string | AsyncIterable<Uint8Array> }

// Streaming OPC/ZIP container, with data descriptors so meshes never need buffering in RAM.
// The export budget keeps every entry and the archive below ZIP32's 4 GiB limit.
export async function writeProjectZip(path: string, entries: ProjectEntry[]) {
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const completion = finished(output);
  // Attach rejection handling immediately, including failures before the first write.
  void completion.catch(() => {});
  let position = 0;
  const directory: Buffer[] = [];
  async function write(bytes: Buffer | Uint8Array) {
    position += bytes.length;
    if (position >= 500_000_000) throw new Error('Project exceeds the export size limit.');
    if (!output.write(bytes)) await new Promise<void>((resolve, reject) => {
      output.once('drain', done); output.once('error', fail);
      function done() { output.off('error', fail); resolve(); }
      function fail(error: Error) { output.off('drain', done); reject(error); }
    });
  }
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name), offset = position;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x808, 6); header.writeUInt16LE(8, 8);
      header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
      await write(header); await write(name);
      let checksum = 0, uncompressed = 0;
      const source = Readable.from(typeof entry.content === 'string' ? [Buffer.from(entry.content)] : entry.content);
      const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        checksum = crc32(chunk, checksum); uncompressed += chunk.length; callback(null, chunk);
      } });
      const deflate = createDeflateRaw({ level: 1 });
      source.on('error', error => deflate.destroy(error));
      measure.on('error', error => deflate.destroy(error));
      source.pipe(measure).pipe(deflate);
      const start = position;
      try { for await (const chunk of deflate) await write(chunk); }
      finally { source.destroy(); measure.destroy(); deflate.destroy(); }
      const compressed = position - start;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(uncompressed, 12);
      await write(descriptor);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x808, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
      central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed, 20);
      central.writeUInt32LE(uncompressed, 24); central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42); directory.push(central, name);
    }
    const start = position;
    for (const chunk of directory) await write(chunk);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - start, 12); end.writeUInt32LE(start, 16);
    await write(end); output.end(); await completion;
    return position;
  } catch (error) { output.destroy(); await completion.catch(() => {}); throw error; }
}
