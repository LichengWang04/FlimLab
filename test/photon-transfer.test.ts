import assert from "node:assert/strict";
import test from "node:test";

import {
  matchPhotonTransferModel,
  photonTransferNoiseSigma,
  Raster,
  regularizePhotonTransferSignal,
  toRelativeDensity,
} from "../src/core/index.ts";

const ranges = [15_871, 15_871, 15_871] as const;

test("A7R V PTC matches only the measured ISO 100 operating point", () => {
  const model = matchPhotonTransferModel({
    cameraModel: "SONY ILCE-7RM5",
    iso: 100,
    normalizationRangeDn: ranges,
  });
  assert.ok(model);
  assert.equal(model.readNoiseDn, 1.368);
  assert.equal(model.electronsPerDn, 2.759);
  assert.equal(model.prnu, 0.0038);

  assert.equal(matchPhotonTransferModel({
    cameraModel: "SONY ILCE-7RM5",
    iso: 320,
    normalizationRangeDn: ranges,
  }), undefined);
  assert.equal(matchPhotonTransferModel({
    cameraModel: "SONY ILCE-7M5",
    iso: 100,
    normalizationRangeDn: ranges,
  }), undefined);
  assert.equal(matchPhotonTransferModel({
    cameraModel: "SONY ILCE-7RM5",
    iso: 100,
    normalizationRangeDn: [3_583, 3_583, 3_583],
  }), undefined);
});

test("PTC sigma combines read, shot and response non-uniformity noise", () => {
  const model = matchPhotonTransferModel({
    cameraModel: "Sony ILCE-7RM5",
    iso: 100,
    normalizationRangeDn: ranges,
  });
  assert.ok(model);
  const darkSigma = photonTransferNoiseSigma(0, ranges[0], model);
  assert.ok(Math.abs(darkSigma - 1.368 / ranges[0]) < 1e-12);
  assert.ok(photonTransferNoiseSigma(0.5, ranges[0], model) > darkSigma);
});

test("PTC regularization limits unreliable log-density colour without moving midtones", () => {
  const model = matchPhotonTransferModel({
    cameraModel: "Sony ILCE-7RM5",
    iso: 100,
    normalizationRangeDn: ranges,
  });
  assert.ok(model);
  const midtone = regularizePhotonTransferSignal(0.5, ranges[0], model);
  assert.ok(Math.abs(midtone - 0.5) < 0.00002);

  const source = new Raster(
    1,
    1,
    "transmission-linear-rgb",
    new Float32Array([0, 0.00001, 0.5]),
  );
  const unregularized = toRelativeDensity(source, [1, 1, 1]);
  const regularized = toRelativeDensity(source, [1, 1, 1], undefined, model);
  assert.ok(Number.isFinite(regularized.data[0]));
  assert.ok(Math.abs(regularized.data[0] - regularized.data[1])
    < Math.abs(unregularized.data[0] - unregularized.data[1]));
  assert.ok(Math.abs(regularized.data[2] - unregularized.data[2]) < 0.00002);
});
