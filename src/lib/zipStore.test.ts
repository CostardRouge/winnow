import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, zipStore } from "./zipStore";

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at, true);

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("local headers, the central directory and the end record agree", () => {
  const zip = zipStore([
    { name: "manifest.json", data: '{"a":1}' },
    { name: "server/é.mjs", data: new Uint8Array([1, 2, 3]) },
  ]);
  assert.equal(u32(zip, 0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(u32(zip, end), 0x06054b50);
  assert.equal(u16(zip, end + 10), 2);
  const central = u32(zip, end + 16);
  assert.equal(u32(zip, central), 0x02014b50);
  // The second entry's offset points at a local header holding its bytes.
  const secondCentral = central + 46 + "manifest.json".length;
  const local = u32(zip, secondCentral + 42);
  assert.equal(u32(zip, local), 0x04034b50);
  const nameLen = u16(zip, local + 26);
  assert.equal(new TextDecoder().decode(zip.slice(local + 30, local + 30 + nameLen)), "server/é.mjs");
  assert.deepEqual([...zip.slice(local + 30 + nameLen, local + 33 + nameLen)], [1, 2, 3]);
});

test("the same entries build the same bytes, and a name that climbs out is refused", () => {
  const entries = [{ name: "a.txt", data: "hi" }];
  assert.deepEqual(zipStore(entries), zipStore(entries));
  assert.throws(() => zipStore([{ name: "../x", data: "" }]), /bad entry name/);
  assert.throws(() => zipStore([{ name: "/x", data: "" }]), /bad entry name/);
});
