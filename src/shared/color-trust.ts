import type { CalibrationProfileDocument } from "../core/calibration.ts";
import type { ColorTrust, MasterExportFormat, PreviewMode } from "./contracts.ts";
import type { DecodedSourceSummary, SourceCameraIdentity } from "./processing-contracts.ts";

export function evaluateColorTrust(
  mode: PreviewMode,
  source: Pick<DecodedSourceSummary, "camera" | "decoderFingerprint">,
  profile?: CalibrationProfileDocument,
): ColorTrust {
  if (mode === "generic") {
    return { level: "uncalibrated", reason: "generic-mode" };
  }
  if (profile === undefined) {
    return { level: "profile-unverified", reason: "calibration-profile-missing" };
  }

  const sourceCameraModel = describeSourceCamera(source.camera);
  const profileCameraModel = cleanCameraValue(profile.capture.cameraModel);
  const context = {
    ...(sourceCameraModel === undefined ? {} : { sourceCameraModel }),
    ...(profileCameraModel === undefined ? {} : { profileCameraModel }),
  };
  if (sourceCameraModel === undefined) {
    return { level: "profile-unverified", reason: "source-camera-unavailable", ...context };
  }
  if (profileCameraModel === undefined || isPlaceholderCamera(profileCameraModel)) {
    return { level: "profile-unverified", reason: "profile-camera-unavailable", ...context };
  }
  if (!cameraModelsMatch(source.camera, profileCameraModel)) {
    return { level: "profile-unverified", reason: "camera-mismatch", ...context };
  }
  if (source.decoderFingerprint === undefined) {
    return { level: "profile-unverified", reason: "decoder-unavailable", ...context };
  }
  if (source.decoderFingerprint !== profile.capture.decoderFingerprint) {
    return { level: "profile-unverified", reason: "decoder-mismatch", ...context };
  }
  const captureContext = [profile.capture.lens, profile.capture.filmStock, profile.capture.process, profile.capture.illuminationId];
  if (captureContext.some((value) => value !== undefined && value.trim().toLocaleLowerCase("en-US") === "unspecified")) {
    return { level: "profile-unverified", reason: "capture-context-unavailable", ...context };
  }
  return { level: "device-matched", reason: "device-match", ...context };
}

export function describeSourceCamera(camera: SourceCameraIdentity | undefined): string | undefined {
  const make = cleanCameraValue(camera?.make);
  const model = cleanCameraValue(camera?.model);
  if (make === undefined) return model;
  if (model === undefined) return make;
  return normalizeCamera(make) === normalizeCamera(model) || normalizeCamera(model).startsWith(normalizeCamera(make))
    ? model
    : make + " " + model;
}

export function colorTrustMetadata(trust: ColorTrust): Readonly<Record<string, string>> {
  return {
    colorTrust: trust.level,
    colorTrustReason: trust.reason,
    sourceCameraModel: trust.sourceCameraModel ?? "",
    calibrationCameraModel: trust.profileCameraModel ?? "",
    colorAccuracyClaim: trust.level === "device-matched"
      ? "device-matched-linear-srgb-d65"
      : "not-device-characterized",
  };
}

/** Used by isolated demos that intentionally have no verifiable capture device. */
export function uncharacterizedColorTrust(mode: PreviewMode): ColorTrust {
  if (mode === "generic") return { level: "uncalibrated", reason: "generic-mode" };
  return { level: "profile-unverified", reason: "source-camera-unavailable" };
}

export function colorTrustAllowsFormat(format: MasterExportFormat, trust: ColorTrust): boolean {
  return format !== "dng" || trust.level === "device-matched";
}

function cameraModelsMatch(camera: SourceCameraIdentity | undefined, profileCamera: string): boolean {
  const profile = normalizeCamera(profileCamera);
  const candidates = [camera?.model, describeSourceCamera(camera)]
    .map(cleanCameraValue)
    .filter((value): value is string => value !== undefined)
    .map(normalizeCamera);
  return candidates.some((candidate) => candidate === profile
    || candidate.endsWith(profile)
    || profile.endsWith(candidate));
}

function cleanCameraValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

function normalizeCamera(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function isPlaceholderCamera(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US");
  return normalized.includes("unknown camera") || normalized.includes("filmlab color-card workflow");
}
