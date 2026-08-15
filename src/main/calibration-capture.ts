import { createHash } from "node:crypto";

import { describeSourceCamera } from "../shared/color-trust.ts";
import type { ColorCardCaptureContext } from "../shared/contracts.ts";
import type { ColorCardFitSummary } from "../shared/processing-contracts.ts";

export interface GeneratedCalibrationCaptureIdentity {
  readonly cameraModel: string;
  readonly decoderFingerprint: string;
  readonly demosaic: string;
  readonly lens: string;
  readonly filmStock: string;
  readonly process: string;
  readonly illuminationId: string;
  readonly captureFingerprint: string;
}

export function createGeneratedCalibrationCaptureIdentity(
  fit: Pick<ColorCardFitSummary, "camera" | "decoder" | "decoderFingerprint">,
  context: ColorCardCaptureContext = {},
): GeneratedCalibrationCaptureIdentity {
  const decoderFingerprint = fit.decoderFingerprint ?? fit.decoder;
  const cameraModel = describeSourceCamera(fit.camera) ?? "Unknown camera";
  const demosaic = fit.decoder === "libraw-sidecar"
    ? decoderFingerprint.split("+").slice(1).join("+") || "unknown"
    : "not-applicable";
  // Keep unknown capture conditions explicit. They participate in the
  // fingerprint, so a profile cannot be accidentally reused after the
  // operator records a different lens, stock, process or light source.
  const captureContext = {
    lens: cleanContext(context.lens) ?? "unspecified",
    filmStock: cleanContext(context.filmStock) ?? "unspecified",
    process: cleanContext(context.process) ?? "unspecified",
    illuminationId: cleanContext(context.illuminationId) ?? "unspecified",
  };
  const captureFingerprint = "filmlab-capture-v1/" + createHash("sha256")
    .update(JSON.stringify({ cameraModel, decoderFingerprint, demosaic, ...captureContext }))
    .digest("hex");
  return { cameraModel, decoderFingerprint, demosaic, ...captureContext, captureFingerprint };
}

function cleanContext(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}
