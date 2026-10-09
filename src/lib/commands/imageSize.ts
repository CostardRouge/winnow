// The pixel size of a WebP, PNG or JPEG from its header bytes — what a
// command's picture answer states beside the base64 (`ImageResult.width/
// height`) without decoding the image. The MCP server reads derivatives over
// HTTP and carries no image library (no sharp in a client process), so this
// reads the few header bytes each format puts its size in. Pure.

export type ImageSize = {
  mimeType: "image/webp" | "image/png" | "image/jpeg";
  width: number;
  height: number;
};

function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}

export function imageSize(b: Uint8Array): ImageSize | null {
  // WebP: RIFF....WEBP, then the first chunk says which flavour.
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8X") {
      // Extended: canvas width-1 and height-1, 24 bits little-endian.
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { mimeType: "image/webp", width: w, height: h };
    }
    if (chunk === "VP8 ") {
      // Lossy: a key frame's start code 9d 01 2a, then 14-bit sizes.
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      const w = (b[26] | (b[27] << 8)) & 0x3fff;
      const h = (b[28] | (b[29] << 8)) & 0x3fff;
      return { mimeType: "image/webp", width: w, height: h };
    }
    if (chunk === "VP8L") {
      // Lossless: signature 0x2f, then width-1 and height-1 on 14 bits each.
      if (b[20] !== 0x2f) return null;
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return {
        mimeType: "image/webp",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
    return null;
  }
  // PNG: the IHDR chunk is first, width and height 32-bit big-endian.
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { mimeType: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0–SOF15, except DHT (c4), JPG (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return { mimeType: "image/jpeg", width: w, height: h };
      }
      i += 2 + len;
    }
  }
  return null;
}
