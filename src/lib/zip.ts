// Minimal streaming ZIP archive writer (store / no compression).
//
// Used to bundle an export's RAW copies into a single download from the browser
// (cf. /api/exports/:id/download). No third-party dependency: the archive is
// written by hand. We store (method 0, no deflate) because RAW/HEIF/video files
// are already incompressible — deflating them only burns CPU for ~0 gain.
//
// Each file is read once, fully, so the CRC-32 and exact size are known before
// the local header is emitted (no data descriptor needed → maximal reader
// compatibility). Peak memory is therefore one file at a time. ZIP64 fields are
// emitted only when a value overflows 32 bits (large file, or a central-dir
// offset past 4 GiB once the archive grows big enough), so small archives stay
// plain ZIP.
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

const U32 = 0xffffffff;

// CRC-32 (IEEE 802.3), table-driven. Self-contained so we don't depend on a
// particular Node version exposing zlib.crc32.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

// MS-DOS packed date/time (used by every ZIP record). Anything before 1980 is
// clamped to the epoch the format can represent.
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: 0x21 };
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { time, date };
}

export type ZipEntry = {
  /** Name (and relative path) stored in the archive. */
  name: string;
  /** Absolute path of the file to read. */
  absPath: string;
  /** Optional modification time (defaults to now). */
  mtime?: Date;
};

// Central-directory ZIP64 extra field: only the members that actually overflow
// 32 bits are present, in the fixed order (size, size, offset).
function zip64CentralExtra(size: number, offset: number): Buffer {
  const needSize = size >= U32;
  const needOffset = offset >= U32;
  if (!needSize && !needOffset) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  if (needSize) parts.push(u64(size), u64(size));
  if (needOffset) parts.push(u64(offset));
  const body = Buffer.concat(parts);
  const extra = Buffer.alloc(4 + body.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(body.length, 2);
  body.copy(extra, 4);
  return extra;
}

// Local-header ZIP64 extra field (both sizes, only when the file ≥ 4 GiB).
function zip64LocalExtra(size: number): Buffer {
  const body = Buffer.concat([u64(size), u64(size)]);
  const extra = Buffer.alloc(4 + body.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(body.length, 2);
  body.copy(extra, 4);
  return extra;
}

function localHeader(
  crc: number,
  size: number,
  nameBuf: Buffer,
  time: number,
  date: number,
  zip64: boolean,
): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); // local file header signature
  h.writeUInt16LE(zip64 ? 45 : 20, 4); // version needed
  h.writeUInt16LE(0x0800, 6); // flags: UTF-8 filename (bit 11)
  h.writeUInt16LE(0, 8); // method: store
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(zip64 ? U32 : size, 18); // compressed size
  h.writeUInt32LE(zip64 ? U32 : size, 22); // uncompressed size
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(zip64 ? 20 : 0, 28); // extra field length
  return h;
}

function centralHeader(
  crc: number,
  size: number,
  nameBuf: Buffer,
  time: number,
  date: number,
  localOffset: number,
): Buffer {
  const extra = zip64CentralExtra(size, localOffset);
  const zip64 = extra.length > 0;
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0); // central directory header signature
  h.writeUInt16LE(45, 4); // version made by
  h.writeUInt16LE(zip64 ? 45 : 20, 6); // version needed
  h.writeUInt16LE(0x0800, 8); // flags: UTF-8
  h.writeUInt16LE(0, 10); // method: store
  h.writeUInt16LE(time, 12);
  h.writeUInt16LE(date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(size >= U32 ? U32 : size, 20); // compressed size
  h.writeUInt32LE(size >= U32 ? U32 : size, 24); // uncompressed size
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(0, 32); // comment length
  h.writeUInt16LE(0, 34); // disk number start
  h.writeUInt16LE(0, 36); // internal attributes
  h.writeUInt32LE(0, 38); // external attributes
  h.writeUInt32LE(localOffset >= U32 ? U32 : localOffset, 42);
  return Buffer.concat([h, nameBuf, extra]);
}

function endOfCentralDir(
  count: number,
  centralSize: number,
  centralStart: number,
): Buffer {
  const needZip64 =
    count >= 0xffff || centralSize >= U32 || centralStart >= U32;
  const parts: Buffer[] = [];

  if (needZip64) {
    // ZIP64 end of central directory record.
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(BigInt(44), 4); // size of remaining record
    z.writeUInt16LE(45, 12); // version made by
    z.writeUInt16LE(45, 14); // version needed
    z.writeUInt32LE(0, 16); // this disk
    z.writeUInt32LE(0, 20); // disk with central dir
    z.writeBigUInt64LE(BigInt(count), 24); // entries on this disk
    z.writeBigUInt64LE(BigInt(count), 32); // total entries
    z.writeBigUInt64LE(BigInt(centralSize), 40);
    z.writeBigUInt64LE(BigInt(centralStart), 48);
    parts.push(z);

    // ZIP64 end of central directory locator.
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4); // disk with zip64 eocd
    loc.writeBigUInt64LE(BigInt(centralStart + centralSize), 8);
    loc.writeUInt32LE(1, 16); // total disks
    parts.push(loc);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(needZip64 ? 0xffff : count, 8);
  end.writeUInt16LE(needZip64 ? 0xffff : count, 10);
  end.writeUInt32LE(centralSize >= U32 ? U32 : centralSize, 12);
  end.writeUInt32LE(centralStart >= U32 ? U32 : centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length
  parts.push(end);

  return Buffer.concat(parts);
}

/**
 * Builds a store-only ZIP archive from `entries` as a web ReadableStream. Files
 * are read on demand (one at a time) while the stream is consumed, so the
 * archive starts flowing immediately and never holds more than a single file in
 * memory. Throws (mid-stream) if a listed file disappears before it is read.
 */
export function createZipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  async function* gen(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
      const data = await readFile(entry.absPath);
      const size = data.length;
      const crc = crc32(data);
      const nameBuf = Buffer.from(entry.name, "utf8");
      const { time, date } = dosDateTime(entry.mtime ?? new Date());
      const zip64 = size >= U32;

      const header = localHeader(crc, size, nameBuf, time, date, zip64);
      yield header;
      yield nameBuf;
      if (zip64) yield zip64LocalExtra(size);
      const localOffset = offset;
      offset += header.length + nameBuf.length + (zip64 ? 20 : 0);

      yield data;
      offset += size;

      central.push(centralHeader(crc, size, nameBuf, time, date, localOffset));
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const rec of central) {
      yield rec;
      centralSize += rec.length;
    }

    yield endOfCentralDir(central.length, centralSize, centralStart);
  }

  return Readable.toWeb(Readable.from(gen())) as ReadableStream<Uint8Array>;
}
