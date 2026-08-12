import assert from "node:assert/strict";
import test from "node:test";

import type { CalibrationProfileDocument } from "../src/core/calibration.ts";
import { createGeneratedCalibrationCaptureIdentity } from "../src/main/calibration-capture.ts";
import { colorTrustAllowsFormat, colorTrustMetadata, evaluateColorTrust } from "../src/shared/color-trust.ts";

const profile = {
  capture: {
    cameraModel: "Sony ILCE-7RM5",
    decoderFingerprint: "libraw-0.22+gpu-bayer-v1",
  },
} as CalibrationProfileDocument;

test("generic and default-preset output remain explicitly uncalibrated", () => {
  const source = {
    camera: { make: "Sony", model: "ILCE-7RM5" },
    decoderFingerprint: profile.capture.decoderFingerprint,
  };
  assert.deepEqual(evaluateColorTrust("generic", source, profile), {
    level: "uncalibrated",
    reason: "generic-mode",
  });
  assert.deepEqual(evaluateColorTrust("preset", source, profile), {
    level: "uncalibrated",
    reason: "default-preset",
  });
});

test("calibrated output becomes device-matched only when camera and decoder match", () => {
  const matched = evaluateColorTrust("calibrated", {
    camera: { make: "Sony", model: "ILCE-7RM5" },
    decoderFingerprint: profile.capture.decoderFingerprint,
  }, profile);
  assert.equal(matched.level, "device-matched");
  assert.equal(matched.reason, "device-match");
  assert.equal(matched.sourceCameraModel, "Sony ILCE-7RM5");
  assert.equal(colorTrustMetadata(matched).colorAccuracyClaim, "device-matched-linear-srgb-d65");
  assert.equal(colorTrustAllowsFormat("dng", matched), true);

  assert.equal(evaluateColorTrust("calibrated", {
    camera: { make: "Nikon", model: "Z 8" },
    decoderFingerprint: profile.capture.decoderFingerprint,
  }, profile).reason, "camera-mismatch");
  assert.equal(evaluateColorTrust("calibrated", {
    camera: { make: "Sony", model: "ILCE-7RM5" },
    decoderFingerprint: "different-decoder",
  }, profile).reason, "decoder-mismatch");
});

test("calibrated output is unverified when source identity is incomplete", () => {
  const unverified = evaluateColorTrust("calibrated", {}, profile);
  assert.equal(unverified.reason, "source-camera-unavailable");
  assert.equal(colorTrustAllowsFormat("dng", unverified), false);
  assert.equal(colorTrustAllowsFormat("tiff", unverified), true);
  assert.equal(evaluateColorTrust("calibrated", {
    camera: { make: "Sony", model: "ILCE-7RM5" },
  }, profile).reason, "decoder-unavailable");
  assert.equal(evaluateColorTrust("calibrated", {}, undefined).reason, "calibration-profile-missing");
});

test("generated calibration capture identity records the real RAW camera chain", () => {
  const capture = createGeneratedCalibrationCaptureIdentity({
    decoder: "libraw-sidecar",
    decoderFingerprint: "libraw-0.22+bilinear-bayer-v1",
    camera: { make: "SONY", model: "ILCE-7RM5" },
  });
  assert.equal(capture.cameraModel, "SONY ILCE-7RM5");
  assert.equal(capture.demosaic, "bilinear-bayer-v1");
  assert.match(capture.captureFingerprint, /^filmlab-capture-v1\/[a-f0-9]{64}$/);
  assert.deepEqual(capture, createGeneratedCalibrationCaptureIdentity({
    decoder: "libraw-sidecar",
    decoderFingerprint: "libraw-0.22+bilinear-bayer-v1",
    camera: { make: "SONY", model: "ILCE-7RM5" },
  }));
});
