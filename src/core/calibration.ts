import { validateMonotonicCurve } from "./curves.ts";
import type {
  CalibrationProfile,
  CurvePoint,
  CurveSet,
  Lut3d,
  Matrix3,
  Rgb,
} from "./types.ts";

/**
 * The on-disk calibration profile format intentionally keeps its domain and
 * target explicit.  A profile calibrated for display RGB or a gamma-encoded
 * source must not silently be used by the linear film pipeline.
 */
export const calibrationProfileSchema = "filmlab.calibration-profile" as const;
export const calibrationProfileSchemaVersion = 1 as const;
export const calibrationSourceDomain = "relative-density-log10" as const;
export const calibrationTargetColorSpace = "linear-srgb-d65" as const;

export interface CalibrationCapture {
  readonly cameraModel: string;
  readonly lens?: string;
  readonly filmStock?: string;
  readonly process?: string;
  readonly illuminationId?: string;
  readonly decoderFingerprint: string;
  readonly demosaic: string;
}

export interface CalibrationLutDocument {
  readonly size: number;
  /** IEEE-754 Float32 values, little-endian, base64 encoded. */
  readonly encoding: "f32le-base64";
  readonly data: string;
  readonly domainMin?: Rgb;
  readonly domainMax?: Rgb;
}

export interface CalibrationTransformDocument {
  readonly sourceDomain: typeof calibrationSourceDomain;
  readonly targetColorSpace: typeof calibrationTargetColorSpace;
  readonly curves: CurveSet;
  readonly matrix: Matrix3;
  readonly lut?: CalibrationLutDocument;
}

export interface CalibrationFitDocument {
  readonly algorithm: string;
  readonly patchCount: number;
  readonly rejectedPatchIds?: readonly string[];
  readonly trainMedianDeltaE?: number;
  readonly validationMedianDeltaE?: number;
  readonly warnings?: readonly string[];
}

export interface CalibrationProfileDocument {
  readonly schema: typeof calibrationProfileSchema;
  readonly schemaVersion: typeof calibrationProfileSchemaVersion;
  readonly id: string;
  /** Human-readable label; normalized to id for early profiles that omit it. */
  readonly name: string;
  readonly version: string;
  readonly calibrationId: string;
  readonly createdAt: string;
  /** A stable identifier for the complete capture setup. */
  readonly captureFingerprint: string;
  readonly capture: CalibrationCapture;
  readonly transform: CalibrationTransformDocument;
  readonly fit: CalibrationFitDocument;
}

export interface CreateCalibrationProfileOptions {
  readonly name?: string;
  readonly createdAt: string;
  readonly capture: CalibrationCapture;
  readonly fit: CalibrationFitDocument;
}

export interface CubeParseOptions {
  /** 33 is a practical upper bound for a portable profile file. */
  readonly maximumSize?: number;
}

export interface ColorChartPatch {
  /** Stable patch id, e.g. the ColorChecker patch name. */
  readonly id?: string;
  /** g(d), after the per-channel inverse characteristic curves. */
  readonly source: Rgb;
  /** Reference linear sRGB D65 value for the same patch. */
  readonly target: Rgb;
  /** Relative confidence. Omit for one. */
  readonly weight?: number;
  /** Excluded patches are reported but do not affect the fit. */
  readonly include?: boolean;
}

export interface MatrixFitOptions {
  /** Tikhonov regularization coefficient. Default is deliberately small. */
  readonly ridgeLambda?: number;
  /** Require at least this many included patches. Default is 18. */
  readonly minimumPatchCount?: number;
}

export interface MatrixFitResult {
  readonly matrix: Matrix3;
  readonly usedPatchCount: number;
  readonly rejectedPatchIds: readonly string[];
  readonly ridgeLambda: number;
  /** Weighted RGB root-mean-square residual in target linear RGB. */
  readonly weightedRmse: number;
}

const DEFAULT_RIDGE_LAMBDA = 1e-6;
const DEFAULT_MINIMUM_PATCH_COUNT = 18;
const DEFAULT_CUBE_MAXIMUM_SIZE = 33;

/**
 * Parse, validate and normalize a version-one profile document. Strings are
 * accepted for the convenient main-process import path; objects are accepted
 * for programmatic profile construction.
 */
export function parseCalibrationProfileDocument(input: unknown): CalibrationProfileDocument {
  const value = typeof input === "string" ? parseJson(input) : input;
  const record = asRecord(value, "Calibration profile must be a JSON object.");

  expectEqual(record.schema, calibrationProfileSchema, "schema");
  expectEqual(record.schemaVersion, calibrationProfileSchemaVersion, "schemaVersion");

  const id = readRequiredString(record.id, "id");
  const document: CalibrationProfileDocument = {
    schema: calibrationProfileSchema,
    schemaVersion: calibrationProfileSchemaVersion,
    id,
    name: readOptionalString(record.name, "name") ?? id,
    version: readRequiredString(record.version, "version"),
    calibrationId: readRequiredString(record.calibrationId, "calibrationId"),
    createdAt: readTimestamp(record.createdAt),
    captureFingerprint: readRequiredString(record.captureFingerprint, "captureFingerprint"),
    capture: parseCapture(record.capture),
    transform: parseTransform(record.transform),
    fit: parseFit(record.fit),
  };

  // Decoding the LUT here makes malformed base64 or float data fail during
  // import instead of much later in the renderer's processing path.
  if (document.transform.lut !== undefined) {
    decodeLut(document.transform.lut);
  }
  return document;
}

/** Serialize a validated document using a stable, human-readable layout. */
export function serializeCalibrationProfileDocument(input: CalibrationProfileDocument): string {
  const document = parseCalibrationProfileDocument(input);
  return JSON.stringify(document, null, 2) + "\n";
}

/** Convert the portable document to the pipeline's runtime calibration type. */
export function toRuntimeCalibrationProfile(
  input: CalibrationProfileDocument | unknown,
): CalibrationProfile {
  const document = parseCalibrationProfileDocument(input);
  return {
    id: document.id,
    version: document.version,
    calibrationId: document.calibrationId,
    captureFingerprint: document.captureFingerprint,
    curves: document.transform.curves,
    matrix: document.transform.matrix,
    lut: document.transform.lut === undefined ? undefined : decodeLut(document.transform.lut),
  };
}

/**
 * Package an existing runtime profile for durable storage. `captureFingerprint`
 * remains a caller-controlled value so a project can identify a particular
 * camera, light source, lens and decoder build exactly.
 */
export function createCalibrationProfileDocument(
  profile: CalibrationProfile,
  options: CreateCalibrationProfileOptions,
): CalibrationProfileDocument {
  const document: CalibrationProfileDocument = {
    schema: calibrationProfileSchema,
    schemaVersion: calibrationProfileSchemaVersion,
    id: profile.id,
    name: options.name ?? profile.id,
    version: profile.version,
    calibrationId: profile.calibrationId,
    createdAt: options.createdAt,
    captureFingerprint: profile.captureFingerprint,
    capture: options.capture,
    transform: {
      sourceDomain: calibrationSourceDomain,
      targetColorSpace: calibrationTargetColorSpace,
      curves: cloneCurveSet(profile.curves),
      matrix: cloneMatrix(profile.matrix),
      lut: profile.lut === undefined ? undefined : encodeLut(profile.lut),
    },
    fit: options.fit,
  };
  return parseCalibrationProfileDocument(document);
}

/**
 * Parse an Adobe .cube 3D LUT. Cube rows are read in their specified order:
 * red-major, green-major, blue-fastest, which is the same layout consumed by
 * `sampleLut3d` in transforms.ts.  1D shaper LUTs are rejected because they
 * cannot be represented safely as this pipeline's 3D correction.
 */
export function parseCubeLut(source: string, options: CubeParseOptions = {}): Lut3d {
  if (typeof source !== "string") {
    throw new Error("CUBE input must be text.");
  }
  const maximumSize = options.maximumSize ?? DEFAULT_CUBE_MAXIMUM_SIZE;
  if (!Number.isInteger(maximumSize) || maximumSize < 2) {
    throw new Error("CUBE maximumSize must be an integer of at least two.");
  }

  let size: number | undefined;
  let domainMin: Rgb = [0, 0, 0];
  let domainMax: Rgb = [1, 1, 1];
  const values: number[] = [];
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].replace(/#.*/, "").trim();
    if (stripped.length === 0) {
      continue;
    }
    const tokens = stripped.split(/\s+/);
    const directive = tokens[0].toUpperCase();
    const location = "CUBE line " + (index + 1) + ": ";

    if (directive === "TITLE") {
      if (values.length > 0) {
        throw new Error(location + "TITLE must appear before LUT rows.");
      }
      continue;
    }
    if (directive === "LUT_1D_SIZE") {
      throw new Error(location + "1D CUBE LUTs are not supported; import a 3D LUT.");
    }
    if (directive === "LUT_3D_SIZE") {
      if (values.length > 0 || size !== undefined) {
        throw new Error(location + "LUT_3D_SIZE must appear once before LUT rows.");
      }
      if (tokens.length !== 2) {
        throw new Error(location + "LUT_3D_SIZE requires one integer.");
      }
      size = parseInteger(tokens[1], location + "LUT_3D_SIZE");
      if (size < 2 || size > maximumSize) {
        throw new Error(location + "LUT_3D_SIZE must be between 2 and " + maximumSize + ".");
      }
      continue;
    }
    if (directive === "DOMAIN_MIN" || directive === "DOMAIN_MAX") {
      if (values.length > 0) {
        throw new Error(location + directive + " must appear before LUT rows.");
      }
      const value = parseRgbTokens(tokens.slice(1), location + directive);
      if (directive === "DOMAIN_MIN") {
        domainMin = value;
      } else {
        domainMax = value;
      }
      continue;
    }

    if (size === undefined) {
      throw new Error(location + "expected LUT_3D_SIZE before LUT rows.");
    }
    const row = parseRgbTokens(tokens, location + "LUT row");
    values.push(row[0], row[1], row[2]);
  }

  if (size === undefined) {
    throw new Error("CUBE file does not declare LUT_3D_SIZE.");
  }
  if (domainMax[0] <= domainMin[0] || domainMax[1] <= domainMin[1] || domainMax[2] <= domainMin[2]) {
    throw new Error("CUBE DOMAIN_MAX must be greater than DOMAIN_MIN for every channel.");
  }
  const expectedLength = size * size * size * 3;
  if (values.length !== expectedLength) {
    throw new Error(
      "CUBE LUT_3D_SIZE " + size + " requires " + (expectedLength / 3) + " RGB rows; received " + (values.length / 3) + ".",
    );
  }
  const data = new Float32Array(values);
  if (data.some((value) => !Number.isFinite(value))) {
    throw new Error("CUBE LUT contains a value outside Float32 range.");
  }
  return { size, data, domainMin, domainMax };
}

/**
 * Fit M in `target = M * source` using weighted ridge regression, with no
 * intercept. The lack of an intercept is intentional: film-base density has
 * already been removed before the calibrated transform is applied.
 */
export function fitColorChartMatrix(
  patches: readonly ColorChartPatch[],
  options: MatrixFitOptions = {},
): MatrixFitResult {
  if (!Array.isArray(patches)) {
    throw new Error("Color-chart patches must be an array.");
  }
  const ridgeLambda = options.ridgeLambda ?? DEFAULT_RIDGE_LAMBDA;
  const minimumPatchCount = options.minimumPatchCount ?? DEFAULT_MINIMUM_PATCH_COUNT;
  if (!Number.isFinite(ridgeLambda) || ridgeLambda < 0) {
    throw new Error("ridgeLambda must be a finite, non-negative number.");
  }
  if (!Number.isInteger(minimumPatchCount) || minimumPatchCount < 3) {
    throw new Error("minimumPatchCount must be an integer of at least three.");
  }

  const normal = zeroMatrix();
  const rightHand = zeroMatrix();
  const accepted: Array<{ source: Rgb; target: Rgb; weight: number }> = [];
  const rejectedPatchIds: string[] = [];
  const seenIds = new Set<string>();

  patches.forEach((patch, index) => {
    const id = patch.id ?? "patch-" + (index + 1);
    if (seenIds.has(id)) {
      throw new Error("Color-chart patch ids must be unique; duplicate: " + id + ".");
    }
    seenIds.add(id);
    validateRgb(patch.source, "source for " + id);
    validateRgb(patch.target, "target for " + id);

    if (patch.include === false) {
      rejectedPatchIds.push(id);
      return;
    }
    const weight = patch.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error("weight for " + id + " must be a finite positive number.");
    }
    accepted.push({ source: patch.source, target: patch.target, weight });
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        normal[row][column] += weight * patch.source[row] * patch.source[column];
        rightHand[row][column] += weight * patch.target[row] * patch.source[column];
      }
    }
  });

  if (accepted.length < minimumPatchCount) {
    throw new Error(
      "At least " + minimumPatchCount + " included color-chart patches are required; received " + accepted.length + ".",
    );
  }
  for (let channel = 0; channel < 3; channel += 1) {
    normal[channel][channel] += ridgeLambda;
  }

  const matrix: Matrix3 = [
    solveLinear3(normal, rightHand[0]),
    solveLinear3(normal, rightHand[1]),
    solveLinear3(normal, rightHand[2]),
  ];

  let weightedSquaredError = 0;
  let totalWeight = 0;
  for (const patch of accepted) {
    const predicted = multiplyMatrix(matrix, patch.source);
    for (let channel = 0; channel < 3; channel += 1) {
      const error = predicted[channel] - patch.target[channel];
      weightedSquaredError += patch.weight * error * error;
    }
    totalWeight += patch.weight;
  }

  return {
    matrix,
    usedPatchCount: accepted.length,
    rejectedPatchIds,
    ridgeLambda,
    weightedRmse: Math.sqrt(weightedSquaredError / (totalWeight * 3)),
  };
}

/** A concise alias for service-layer code that works with calibration profiles. */
export const fitCalibrationMatrix = fitColorChartMatrix;

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON error";
    throw new Error("Calibration profile is not valid JSON: " + detail);
  }
}

function parseCapture(value: unknown): CalibrationCapture {
  const record = asRecord(value, "capture must be an object.");
  return {
    cameraModel: readRequiredString(record.cameraModel, "capture.cameraModel"),
    lens: readOptionalString(record.lens, "capture.lens"),
    filmStock: readOptionalString(record.filmStock, "capture.filmStock"),
    process: readOptionalString(record.process, "capture.process"),
    illuminationId: readOptionalString(record.illuminationId, "capture.illuminationId"),
    decoderFingerprint: readRequiredString(record.decoderFingerprint, "capture.decoderFingerprint"),
    demosaic: readRequiredString(record.demosaic, "capture.demosaic"),
  };
}

function parseTransform(value: unknown): CalibrationTransformDocument {
  const record = asRecord(value, "transform must be an object.");
  expectEqual(record.sourceDomain, calibrationSourceDomain, "transform.sourceDomain");
  expectEqual(record.targetColorSpace, calibrationTargetColorSpace, "transform.targetColorSpace");
  return {
    sourceDomain: calibrationSourceDomain,
    targetColorSpace: calibrationTargetColorSpace,
    curves: parseCurveSet(record.curves),
    matrix: parseMatrix(record.matrix, "transform.matrix"),
    lut: record.lut === undefined ? undefined : parseLutDocument(record.lut),
  };
}

function parseFit(value: unknown): CalibrationFitDocument {
  const record = asRecord(value, "fit must be an object.");
  const patchCount = readInteger(record.patchCount, "fit.patchCount", 0);
  return {
    algorithm: readRequiredString(record.algorithm, "fit.algorithm"),
    patchCount,
    rejectedPatchIds: readOptionalStringArray(record.rejectedPatchIds, "fit.rejectedPatchIds"),
    trainMedianDeltaE: readOptionalFiniteNumber(record.trainMedianDeltaE, "fit.trainMedianDeltaE"),
    validationMedianDeltaE: readOptionalFiniteNumber(record.validationMedianDeltaE, "fit.validationMedianDeltaE"),
    warnings: readOptionalStringArray(record.warnings, "fit.warnings"),
  };
}

function parseCurveSet(value: unknown): CurveSet {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("transform.curves must contain exactly three channel curves.");
  }
  const curves = value.map((channel, channelIndex) => {
    if (!Array.isArray(channel)) {
      throw new Error("transform.curves[" + channelIndex + "] must be an array.");
    }
    const points: CurvePoint[] = channel.map((rawPoint, pointIndex) => {
      const point = asRecord(rawPoint, "transform.curves[" + channelIndex + "][" + pointIndex + "] must be an object.");
      return {
        x: readFiniteNumber(point.x, "transform.curves[" + channelIndex + "][" + pointIndex + "].x"),
        y: readFiniteNumber(point.y, "transform.curves[" + channelIndex + "][" + pointIndex + "].y"),
      };
    });
    validateMonotonicCurve(points);
    return points;
  });
  return [curves[0], curves[1], curves[2]];
}

function parseMatrix(value: unknown, name: string): Matrix3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(name + " must contain exactly three rows.");
  }
  return [
    parseRgb(value[0], name + "[0]"),
    parseRgb(value[1], name + "[1]"),
    parseRgb(value[2], name + "[2]"),
  ];
}

function parseLutDocument(value: unknown): CalibrationLutDocument {
  const record = asRecord(value, "transform.lut must be an object.");
  const size = readInteger(record.size, "transform.lut.size", 2);
  if (size > DEFAULT_CUBE_MAXIMUM_SIZE) {
    throw new Error("transform.lut.size must not exceed " + DEFAULT_CUBE_MAXIMUM_SIZE + ".");
  }
  expectEqual(record.encoding, "f32le-base64", "transform.lut.encoding");
  const document: CalibrationLutDocument = {
    size,
    encoding: "f32le-base64",
    data: readRequiredString(record.data, "transform.lut.data"),
    domainMin: record.domainMin === undefined ? undefined : parseRgb(record.domainMin, "transform.lut.domainMin"),
    domainMax: record.domainMax === undefined ? undefined : parseRgb(record.domainMax, "transform.lut.domainMax"),
  };
  if (document.domainMin !== undefined && document.domainMax !== undefined) {
    for (let channel = 0; channel < 3; channel += 1) {
      if (document.domainMax[channel] <= document.domainMin[channel]) {
        throw new Error("transform.lut domainMax must exceed domainMin for every channel.");
      }
    }
  }
  return document;
}

function encodeLut(lut: Lut3d): CalibrationLutDocument {
  validateLut(lut);
  const buffer = new ArrayBuffer(lut.data.length * 4);
  const view = new DataView(buffer);
  for (let index = 0; index < lut.data.length; index += 1) {
    view.setFloat32(index * 4, lut.data[index], true);
  }
  return {
    size: lut.size,
    encoding: "f32le-base64",
    data: encodeBase64(new Uint8Array(buffer)),
    domainMin: lut.domainMin === undefined ? undefined : cloneRgb(lut.domainMin),
    domainMax: lut.domainMax === undefined ? undefined : cloneRgb(lut.domainMax),
  };
}

function decodeLut(document: CalibrationLutDocument): Lut3d {
  const expectedBytes = document.size * document.size * document.size * 3 * 4;
  const bytes = decodeBase64(document.data);
  if (bytes.length !== expectedBytes) {
    throw new Error(
      "transform.lut.data has " + bytes.length + " bytes; expected " + expectedBytes + " for size " + document.size + ".",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(document.size * document.size * document.size * 3);
  for (let index = 0; index < data.length; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) {
      throw new Error("transform.lut.data contains a non-finite Float32 value.");
    }
    data[index] = value;
  }
  return {
    size: document.size,
    data,
    domainMin: document.domainMin === undefined ? undefined : cloneRgb(document.domainMin),
    domainMax: document.domainMax === undefined ? undefined : cloneRgb(document.domainMax),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    result += alphabet[first >> 2];
    result += alphabet[((first & 0x03) << 4) | (second >> 4)];
    result += index + 1 < bytes.length ? alphabet[((second & 0x0f) << 2) | (third >> 6)] : "=";
    result += index + 2 < bytes.length ? alphabet[third & 0x3f] : "=";
  }
  return result;
}

function decodeBase64(source: string): Uint8Array {
  const text = source.replace(/\s/g, "");
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error("transform.lut.data must be padded base64.");
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const a = alphabet.indexOf(text[index]);
    const b = alphabet.indexOf(text[index + 1]);
    const c = text[index + 2] === "=" ? 0 : alphabet.indexOf(text[index + 2]);
    const d = text[index + 3] === "=" ? 0 : alphabet.indexOf(text[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error("transform.lut.data contains invalid base64 characters.");
    }
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < output.length) output[offset] = (packed >> 16) & 0xff;
    offset += 1;
    if (offset < output.length) output[offset] = (packed >> 8) & 0xff;
    offset += 1;
    if (offset < output.length) output[offset] = packed & 0xff;
    offset += 1;
  }
  return output;
}

function zeroMatrix(): [[number, number, number], [number, number, number], [number, number, number]] {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
}

function solveLinear3(matrix: readonly (readonly number[])[], rightHand: readonly number[]): Rgb {
  const augmented = matrix.map((row, rowIndex) => [row[0], row[1], row[2], rightHand[rowIndex]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let candidate = column + 1; candidate < 3; candidate += 1) {
      if (Math.abs(augmented[candidate][column]) > Math.abs(augmented[pivot][column])) {
        pivot = candidate;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) {
      throw new Error("Color-chart matrix is singular; add more varied patches or increase ridgeLambda.");
    }
    if (pivot !== column) {
      const current = augmented[column];
      augmented[column] = augmented[pivot];
      augmented[pivot] = current;
    }
    const divisor = augmented[column][column];
    for (let item = column; item < 4; item += 1) {
      augmented[column][item] /= divisor;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let item = column; item < 4; item += 1) {
        augmented[row][item] -= factor * augmented[column][item];
      }
    }
  }
  const result: Rgb = [augmented[0][3], augmented[1][3], augmented[2][3]];
  validateRgb(result, "fitted matrix row");
  return result;
}

function multiplyMatrix(matrix: Matrix3, value: Rgb): Rgb {
  return [
    matrix[0][0] * value[0] + matrix[0][1] * value[1] + matrix[0][2] * value[2],
    matrix[1][0] * value[0] + matrix[1][1] * value[1] + matrix[1][2] * value[2],
    matrix[2][0] * value[0] + matrix[2][1] * value[1] + matrix[2][2] * value[2],
  ];
}

function cloneCurveSet(curves: CurveSet): CurveSet {
  return [
    curves[0].map((point) => ({ x: point.x, y: point.y })),
    curves[1].map((point) => ({ x: point.x, y: point.y })),
    curves[2].map((point) => ({ x: point.x, y: point.y })),
  ];
}

function cloneMatrix(matrix: Matrix3): Matrix3 {
  return [cloneRgb(matrix[0]), cloneRgb(matrix[1]), cloneRgb(matrix[2])];
}

function cloneRgb(value: Rgb): Rgb {
  return [value[0], value[1], value[2]];
}

function validateLut(lut: Lut3d): void {
  if (!Number.isInteger(lut.size) || lut.size < 2 || lut.size > DEFAULT_CUBE_MAXIMUM_SIZE) {
    throw new Error("3D LUT size must be an integer between 2 and " + DEFAULT_CUBE_MAXIMUM_SIZE + ".");
  }
  if (lut.data.length !== lut.size * lut.size * lut.size * 3) {
    throw new Error("3D LUT data length does not match its declared size.");
  }
  if (lut.data.some((value) => !Number.isFinite(value))) {
    throw new Error("3D LUT data must be finite.");
  }
  if (lut.domainMin !== undefined) validateRgb(lut.domainMin, "LUT domainMin");
  if (lut.domainMax !== undefined) validateRgb(lut.domainMax, "LUT domainMax");
  if (lut.domainMin !== undefined && lut.domainMax !== undefined) {
    for (let channel = 0; channel < 3; channel += 1) {
      if (lut.domainMax[channel] <= lut.domainMin[channel]) {
        throw new Error("LUT domainMax must exceed domainMin for every channel.");
      }
    }
  }
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function expectEqual(value: unknown, expected: string | number, name: string): void {
  if (value !== expected) {
    throw new Error(name + " must be " + JSON.stringify(expected) + ".");
  }
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(name + " must be a non-empty string.");
  }
  return value;
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredString(value, name);
}

function readOptionalStringArray(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(name + " must be an array of non-empty strings.");
  }
  return value.map((item, index) => readRequiredString(item, name + "[" + index + "]"));
}

function readFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(name + " must be a finite number.");
  }
  return value;
}

function readOptionalFiniteNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return readFiniteNumber(value, name);
}

function readInteger(value: unknown, name: string, minimum: number): number {
  const number = readFiniteNumber(value, name);
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(name + " must be an integer of at least " + minimum + ".");
  }
  return number;
}

function readTimestamp(value: unknown): string {
  const timestamp = readRequiredString(value, "createdAt");
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error("createdAt must be an ISO-8601 timestamp.");
  }
  return timestamp;
}

function parseRgb(value: unknown, name: string): Rgb {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(name + " must contain exactly three finite numbers.");
  }
  return [
    readFiniteNumber(value[0], name + "[0]"),
    readFiniteNumber(value[1], name + "[1]"),
    readFiniteNumber(value[2], name + "[2]"),
  ];
}

function parseRgbTokens(tokens: readonly string[], name: string): Rgb {
  if (tokens.length !== 3) {
    throw new Error(name + " requires exactly three numeric values.");
  }
  return [
    parseFiniteNumber(tokens[0], name + "[0]"),
    parseFiniteNumber(tokens[1], name + "[1]"),
    parseFiniteNumber(tokens[2], name + "[2]"),
  ];
}

function parseInteger(value: string, name: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new Error(name + " must be an integer.");
  }
  return Number(value);
}

function parseFiniteNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(name + " must be a finite number.");
  }
  return parsed;
}

function validateRgb(value: Rgb, name: string): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((channel) => !Number.isFinite(channel))) {
    throw new Error(name + " must contain exactly three finite numbers.");
  }
}
