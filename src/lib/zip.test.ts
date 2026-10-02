// BE-03 (docs/CODEBASE-AUDIT.md): the ZIP writer read every entry whole with
// fs.readFile, which refuses anything over 2 GiB — a session holding one long
// clip ended its download mid-stream. Big entries are now streamed (a CRC pass,
// then the copy); these pin that the archive bytes do not depend on which path
// an entry took, that the result is a valid archive, and (opt-in, slow) that a
// > 2 GiB entry goes through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { createZipStream, type ZipEntry } from "./zip";

const run = promisify(execFile);
const mtime = new Date("2026-05-17T10:20:30Z");

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

async function fixture(): Promise<{ dir: string; entries: ZipEntry[]; bytes: Buffer[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "winnow-zip-test-"));
  const bytes = [randomBytes(10), Buffer.alloc(0), randomBytes(300_000), randomBytes(70_000)];
  const names = ["a.txt", "empty.bin", "DSC00001.ARW", "Café — été.jpg"];
  const entries: ZipEntry[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const absPath = path.join(dir, `f${i}`);
    await writeFile(absPath, bytes[i]);
    entries.push({ name: names[i], absPath, mtime });
  }
  return { dir, entries, bytes };
}

test("streamed and buffered entries produce byte-identical archives", async () => {
  const { dir, entries } = await fixture();
  try {
    const buffered = await collect(createZipStream(entries));
    const streamed = await collect(createZipStream(entries, { bufferMaxBytes: 0 }));
    assert.equal(streamed.length, buffered.length);
    assert.ok(streamed.equals(buffered), "same bytes whichever path an entry took");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const unzip = await run("unzip", ["-v"]).then(() => true, () => false);

test("the archive is valid and round-trips every entry", { skip: unzip ? false : "unzip not installed" }, async () => {
  const { dir, entries, bytes } = await fixture();
  try {
    const zipPath = path.join(dir, "out.zip");
    await writeFile(zipPath, await collect(createZipStream(entries, { bufferMaxBytes: 1000 })));
    const { stdout } = await run("unzip", ["-t", zipPath]);
    assert.match(stdout, /No errors detected/);
    for (let i = 0; i < entries.length; i++) {
      const { stdout: out } = await run("unzip", ["-p", zipPath, entries[i].name], {
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
      });
      assert.ok(Buffer.from(out).equals(bytes[i]), entries[i].name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Slow (reads 2.2 GB twice, from a sparse file, so no disk is used for the
// input); opt in with WINNOW_SLOW_TESTS=1.
test(
  "an entry over 2 GiB is archived instead of ending the stream",
  { skip: process.env.WINNOW_SLOW_TESTS === "1" ? false : "set WINNOW_SLOW_TESTS=1 to run" },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "winnow-zip-big-"));
    const big = path.join(dir, "C0001.MP4");
    const size = 2_362_232_012; // 2.2 GiB, past readFile's 2 GiB ceiling
    try {
      const fh = await open(big, "w");
      await fh.truncate(size);
      await fh.write(Buffer.from("tail"), 0, 4, size - 4); // not all zeros
      await fh.close();

      // Consume the archive without storing it: count bytes, keep the tail.
      let total = 0;
      let tail = Buffer.alloc(0);
      for await (const chunk of createZipStream([{ name: "C0001.MP4", absPath: big, mtime }])) {
        total += chunk.length;
        tail = Buffer.concat([tail, Buffer.from(chunk)]).subarray(-512);
      }

      let crc = 0;
      for await (const chunk of createReadStream(big)) crc = zlib.crc32(chunk as Buffer, crc);
      // Central directory header: signature, then CRC at offset 16.
      const cd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      assert.ok(cd >= 0, "central directory present");
      assert.equal(tail.readUInt32LE(cd + 16), crc >>> 0, "CRC matches the file");
      const name = Buffer.from("C0001.MP4");
      assert.equal(total, 30 + name.length + size + (46 + name.length) + 22, "archive length");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("an unreadable entry fails the stream instead of producing a short archive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "winnow-zip-test-"));
  try {
    await writeFile(path.join(dir, "ok"), "x");
    const stream = createZipStream([
      { name: "ok", absPath: path.join(dir, "ok"), mtime },
      { name: "gone", absPath: path.join(dir, "gone"), mtime },
    ]);
    await assert.rejects(collect(stream), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Keep the fixture helpers honest about what they wrote.
test("fixture bytes are what the archive reads back (sanity)", async () => {
  const { dir, entries, bytes } = await fixture();
  try {
    for (let i = 0; i < entries.length; i++)
      assert.ok((await readFile(entries[i].absPath)).equals(bytes[i]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
