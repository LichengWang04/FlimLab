#!/usr/bin/env node

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const sharp = require("sharp");

const root = resolve(__dirname, "..");
const source = join(root, "build", "icon.svg");
const output = join(root, "build", "generated");

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  await mkdir(output, { recursive: true });
  const svg = await readFile(source);
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = new Map();
  for (const size of sizes) {
    pngs.set(size, await sharp(svg).resize(size, size).png().toBuffer());
  }
  await Promise.all([
    writeFile(join(output, "icon.png"), pngs.get(1024)),
    writeFile(join(output, "icon.ico"), encodeIco([16, 32, 48, 64, 128, 256].map((size) => [size, pngs.get(size)]))),
    writeFile(join(output, "icon.icns"), encodeIcns([
      ["icp4", pngs.get(16)], ["icp5", pngs.get(32)], ["icp6", pngs.get(64)],
      ["ic07", pngs.get(128)], ["ic08", pngs.get(256)], ["ic09", pngs.get(512)], ["ic10", pngs.get(1024)],
    ])),
  ]);
  console.log(`Release icons generated in ${output}`);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, png], index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, png]) => png)]);
}

function encodeIcns(images) {
  const chunks = images.map(([type, png]) => {
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}
