// Minimal ZIP writer (stored / no compression) — enough to bundle a handful of
// small JSON files into a downloadable archive without pulling in a dependency.
// Verified byte-compatible with `unzip`. Not a general-purpose zip library.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

export interface ZipFile {
  name: string;
  content: string | Uint8Array;
}

/** Build a `.zip` Blob (stored entries) from in-memory files. */
export function makeZip(files: ZipFile[]): Blob {
  const enc = new TextEncoder();
  // ArrayBuffer-backed (not SharedArrayBuffer) so the parts satisfy `BlobPart`.
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.content === "string" ? enc.encode(f.content) : new Uint8Array(f.content);
    const crc = crc32(data);
    const size = data.length;

    const localHeader = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length), ...u16(0),
    ]);
    parts.push(localHeader, nameBytes, data);

    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length),
        ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]),
      nameBytes,
    );
    offset += localHeader.length + nameBytes.length + size;
  }

  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0),
  ]);

  return new Blob([...parts, ...central, eocd], { type: "application/zip" });
}
