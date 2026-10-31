import { inflateRawSync, crc32 } from 'node:zlib';

// Independent reader for generated/native ZIPs used by integration checks.
export function projectEntries(bytes: Buffer) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Missing ZIP directory');
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString();
    const start = bytes.readUInt32LE(offset + 42), size = bytes.readUInt32LE(offset + 20);
    const dataStart = start + 30 + bytes.readUInt16LE(start + 26) + bytes.readUInt16LE(start + 28);
    const data = bytes.subarray(dataStart, dataStart + size);
    const content = bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(data) : data;
    if (crc32(content) !== bytes.readUInt32LE(offset + 16)) throw new Error('ZIP checksum mismatch');
    entries.set(name, content.toString()); offset += 46 + length + extra + comment;
  }
  return entries;
}
