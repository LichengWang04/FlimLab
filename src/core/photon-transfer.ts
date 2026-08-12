import type { PhotonTransferModel, Rgb } from "./types.ts";

const sonyA7RvIso100 = {
  profileId: "photons-to-photos:sony-ilce-7rm5:iso100:2026-06-24",
  cameraModel: "Sony ILCE-7RM5",
  iso: 100,
  bitDepth: 14,
  readNoiseDn: 1.368,
  electronsPerDn: 2.759,
  prnu: 0.0038,
} as const;

export interface PhotonTransferMatchInput {
  readonly cameraModel?: string;
  readonly iso?: number;
  readonly normalizationRangeDn?: Rgb;
}

/**
 * Selects an exact operating-point match. A PTC measured at ISO 100 must not
 * be silently reused for the A7R V's ISO 320 high-conversion-gain mode.
 */
export function matchPhotonTransferModel(
  input: PhotonTransferMatchInput,
): PhotonTransferModel | undefined {
  if (
    input.cameraModel === undefined
    || !/(?:^|\s)ILCE-7RM5$/i.test(input.cameraModel.trim())
    || input.iso === undefined
    || Math.abs(input.iso - sonyA7RvIso100.iso) > 0.5
    || input.normalizationRangeDn === undefined
    || !isNormalizationRange(input.normalizationRangeDn)
  ) {
    return undefined;
  }
  return { ...sonyA7RvIso100, normalizationRangeDn: [...input.normalizationRangeDn] as Rgb };
}

/** Total PTC noise sigma in normalized decoder-linear units. */
export function photonTransferNoiseSigma(
  signal: number,
  normalizationRangeDn: number,
  model: Pick<PhotonTransferModel, "readNoiseDn" | "electronsPerDn" | "prnu">,
): number {
  if (
    !Number.isFinite(signal)
    || !Number.isFinite(normalizationRangeDn)
    || normalizationRangeDn <= 0
    || !Number.isFinite(model.readNoiseDn)
    || model.readNoiseDn < 0
    || !Number.isFinite(model.electronsPerDn)
    || model.electronsPerDn <= 0
    || !Number.isFinite(model.prnu)
    || model.prnu < 0
  ) {
    throw new Error("Photon-transfer inputs must be finite and physically valid.");
  }
  const signalDn = Math.max(0, signal) * normalizationRangeDn;
  const varianceDn = model.readNoiseDn * model.readNoiseDn
    + signalDn / model.electronsPerDn
    + Math.pow(model.prnu * signalDn, 2);
  return Math.sqrt(varianceDn) / normalizationRangeDn;
}

/**
 * Regularizes the logarithm's input by its measured one-sigma uncertainty.
 * Above roughly 5 sigma this changes the sample by less than 2%; below the
 * reliable floor it prevents random channel noise from becoming strong colour.
 */
export function regularizePhotonTransferSignal(
  signal: number,
  normalizationRangeDn: number,
  model: Pick<PhotonTransferModel, "readNoiseDn" | "electronsPerDn" | "prnu">,
): number {
  const positiveSignal = Math.max(0, signal);
  const sigma = photonTransferNoiseSigma(positiveSignal, normalizationRangeDn, model);
  return Math.sqrt(positiveSignal * positiveSignal + sigma * sigma);
}

function isNormalizationRange(value: Rgb): boolean {
  // The published A7R V operating point is explicitly 14 bit. Requiring more
  // than an effective 13-bit range prevents 12-bit RAW modes from inheriting
  // DN-domain coefficients measured for 14-bit data.
  return value.every((item) => Number.isFinite(item) && item > 8_191 && item <= 65_535);
}
