import type { ColorDomain, Rgb } from "./types.ts";

export class Raster {
  public readonly data: Float32Array;
  public readonly width: number;
  public readonly height: number;
  public readonly domain: ColorDomain;

  public constructor(
    width: number,
    height: number,
    domain: ColorDomain,
    data?: Float32Array,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error("Raster dimensions must be positive integers.");
    }

    const expectedLength = width * height * 3;
    if (data !== undefined && data.length !== expectedLength) {
      throw new Error("Raster data length must be " + expectedLength + ", got " + data.length + ".");
    }

    this.data = data === undefined ? new Float32Array(expectedLength) : data;
    this.width = width;
    this.height = height;
    this.domain = domain;
  }

  public static filled(
    width: number,
    height: number,
    domain: ColorDomain,
    value: Rgb,
  ): Raster {
    const raster = new Raster(width, height, domain);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 3;
      raster.data[offset] = value[0];
      raster.data[offset + 1] = value[1];
      raster.data[offset + 2] = value[2];
    }
    return raster;
  }

  public offset(x: number, y: number): number {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new Error("Pixel (" + x + ", " + y + ") is outside the raster.");
    }
    return (y * this.width + x) * 3;
  }

  public getPixel(x: number, y: number): Rgb {
    const offset = this.offset(x, y);
    return [this.data[offset], this.data[offset + 1], this.data[offset + 2]];
  }

  public setPixel(x: number, y: number, value: Rgb): void {
    const offset = this.offset(x, y);
    this.data[offset] = value[0];
    this.data[offset + 1] = value[1];
    this.data[offset + 2] = value[2];
  }

  public clone(domain: ColorDomain = this.domain): Raster {
    return new Raster(this.width, this.height, domain, new Float32Array(this.data));
  }

  public assertDomain(expected: ColorDomain | readonly ColorDomain[]): void {
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(this.domain)) {
      throw new Error("Expected " + allowed.join(" or ") + ", received " + this.domain + ".");
    }
  }
}
