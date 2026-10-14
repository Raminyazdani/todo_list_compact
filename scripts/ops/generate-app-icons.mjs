// Original geometric graph mark; no external assets or runtime dependency.
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(
  new URL("../../public/icons/", import.meta.url),
);
const crc = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let n = 0; n < 8; n++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (type, bytes) => {
  const kind = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc(Buffer.concat([kind, bytes])));
  return Buffer.concat([size, kind, bytes, checksum]);
};
function png(size, inset) {
  const image = Buffer.alloc((size * 3 + 1) * size);
  const background = [21, 23, 28],
    accent = [91, 218, 192],
    center = [243, 247, 255];
  const points = [
    [0.5, 0.27],
    [0.3, 0.66],
    [0.7, 0.66],
  ].map(([x, y]) => [0.5 + (x - 0.5) * inset, 0.5 + (y - 0.5) * inset]);
  const distance = (x, y, a, b) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)),
    );
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sample = [0, 0, 0];
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const nx = (x + (sx + 0.5) / 2) / size,
            ny = (y + (sy + 0.5) / 2) / size;
          const node = points.findIndex(
            ([px, py]) => Math.hypot(nx - px, ny - py) < 0.075 * inset,
          );
          const edge =
            distance(nx, ny, points[0], points[1]) < 0.018 * inset ||
            distance(nx, ny, points[0], points[2]) < 0.018 * inset;
          const color =
            node === 0 ? center : node >= 0 || edge ? accent : background;
          for (let c = 0; c < 3; c++) sample[c] += color[c] / 4;
        }
      for (let c = 0; c < 3; c++)
        image[y * (size * 3 + 1) + 1 + x * 3 + c] = Math.round(sample[c]);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(image)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
await mkdir(directory, { recursive: true });
for (const [name, size, inset] of [
  ["life-os-192.png", 192, 1],
  ["life-os-512.png", 512, 1],
  ["life-os-maskable-512.png", 512, 0.8],
])
  await writeFile(
    new URL(name, new URL("../../public/icons/", import.meta.url)),
    png(size, inset),
  );
