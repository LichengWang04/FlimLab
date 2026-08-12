import { createHash } from "node:crypto";

import { describeSourceCamera } from "../shared/color-trust.ts";
import type { ColorCardFitSummary } from "../shared/processing-contracts.ts";

export interface GeneratedCalibrationCaptureIdentity {
  readonly cameraModel: string;
  readonly decoderFingerprint: string;
  readonly demosaic: string;
  readonly captureFingerprint: string;
}

export function createGeneratedCalibrationCaptureIdentity(
  fit: Pick<ColorCardFitSummary, "camera" | "decoder" | "decoderFingerprint">,
): GeneratedCalibrationCaptureIdentity {
  const decoderFingerprint = fit.decoderFingerprint ?? fit.decoder;
  const cameraModel = describeSourceCamera(fit.camera) ?? "Unknown camera";
  const demosaic = fit.decoder === "libraw-sidecar"
    ? decoderFingerprint.split("+").slice(1).join("+") || "unknown"
    : "not-applicable";
  const captureFingerprint = "filmlab-capture-v1/" + createHash("sha256")
    .update(JSON.stringify({ cameraModel, decoderFingerprint, demosaic }))
    .digest("hex");
  return { cameraModel, decoderFingerprint, demosaic, captureFingerprint };
}
