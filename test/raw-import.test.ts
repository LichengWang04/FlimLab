import assert from "node:assert/strict";
import { extname } from "node:path";
import { describe, it } from "node:test";
import { downscaleRaster, Raster } from "../src/core/index.ts";
import { decodeRawSource, isRawExtension, probeRawSource, rawImageToRaster } from "../src/main/raw-decode.ts";
import type { LibRawImageData } from "libraw-wasm";

describe("Camera RAW import", () => {
  it("recognizes the public Canon, Nikon, Panasonic and Sony extensions", () => {
    for (const extension of [".cr2", ".CR2", ".nef", ".NEF", ".rw2", ".RW2", ".arw", ".ARW"]) {
      assert.equal(isRawExtension(extension), true);
    }
    assert.equal(isRawExtension(".jpg"), false);
  });

  it("converts RAW and area-downscales without changing a Float32 sample", () => {
    const width = 19;
    const height = 13;
    const colors = 4;
    const data = new Uint16Array(width * height * colors);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 1291 + 73) & 0xffff;
    const image = { width, height, colors, bits: 16, dataSize: data.byteLength, data } satisfies LibRawImageData;
    const legacy = new Raster(width, height, "transmission-linear");
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        legacy.data[pixel * 3 + channel] = Math.fround(data[pixel * colors + channel]! / 65_535);
      }
    }
    const expected = downscaleRaster(legacy, 7);
    const fused = rawImageToRaster(image, 7);
    assert.equal(fused.width, expected.width);
    assert.equal(fused.height, expected.height);
    assert.deepEqual(fused.data, expected.data);
  });

  const fixture = process.env["FILMLAB_RAW_FIXTURE"];
  it("decodes an optional real RAW fixture as 16-bit linear RGB", { skip: fixture === undefined }, async () => {
    const meta = await probeRawSource(fixture!);
    const decoded = await decodeRawSource(fixture!, 1600);
    assert.equal(meta.depth, 16);
    assert.equal(meta.format, extname(fixture!).slice(1).toLowerCase());
    assert.ok(decoded.raster.width <= 1600 && decoded.raster.height <= 1600);
    assert.equal(decoded.raster.data.length, decoded.raster.width * decoded.raster.height * 3);
    assert.ok(decoded.raster.data.some((value) => value > 0 && value < 1));
  });
});
