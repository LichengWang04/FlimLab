import type {
  GpuPipelinePayload,
  PreviewMode,
  PreviewTone,
  PreviewView,
  ProcessingRecipe,
} from "../../shared/contracts.ts";
import type {
  CurvePoint,
  FilmMode,
  GeometrySettings,
  Lut3d,
  Matrix3,
  PerspectiveQuad,
  Rgb,
} from "../../core/types.ts";
import { maximumGpuCurvePoints } from "../../shared/gpu-film-compatibility.ts";
import {
  computeGeometryLayout,
  isIdentityPerspective,
  type GeometryLayout,
} from "./preview-layout.ts";
import { unpackEncodedMasterPixels } from "./gpu-master-readback.ts";

const cachedUniformLocations = new WeakMap<
  WebGLProgram,
  Map<string, WebGLUniformLocation>
>();
const identityPerspective: PerspectiveQuad = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};
const identityMatrix: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const identityCurves = [
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
] as const;

export interface GpuFilmFrame {
  readonly pipeline: GpuPipelinePayload;
  readonly processing: ProcessingRecipe;
  readonly mode: PreviewMode;
  readonly view: PreviewView;
  readonly tone: PreviewTone;
  readonly displayWhitePoint: number;
}

export interface GpuFilmRenderResult {
  readonly width: number;
  readonly height: number;
}

type GpuPipelineQuality = "preview" | "master";

interface PreviewRenderRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly cropLeft: number;
  readonly cropTop: number;
}

export interface PendingMasterTile {
  readonly outputY: number;
  readonly width: number;
  readonly height: number;
  readonly pixelBuffer?: WebGLBuffer;
  readonly fence?: WebGLSync;
  readonly rgba?: Uint16Array;
  readonly timerQuery?: WebGLQuery;
}

export interface GpuMasterTile {
  readonly outputY: number;
  readonly width: number;
  readonly height: number;
  readonly rgb16: Uint16Array;
}

export type GpuMasterTransfer = "srgb" | "linear";

/**
 * WebGL2 multipass film pipeline:
 * decoder-linear source -> geometry -> defect repair -> bilateral denoise ->
 * unsharp mask -> density/film transform/LUT -> tone/sRGB.
 */
export class WebGlFilmPipeline {
  private readonly framebuffer: WebGLFramebuffer;
  private readonly sourceTexture: WebGLTexture;
  private readonly targetTextures: readonly [WebGLTexture, WebGLTexture];
  private readonly displayTexture: WebGLTexture;
  private readonly encodedTexture: WebGLTexture;
  private readonly geometryProgram: WebGLProgram;
  private readonly bayerGeometryProgram: WebGLProgram;
  private readonly defectProgram: WebGLProgram;
  private readonly denoiseProgram: WebGLProgram;
  private readonly displayProgram: WebGLProgram;
  private readonly encodeProgram: WebGLProgram;
  private readonly lutTexture: WebGLTexture;
  private targetWidth = 0;
  private targetHeight = 0;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private sourceKey = "";
  private sourceIsBayer = false;
  private bayerPattern: readonly [number, number, number, number] = [0, 1, 1, 2];
  private lastProcessingKey = "";
  private processedTexture: WebGLTexture;
  private layout: GeometryLayout | undefined;
  private lutData: Float32Array | undefined;
  private displayTextureWidth = 0;
  private displayTextureHeight = 0;
  private encodedTextureWidth = 0;
  private encodedTextureHeight = 0;
  private readonly targetInternalFormat: number;
  private readonly targetPixelType: number;
  private readonly hardwareLutInterpolation: boolean;
  private boundFilmSignature: string | undefined;
  private lastRenderRegionKey = "";
  private readonly timerExtension: { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number } | null;
  private readonly pendingTimerQueries: WebGLQuery[] = [];
  private lastGpuMs: number | undefined;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly quality: GpuPipelineQuality = "preview",
  ) {
    if (gl.getExtension("EXT_color_buffer_float") === null) {
      throw new Error("Floating-point framebuffer rendering is unavailable.");
    }
    this.targetInternalFormat = quality === "preview" ? gl.RGBA16F : gl.RGBA32F;
    this.targetPixelType = quality === "preview" ? gl.HALF_FLOAT : gl.FLOAT;
    this.hardwareLutInterpolation = gl.getExtension("OES_texture_float_linear") !== null;
    this.timerExtension = gl.getExtension("EXT_disjoint_timer_query_webgl2") as {
      readonly TIME_ELAPSED_EXT: number;
      readonly GPU_DISJOINT_EXT: number;
    } | null;
    this.framebuffer = gl.createFramebuffer() ?? fail("GPU film framebuffer could not be created.");
    this.sourceTexture = createTexture(gl);
    this.targetTextures = [createTexture(gl), createTexture(gl)];
    this.displayTexture = createTexture(gl);
    this.encodedTexture = createTexture(gl);
    this.processedTexture = this.targetTextures[0];
    this.lutTexture = createTexture3d(gl, this.hardwareLutInterpolation);
    this.geometryProgram = createProgram(gl, geometryFragmentShader);
    this.bayerGeometryProgram = createProgram(gl, bayerGeometryFragmentShader);
    this.defectProgram = createProgram(gl, defectFragmentShader);
    this.denoiseProgram = createProgram(gl, denoiseFragmentShader);
    this.displayProgram = createProgram(gl, displayFragmentShader);
    this.encodeProgram = createProgram(gl, encodeSrgb16FragmentShader);
    this.assertFloatFramebuffer();
  }

  public render(frame: GpuFilmFrame): GpuFilmRenderResult {
    this.pollGpuTimers();
    const timerQuery = this.beginGpuTimer();
    const payload = frame.pipeline;
    assertPipelinePayload(payload);
    const restoration = frame.processing.restoration;
    const processingKey = JSON.stringify({
      geometry: frame.processing.geometry,
      restoration: {
        dust: restoration.dust,
        scratches: restoration.scratches,
        denoise: restoration.denoise,
      },
    });
    const layout = computeGeometryLayout(
      payload.sourceWidth,
      payload.sourceHeight,
      frame.processing.geometry,
    );
    const sourceChanged = this.uploadSource(payload);
    const needsIntermediate = this.sourceIsBayer
      || restoration.dust
      || restoration.scratches
      || restoration.denoise > 0;

    if (!needsIntermediate) {
      this.processedTexture = this.sourceTexture;
      this.layout = layout;
      this.lastProcessingKey = processingKey;
      this.lastRenderRegionKey = "";
      const scale = computePreviewScale(this.canvas, layout.outputWidth, layout.outputHeight);
      const outputWidth = scaledDimension(layout.outputWidth, scale);
      const outputHeight = scaledDimension(layout.outputHeight, scale);
      this.drawDisplayPass(frame, this.sourceTexture, null, {
        outputWidth,
        outputHeight,
        cropLeft: layout.cropLeft,
        cropTop: layout.cropTop,
        cropWidth: layout.outputWidth,
        cropHeight: layout.outputHeight,
        outputLinear: false,
        fusedGeometry: true,
        geometryWidth: layout.geometryWidth,
        geometryHeight: layout.geometryHeight,
      });
      this.assertNoGlError("direct film display");
      this.endGpuTimer(timerQuery);
      return { width: layout.outputWidth, height: layout.outputHeight };
    }

    const region = computePreviewRenderRegion(
      this.canvas,
      layout,
      requiredRestorationOverlap(restoration),
    );
    const regionKey = JSON.stringify(region);
    const structuralChange = sourceChanged
      || processingKey !== this.lastProcessingKey
      || regionKey !== this.lastRenderRegionKey
      || layout.geometryWidth !== this.layout?.geometryWidth
      || layout.geometryHeight !== this.layout?.geometryHeight;

    this.ensureTargets(region.targetWidth, region.targetHeight);
    if (structuralChange) {
      this.runGeometry(frame, layout, this.targetTextures[0], {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        targetWidth: region.targetWidth,
        targetHeight: region.targetHeight,
      });
      this.assertNoGlError("geometry");
      let input = this.targetTextures[0];
      let output = this.targetTextures[1];
      if (restoration.dust || restoration.scratches) {
        this.runDefectPass(input, output, restoration.dust, restoration.scratches);
        this.assertNoGlError("defect repair");
        [input, output] = [output, input];
      }
      if (restoration.denoise > 0) {
        this.runDenoisePass(input, output, restoration.denoise, 1, 0);
        this.runDenoisePass(output, input, restoration.denoise, 0, 1);
        this.assertNoGlError("denoise");
      }
      this.processedTexture = input;
      this.lastProcessingKey = processingKey;
      this.lastRenderRegionKey = regionKey;
      this.layout = layout;
    }

    this.drawDisplayPass(frame, this.processedTexture, null, {
      outputWidth: region.outputWidth,
      outputHeight: region.outputHeight,
      cropLeft: region.cropLeft,
      cropTop: region.cropTop,
      cropWidth: region.outputWidth,
      cropHeight: region.outputHeight,
      outputLinear: false,
      fusedGeometry: false,
      geometryWidth: region.targetWidth,
      geometryHeight: region.targetHeight,
    });
    this.assertNoGlError("film display");
    this.endGpuTimer(timerQuery);
    return { width: layout.outputWidth, height: layout.outputHeight };
  }

  public async renderMasterTile(
    frame: GpuFilmFrame,
    outputY: number,
    tileHeight: number,
    overlap = requiredRestorationOverlap(frame.processing.restoration),
    transfer: GpuMasterTransfer = "srgb",
  ): Promise<Uint16Array> {
    const tile = await this.resolveMasterTile(
      this.enqueueMasterTile(frame, outputY, tileHeight, overlap, transfer),
    );
    return tile.rgb16;
  }

  public enqueueMasterTile(
    frame: GpuFilmFrame,
    outputY: number,
    tileHeight: number,
    overlap = requiredRestorationOverlap(frame.processing.restoration),
    transfer: GpuMasterTransfer = "srgb",
  ): PendingMasterTile {
    this.pollGpuTimers();
    const timerQuery = this.beginGpuTimer();
    const payload = frame.pipeline;
    assertPipelinePayload(payload);
    const layout = computeGeometryLayout(
      payload.sourceWidth,
      payload.sourceHeight,
      frame.processing.geometry,
    );
    if (
      !Number.isInteger(outputY)
      || !Number.isInteger(tileHeight)
      || outputY < 0
      || tileHeight <= 0
      || outputY + tileHeight > layout.outputHeight
    ) {
      throw new Error("GPU master tile bounds are invalid.");
    }
    this.uploadSource(payload);
    const restoration = frame.processing.restoration;
    const needsIntermediate = this.sourceIsBayer
      || restoration.dust
      || restoration.scratches
      || restoration.denoise > 0;
    let input = this.sourceTexture;
    let cropLeft = layout.cropLeft;
    let cropTop = layout.cropTop + outputY;
    let geometryWidth = layout.geometryWidth;
    let geometryHeight = layout.geometryHeight;
    if (needsIntermediate) {
      const tileLeft = Math.max(0, layout.cropLeft - overlap);
      const tileTop = Math.max(0, layout.cropTop + outputY - overlap);
      const tileRight = Math.min(
        layout.geometryWidth,
        layout.cropLeft + layout.outputWidth + overlap,
      );
      const tileBottom = Math.min(
        layout.geometryHeight,
        layout.cropTop + outputY + tileHeight + overlap,
      );
      const tileWidth = tileRight - tileLeft;
      const geometryTileHeight = tileBottom - tileTop;
      this.ensureTargets(tileWidth, geometryTileHeight);
      this.runGeometry(frame, layout, this.targetTextures[0], {
        x: tileLeft,
        y: tileTop,
        width: tileWidth,
        height: geometryTileHeight,
        targetWidth: tileWidth,
        targetHeight: geometryTileHeight,
      });
      this.assertNoGlError("master geometry");
      input = this.targetTextures[0];
      let output = this.targetTextures[1];
      if (restoration.dust || restoration.scratches) {
        this.runDefectPass(input, output, restoration.dust, restoration.scratches);
        this.assertNoGlError("master defect repair");
        [input, output] = [output, input];
      }
      if (restoration.denoise > 0) {
        this.runDenoisePass(input, output, restoration.denoise, 1, 0);
        this.runDenoisePass(output, input, restoration.denoise, 0, 1);
        this.assertNoGlError("master denoise");
      }
      cropLeft = layout.cropLeft - tileLeft;
      cropTop = layout.cropTop + outputY - tileTop;
      geometryWidth = tileWidth;
      geometryHeight = geometryTileHeight;
    }
    this.ensureDisplayTexture(layout.outputWidth, tileHeight);
    this.drawDisplayPass(frame, input, this.displayTexture, {
      outputWidth: layout.outputWidth,
      outputHeight: tileHeight,
      cropLeft,
      cropTop,
      cropWidth: layout.outputWidth,
      cropHeight: tileHeight,
      outputLinear: true,
      fusedGeometry: !needsIntermediate,
      geometryWidth,
      geometryHeight,
    });
    this.assertNoGlError("master display");
    this.ensureEncodedTexture(layout.outputWidth, tileHeight);
    this.runEncodeSrgb16Pass(layout.outputWidth, tileHeight, transfer === "srgb");
    this.assertNoGlError("master 16-bit encode");
    const pending = this.enqueueEncodedPixels(outputY, layout.outputWidth, tileHeight);
    this.endGpuTimer(timerQuery);
    return timerQuery === undefined ? pending : { ...pending, timerQuery };
  }

  public async resolveMasterTile(pending: PendingMasterTile): Promise<GpuMasterTile> {
    const rgba = await this.resolveEncodedPixels(pending);
    this.pollGpuTimers();
    const rgb = unpackEncodedMasterPixels(rgba, pending.width, pending.height);
    return {
      outputY: pending.outputY,
      width: pending.width,
      height: pending.height,
      rgb16: rgb,
    };
  }

  public dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.sourceTexture);
    gl.deleteTexture(this.targetTextures[0]);
    gl.deleteTexture(this.targetTextures[1]);
    gl.deleteTexture(this.displayTexture);
    gl.deleteTexture(this.encodedTexture);
    gl.deleteTexture(this.lutTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.geometryProgram);
    gl.deleteProgram(this.bayerGeometryProgram);
    gl.deleteProgram(this.defectProgram);
    gl.deleteProgram(this.denoiseProgram);
    gl.deleteProgram(this.displayProgram);
    gl.deleteProgram(this.encodeProgram);
    for (const query of this.pendingTimerQueries) gl.deleteQuery(query);
    this.pendingTimerQueries.length = 0;
  }

  private uploadSource(payload: GpuPipelinePayload): boolean {
    if (
      this.sourceKey === payload.sourceKey
      && this.sourceWidth === payload.sourceWidth
      && this.sourceHeight === payload.sourceHeight
    ) {
      return false;
    }
    const isBayer = payload.bayerPattern !== undefined;
    if (
      (isBayer && payload.sourceBayer === undefined)
      || (!isBayer && payload.sourceLinear === undefined)
    ) {
      throw new Error("GPU source texture was not resident and no decoder pixels were supplied.");
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    clearGlErrors(gl);
    if (isBayer) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R16UI,
        payload.sourceWidth,
        payload.sourceHeight,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_SHORT,
        payload.sourceBayer ?? null,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGB32F,
        payload.sourceWidth,
        payload.sourceHeight,
        0,
        gl.RGB,
        gl.FLOAT,
        payload.sourceLinear ?? null,
      );
    }
    if (gl.getError() !== gl.NO_ERROR) {
      throw new Error("Decoder-linear texture upload failed.");
    }
    this.sourceKey = payload.sourceKey;
    this.sourceWidth = payload.sourceWidth;
    this.sourceHeight = payload.sourceHeight;
    this.sourceIsBayer = isBayer;
    this.bayerPattern = payload.bayerPattern ?? [0, 1, 1, 2];
    return true;
  }

  private ensureTargets(width: number, height: number): void {
    if (width === this.targetWidth && height === this.targetHeight) return;
    const gl = this.gl;
    for (const texture of this.targetTextures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        this.targetInternalFormat,
        width,
        height,
        0,
        gl.RGBA,
        this.targetPixelType,
        null,
      );
    }
    this.targetWidth = width;
    this.targetHeight = height;
    this.lastRenderRegionKey = "";
  }

  private runGeometry(
    frame: GpuFilmFrame,
    layout: GeometryLayout,
    target: WebGLTexture,
    tile: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly targetWidth: number;
      readonly targetHeight: number;
    },
  ): void {
    const gl = this.gl;
    const geometry = frame.processing.geometry;
    const perspective = geometry.perspective ?? identityPerspective;
    const program = this.sourceIsBayer ? this.bayerGeometryProgram : this.geometryProgram;
    this.beginPass(program, target, tile.targetWidth, tile.targetHeight);
    bindTexture2d(gl, program, "u_image", this.sourceTexture, 0);
    if (this.sourceIsBayer) {
      gl.uniform4iv(
        requireUniform(gl, program, "u_bayerPattern"),
        this.bayerPattern,
      );
    }
    gl.uniform1i(requireUniform(gl, program, "u_rotation"), geometry.rotation / 90);
    gl.uniform1f(requireUniform(gl, program, "u_straighten"), geometry.straighten ?? 0);
    gl.uniform2f(
      requireUniform(gl, program, "u_geometrySize"),
      layout.geometryWidth,
      layout.geometryHeight,
    );
    gl.uniform2f(requireUniform(gl, program, "u_tileOrigin"), tile.x, tile.y);
    gl.uniform2f(requireUniform(gl, program, "u_tileSize"), tile.width, tile.height);
    gl.uniform2f(
      requireUniform(gl, program, "u_topLeft"),
      perspective.topLeft.x,
      perspective.topLeft.y,
    );
    gl.uniform2f(
      requireUniform(gl, program, "u_topRight"),
      perspective.topRight.x,
      perspective.topRight.y,
    );
    gl.uniform2f(
      requireUniform(gl, program, "u_bottomRight"),
      perspective.bottomRight.x,
      perspective.bottomRight.y,
    );
    gl.uniform2f(
      requireUniform(gl, program, "u_bottomLeft"),
      perspective.bottomLeft.x,
      perspective.bottomLeft.y,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private runDefectPass(
    input: WebGLTexture,
    output: WebGLTexture,
    dust: boolean,
    scratches: boolean,
  ): void {
    const gl = this.gl;
    this.beginPass(this.defectProgram, output, this.targetWidth, this.targetHeight);
    bindTexture2d(gl, this.defectProgram, "u_image", input, 0);
    gl.uniform1i(requireUniform(gl, this.defectProgram, "u_dust"), dust ? 1 : 0);
    gl.uniform1i(requireUniform(gl, this.defectProgram, "u_scratches"), scratches ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private runDenoisePass(
    input: WebGLTexture,
    output: WebGLTexture,
    amount: number,
    directionX: number,
    directionY: number,
  ): void {
    const gl = this.gl;
    this.beginPass(this.denoiseProgram, output, this.targetWidth, this.targetHeight);
    bindTexture2d(gl, this.denoiseProgram, "u_image", input, 0);
    gl.uniform1f(
      requireUniform(gl, this.denoiseProgram, "u_rangeSigma"),
      0.012 + amount * 0.07,
    );
    gl.uniform2i(
      requireUniform(gl, this.denoiseProgram, "u_direction"),
      directionX,
      directionY,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawDisplayPass(
    frame: GpuFilmFrame,
    input: WebGLTexture,
    target: WebGLTexture | null,
    options: {
      readonly outputWidth: number;
      readonly outputHeight: number;
      readonly cropLeft: number;
      readonly cropTop: number;
      readonly cropWidth: number;
      readonly cropHeight: number;
      readonly outputLinear: boolean;
      readonly fusedGeometry: boolean;
      readonly geometryWidth: number;
      readonly geometryHeight: number;
    },
  ): void {
    const gl = this.gl;
    if (target === null) {
      if (this.canvas.width !== options.outputWidth) this.canvas.width = options.outputWidth;
      if (this.canvas.height !== options.outputHeight) this.canvas.height = options.outputHeight;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    }
    gl.viewport(0, 0, options.outputWidth, options.outputHeight);
    gl.useProgram(this.displayProgram);
    bindTexture2d(gl, this.displayProgram, "u_image", input, 0);
    gl.uniform2f(
      requireUniform(gl, this.displayProgram, "u_cropOrigin"),
      options.cropLeft,
      options.cropTop,
    );
    gl.uniform2f(
      requireUniform(gl, this.displayProgram, "u_cropSize"),
      options.cropWidth,
      options.cropHeight,
    );
    const geometry = frame.processing.geometry;
    const perspective = geometry.perspective ?? identityPerspective;
    gl.uniform1i(
      requireUniform(gl, this.displayProgram, "u_fusedGeometry"),
      options.fusedGeometry ? 1 : 0,
    );
    gl.uniform1i(requireUniform(gl, this.displayProgram, "u_rotation"), geometry.rotation / 90);
    gl.uniform1f(requireUniform(gl, this.displayProgram, "u_straighten"), geometry.straighten ?? 0);
    gl.uniform2f(
      requireUniform(gl, this.displayProgram, "u_geometrySize"),
      options.geometryWidth,
      options.geometryHeight,
    );
    gl.uniform2f(requireUniform(gl, this.displayProgram, "u_topLeft"), perspective.topLeft.x, perspective.topLeft.y);
    gl.uniform2f(requireUniform(gl, this.displayProgram, "u_topRight"), perspective.topRight.x, perspective.topRight.y);
    gl.uniform2f(requireUniform(gl, this.displayProgram, "u_bottomRight"), perspective.bottomRight.x, perspective.bottomRight.y);
    gl.uniform2f(requireUniform(gl, this.displayProgram, "u_bottomLeft"), perspective.bottomLeft.x, perspective.bottomLeft.y);
    gl.uniform3f(
      requireUniform(gl, this.displayProgram, "u_base"),
      frame.pipeline.baseRgb[0],
      frame.pipeline.baseRgb[1],
      frame.pipeline.baseRgb[2],
    );
    const densityChannelRange = frame.pipeline.densityChannelRange ?? [1, 1, 1] as const;
    gl.uniform3f(
      requireUniform(gl, this.displayProgram, "u_densityChannelRange"),
      densityChannelRange[0],
      densityChannelRange[1],
      densityChannelRange[2],
    );
    const photonTransfer = frame.pipeline.photonTransfer;
    gl.uniform1i(
      requireUniform(gl, this.displayProgram, "u_hasPhotonTransfer"),
      photonTransfer === undefined ? 0 : 1,
    );
    gl.uniform1f(
      requireUniform(gl, this.displayProgram, "u_ptcReadNoiseDn"),
      photonTransfer?.readNoiseDn ?? 0,
    );
    gl.uniform1f(
      requireUniform(gl, this.displayProgram, "u_ptcElectronsPerDn"),
      photonTransfer?.electronsPerDn ?? 1,
    );
    gl.uniform1f(
      requireUniform(gl, this.displayProgram, "u_ptcPrnu"),
      photonTransfer?.prnu ?? 0,
    );
    gl.uniform3f(
      requireUniform(gl, this.displayProgram, "u_ptcNormalizationRangeDn"),
      photonTransfer?.normalizationRangeDn[0] ?? 1,
      photonTransfer?.normalizationRangeDn[1] ?? 1,
      photonTransfer?.normalizationRangeDn[2] ?? 1,
    );
    gl.uniform1i(
      requireUniform(gl, this.displayProgram, "u_view"),
      frame.view === "positive" ? 0 : frame.view === "transmission" ? 1 : 2,
    );
    this.bindFilm(frame.pipeline.film);
    // The only curve-bearing mode is a colour-card calibration profile. Its
    // density domain is absolute and must not vary with image content.
    const domainScale = [1, 1, 1] as const;
    gl.uniform3f(
      requireUniform(gl, this.displayProgram, "u_curveDomainScale"),
      domainScale[0],
      domainScale[1],
      domainScale[2],
    );
    gl.uniform1f(requireUniform(gl, this.displayProgram, "u_exposureStops"), frame.tone.exposureStops);
    gl.uniform1f(requireUniform(gl, this.displayProgram, "u_contrast"), frame.tone.contrast);
    gl.uniform1f(
      requireUniform(gl, this.displayProgram, "u_highlightCompression"),
      frame.tone.highlightCompression,
    );
    gl.uniform1f(requireUniform(gl, this.displayProgram, "u_saturation"), frame.tone.saturation);
    gl.uniform1f(
      requireUniform(gl, this.displayProgram, "u_sharpen"),
      frame.processing.restoration.sharpen,
    );
    gl.uniform1f(requireUniform(gl, this.displayProgram, "u_sharpenThreshold"), 0.004);
    gl.uniform1f(
      requireUniform(gl, this.displayProgram, "u_whitePoint"),
      Math.max(frame.displayWhitePoint, 1e-8),
    );
    gl.uniform1i(
      requireUniform(gl, this.displayProgram, "u_outputLinear"),
      options.outputLinear ? 1 : 0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindFilm(film: FilmMode): void {
    const gl = this.gl;
    const program = this.displayProgram;
    const prepared = prepareFilm(film);
    // Cache by value, not by object identity: a caller that reuses a film
    // object and mutates its fields in place must trigger a rebind instead
    // of leaving stale uniforms.
    const signature = filmBindingSignature(prepared);
    if (this.boundFilmSignature === signature) return;
    this.boundFilmSignature = signature;
    gl.uniform1i(requireUniform(gl, program, "u_filmKind"), prepared.kind);
    gl.uniform3f(
      requireUniform(gl, program, "u_densityGain"),
      prepared.densityGain[0],
      prepared.densityGain[1],
      prepared.densityGain[2],
    );
    gl.uniform3f(
      requireUniform(gl, program, "u_whiteBalance"),
      prepared.whiteBalance[0],
      prepared.whiteBalance[1],
      prepared.whiteBalance[2],
    );
    gl.uniform1f(
      requireUniform(gl, program, "u_preSaturation"),
      prepared.preSaturation,
    );
    gl.uniform3f(
      requireUniform(gl, program, "u_matrix0"),
      prepared.matrix[0][0],
      prepared.matrix[0][1],
      prepared.matrix[0][2],
    );
    gl.uniform3f(
      requireUniform(gl, program, "u_matrix1"),
      prepared.matrix[1][0],
      prepared.matrix[1][1],
      prepared.matrix[1][2],
    );
    gl.uniform3f(
      requireUniform(gl, program, "u_matrix2"),
      prepared.matrix[2][0],
      prepared.matrix[2][1],
      prepared.matrix[2][2],
    );
    bindCurve(gl, program, "R", prepared.curves[0]);
    bindCurve(gl, program, "G", prepared.curves[1]);
    bindCurve(gl, program, "B", prepared.curves[2]);
    this.bindLut(prepared.lut);
  }

  private bindLut(lut: Lut3d | undefined): void {
    const gl = this.gl;
    const program = this.displayProgram;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
    gl.uniform1i(requireUniform(gl, program, "u_lut"), 1);
    gl.uniform1i(requireUniform(gl, program, "u_hasLut"), lut === undefined ? 0 : 1);
    gl.uniform1i(
      requireUniform(gl, program, "u_lutHardwareLinear"),
      this.hardwareLutInterpolation ? 1 : 0,
    );
    if (lut === undefined) return;
    if (this.lutData !== lut.data) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGB32F,
        lut.size,
        lut.size,
        lut.size,
        0,
        gl.RGB,
        gl.FLOAT,
        lut.data,
      );
      this.lutData = lut.data;
    }
    gl.uniform1i(requireUniform(gl, program, "u_lut"), 1);
    gl.uniform1i(requireUniform(gl, program, "u_lutSize"), lut.size);
    const domainMin = lut.domainMin ?? [0, 0, 0];
    const domainMax = lut.domainMax ?? [1, 1, 1];
    gl.uniform3f(
      requireUniform(gl, program, "u_lutDomainMin"),
      domainMin[0],
      domainMin[1],
      domainMin[2],
    );
    gl.uniform3f(
      requireUniform(gl, program, "u_lutDomainMax"),
      domainMax[0],
      domainMax[1],
      domainMax[2],
    );
  }

  private beginPass(program: WebGLProgram, target: WebGLTexture, width: number, height: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
  }

  private assertFloatFramebuffer(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.targetTextures[0]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.targetInternalFormat,
      1,
      1,
      0,
      gl.RGBA,
      this.targetPixelType,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.targetTextures[0],
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Floating-point framebuffer is incomplete.");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private ensureDisplayTexture(width: number, height: number): void {
    if (width === this.displayTextureWidth && height === this.displayTextureHeight) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.displayTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    this.displayTextureWidth = width;
    this.displayTextureHeight = height;
  }

  private ensureEncodedTexture(width: number, height: number): void {
    if (width === this.encodedTextureWidth && height === this.encodedTextureHeight) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.encodedTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16UI,
      width,
      height,
      0,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_SHORT,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.encodedTexture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("16-bit GPU export framebuffer is incomplete.");
    }
    this.encodedTextureWidth = width;
    this.encodedTextureHeight = height;
  }

  private runEncodeSrgb16Pass(width: number, height: number, encodeSrgb: boolean): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.encodedTexture,
      0,
    );
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.encodeProgram);
    bindTexture2d(gl, this.encodeProgram, "u_image", this.displayTexture, 0);
    gl.uniform1i(requireUniform(gl, this.encodeProgram, "u_encodeSrgb"), encodeSrgb ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private enqueueEncodedPixels(
    outputY: number,
    width: number,
    height: number,
  ): PendingMasterTile {
    const gl = this.gl;
    const pixelBuffer = gl.createBuffer();
    if (pixelBuffer === null) {
      const rgba = new Uint16Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, rgba);
      this.assertNoGlError("master readback");
      return { outputY, width, height, rgba };
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixelBuffer);
    gl.bufferData(
      gl.PIXEL_PACK_BUFFER,
      width * height * 4 * Uint16Array.BYTES_PER_ELEMENT,
      gl.STREAM_READ,
    );
    gl.readPixels(0, 0, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, 0);
    this.assertNoGlError("master asynchronous readback");
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return {
      outputY,
      width,
      height,
      pixelBuffer,
      ...(fence === null ? {} : { fence }),
    };
  }

  private async resolveEncodedPixels(pending: PendingMasterTile): Promise<Uint16Array> {
    if (pending.rgba !== undefined) return pending.rgba;
    const gl = this.gl;
    const pixelBuffer = pending.pixelBuffer;
    if (pixelBuffer === undefined) {
      throw new Error("GPU readback buffer is unavailable.");
    }
    const output = new Uint16Array(pending.width * pending.height * 4);
    try {
      if (pending.fence === undefined) {
        gl.finish();
      } else {
        await waitForGpuFence(gl, pending.fence);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixelBuffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, output);
      this.assertNoGlError("master readback copy");
      return output;
    } finally {
      if (pending.fence !== undefined) gl.deleteSync(pending.fence);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(pixelBuffer);
    }
  }

  private assertNoGlError(stage: string): void {
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) {
      throw new Error("GPU " + stage + " pass failed with WebGL error " + error + ".");
    }
  }

  private beginGpuTimer(): WebGLQuery | undefined {
    if (this.timerExtension === null) return undefined;
    const query = this.gl.createQuery();
    if (query === null) return undefined;
    this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
    return query;
  }

  private endGpuTimer(query: WebGLQuery | undefined): void {
    if (query === undefined || this.timerExtension === null) return;
    this.gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
    this.pendingTimerQueries.push(query);
  }

  private pollGpuTimers(): void {
    if (this.timerExtension === null) return;
    while (this.pendingTimerQueries.length > 0) {
      const query = this.pendingTimerQueries[0];
      if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) break;
      this.pendingTimerQueries.shift();
      const disjoint = this.gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        const nanoseconds = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number;
        this.lastGpuMs = nanoseconds / 1_000_000;
        this.canvas.dataset.gpuMilliseconds = this.lastGpuMs.toFixed(3);
      }
      this.gl.deleteQuery(query);
    }
  }
}

export interface GpuMasterRenderResult {
  readonly width: number;
  readonly height: number;
  readonly rgb16: Uint16Array;
}

export async function renderGpuMasterInTiles(
  frame: GpuFilmFrame,
  options: {
    readonly tileHeight?: number;
    readonly onProgress?: (completed: number, total: number) => void;
    readonly onTile?: (tile: GpuMasterTile) => void | Promise<void>;
    readonly collectPixels?: boolean;
    readonly transfer?: GpuMasterTransfer;
  } = {},
): Promise<GpuMasterRenderResult> {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "high-performance",
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    stencil: false,
  });
  if (gl === null) throw new Error("WebGL2 is unavailable for GPU master export.");
  const layout = computeGeometryLayout(
    frame.pipeline.sourceWidth,
    frame.pipeline.sourceHeight,
    frame.processing.geometry,
  );
  const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (
    frame.pipeline.sourceWidth > maximumTextureSize
    || frame.pipeline.sourceHeight > maximumTextureSize
    || layout.outputWidth + 4 > maximumTextureSize
  ) {
    throw new Error("The source exceeds this GPU's maximum texture size.");
  }
  const tileHeight = Math.max(32, Math.min(
    options.tileHeight ?? 256,
    maximumTextureSize - 4,
    layout.outputHeight,
  ));
  const collectPixels = options.collectPixels ?? options.onTile === undefined;
  const rgb16 = collectPixels
    ? new Uint16Array(layout.outputWidth * layout.outputHeight * 3)
    : new Uint16Array(0);
  const pipeline = new WebGlFilmPipeline(canvas, gl, "master");
  try {
    const pendingTiles: PendingMasterTile[] = [];
    const commitOldestTile = async (): Promise<void> => {
      const pending = pendingTiles.shift();
      if (pending === undefined) return;
      const tile = await pipeline.resolveMasterTile(pending);
      if (collectPixels) {
        rgb16.set(tile.rgb16, tile.outputY * layout.outputWidth * 3);
      }
      await options.onTile?.(tile);
      options.onProgress?.(tile.outputY + tile.height, layout.outputHeight);
    };

    for (let outputY = 0; outputY < layout.outputHeight; outputY += tileHeight) {
      const height = Math.min(tileHeight, layout.outputHeight - outputY);
      pendingTiles.push(pipeline.enqueueMasterTile(
        frame,
        outputY,
        height,
        undefined,
        options.transfer ?? "srgb",
      ));
      if (pendingTiles.length >= 2) {
        await commitOldestTile();
      }
      if ((Math.floor(outputY / tileHeight) + 1) % 4 === 0) {
        // Yield to the event loop so progress and cancel stay responsive.
        // requestAnimationFrame is paused while the window is hidden or
        // minimized, which would stall a long master export indefinitely.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    while (pendingTiles.length > 0) {
      await commitOldestTile();
    }
  } finally {
    pipeline.dispose();
  }
  return {
    width: layout.outputWidth,
    height: layout.outputHeight,
    rgb16,
  };
}

function computePreviewRenderRegion(
  canvas: HTMLCanvasElement,
  layout: GeometryLayout,
  overlap: number,
): PreviewRenderRegion {
  const x = Math.max(0, layout.cropLeft - overlap);
  const y = Math.max(0, layout.cropTop - overlap);
  const right = Math.min(
    layout.geometryWidth,
    layout.cropLeft + layout.outputWidth + overlap,
  );
  const bottom = Math.min(
    layout.geometryHeight,
    layout.cropTop + layout.outputHeight + overlap,
  );
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  const scale = computePreviewScale(canvas, layout.outputWidth, layout.outputHeight);
  const targetWidth = scaledDimension(width, scale);
  const targetHeight = scaledDimension(height, scale);
  const scaleX = targetWidth / width;
  const scaleY = targetHeight / height;
  return {
    x,
    y,
    width,
    height,
    targetWidth,
    targetHeight,
    outputWidth: scaledDimension(layout.outputWidth, scaleX),
    outputHeight: scaledDimension(layout.outputHeight, scaleY),
    cropLeft: (layout.cropLeft - x) * scaleX,
    cropTop: (layout.cropTop - y) * scaleY,
  };
}

function computePreviewScale(
  canvas: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
): number {
  const parent = canvas.parentElement;
  if (parent === null) return 1;
  const bounds = parent.getBoundingClientRect();
  if (bounds.width <= 1 || bounds.height <= 1) return 1;
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 1.25);
  const widthScale = bounds.width * pixelRatio / outputWidth;
  const heightScale = bounds.height * pixelRatio / outputHeight;
  return Math.max(0.25, Math.min(1, widthScale, heightScale));
}

function scaledDimension(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale));
}

function isIdentityGeometry(geometry: GeometrySettings): boolean {
  return geometry.rotation === 0
    && Math.abs(geometry.straighten ?? 0) < 1e-7
    && (geometry.perspective === undefined || isIdentityPerspective(geometry.perspective));
}

function requiredRestorationOverlap(
  restoration: ProcessingRecipe["restoration"],
): number {
  let overlap = restoration.sharpen > 0 ? 1 : 0;
  if (restoration.denoise > 0) overlap += 2;
  if (restoration.dust || restoration.scratches) overlap += 2;
  return overlap;
}

interface PreparedFilm {
  readonly kind: 0 | 1;
  readonly densityGain: Rgb;
  readonly whiteBalance: Rgb;
  readonly preSaturation: number;
  readonly curves: readonly [
    readonly CurvePoint[],
    readonly CurvePoint[],
    readonly CurvePoint[],
  ];
  readonly matrix: Matrix3;
  readonly lut?: Lut3d;
}

function prepareFilm(film: FilmMode): PreparedFilm {
  if (film.kind === "generic") {
    return {
      kind: 0,
      densityGain: film.densityGain ?? [1, 1, 1],
      whiteBalance: film.whiteBalance ?? [1, 1, 1],
      preSaturation: film.preSaturation ?? 1.08,
      curves: identityCurves,
      matrix: film.densityMatrix ?? identityMatrix,
    };
  }
  return {
    kind: 1,
    densityGain: [1, 1, 1],
    whiteBalance: film.whiteBalance ?? [1, 1, 1],
    preSaturation: 1,
    curves: film.profile.curves,
    matrix: film.profile.matrix,
    lut: film.profile.lut,
  };
}

/**
 * Value-based binding identity so a film object that is mutated in place
 * still rebinds uniforms. The LUT participates by buffer identity: its
 * texture upload already compares `lut.data` references, and LUT payloads
 * are never mutated after construction.
 */
function filmBindingSignature(prepared: PreparedFilm): string {
  return JSON.stringify([
    prepared.kind,
    prepared.densityGain,
    prepared.whiteBalance,
    prepared.preSaturation,
    prepared.matrix,
    prepared.curves,
  ]) + "|lut:"
    + (prepared.lut === undefined ? "none" : prepared.lut.size + ":" + prepared.lut.data.byteLength);
}

function bindCurve(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  channel: "R" | "G" | "B",
  source: readonly CurvePoint[],
): void {
  const points = reduceCurve(source);
  const data = new Float32Array(maximumGpuCurvePoints * 2);
  points.forEach((point, index) => {
    data[index * 2] = point.x;
    data[index * 2 + 1] = point.y;
  });
  gl.uniform1i(requireUniform(gl, program, "u_curve" + channel + "Count"), points.length);
  gl.uniform2fv(requireUniform(gl, program, "u_curve" + channel + "[0]"), data);
}

function reduceCurve(points: readonly CurvePoint[]): readonly CurvePoint[] {
  if (points.length > maximumGpuCurvePoints) {
    throw new Error("Film curve exceeds the exact WebGL2 point limit.");
  }
  return points;
}

function assertPipelinePayload(payload: GpuPipelinePayload): void {
  const bayerPatternValid = payload.bayerPattern === undefined
    || (
      payload.bayerPattern.length === 4
      && payload.bayerPattern.every((channel) => channel === 0 || channel === 1 || channel === 2)
      && payload.bayerPattern.filter((channel) => channel === 0).length === 1
      && payload.bayerPattern.filter((channel) => channel === 1).length === 2
      && payload.bayerPattern.filter((channel) => channel === 2).length === 1
    );
  const photonTransferValid = payload.photonTransfer === undefined
    || (
      Number.isFinite(payload.photonTransfer.readNoiseDn)
      && payload.photonTransfer.readNoiseDn >= 0
      && Number.isFinite(payload.photonTransfer.electronsPerDn)
      && payload.photonTransfer.electronsPerDn > 0
      && Number.isFinite(payload.photonTransfer.prnu)
      && payload.photonTransfer.prnu >= 0
      && payload.photonTransfer.normalizationRangeDn.every((value) => Number.isFinite(value) && value > 0)
    );
  if (
    !Number.isInteger(payload.sourceWidth)
    || !Number.isInteger(payload.sourceHeight)
    || payload.sourceWidth <= 0
    || payload.sourceHeight <= 0
    || payload.sourceKey.length === 0
    || (
      payload.sourceLinear !== undefined
      && payload.sourceLinear.length !== payload.sourceWidth * payload.sourceHeight * 3
    )
    || (
      payload.sourceBayer !== undefined
      && payload.sourceBayer.length !== payload.sourceWidth * payload.sourceHeight
    )
    || (payload.sourceLinear !== undefined && payload.sourceBayer !== undefined)
    || (payload.sourceBayer !== undefined && payload.bayerPattern === undefined)
    || (payload.sourceLinear !== undefined && payload.bayerPattern !== undefined)
    || !bayerPatternValid
    || !photonTransferValid
  ) {
    throw new Error("GPU pipeline source dimensions are invalid.");
  }
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture() ?? fail("GPU film texture could not be created.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createTexture3d(
  gl: WebGL2RenderingContext,
  hardwareInterpolation: boolean,
): WebGLTexture {
  const texture = gl.createTexture() ?? fail("GPU 3D LUT texture could not be created.");
  gl.bindTexture(gl.TEXTURE_3D, texture);
  const filter = hardwareInterpolation ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGB32F,
    1,
    1,
    1,
    0,
    gl.RGB,
    gl.FLOAT,
    new Float32Array([0, 0, 0]),
  );
  return texture;
}

function bindTexture2d(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  texture: WebGLTexture,
  unit: number,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(requireUniform(gl, program, name), unit);
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, fullscreenVertexShader);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram() ?? fail("GPU film program could not be created.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "GPU film program could not be linked.");
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type) ?? fail("GPU film shader could not be created.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "GPU film shader could not be compiled.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function requireUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  let locations = cachedUniformLocations.get(program);
  if (locations === undefined) {
    locations = new Map<string, WebGLUniformLocation>();
    cachedUniformLocations.set(program, locations);
  }
  const cached = locations.get(name);
  if (cached !== undefined) return cached;
  const location = gl.getUniformLocation(program, name)
    ?? fail("GPU film uniform is unavailable: " + name);
  locations.set(name, location);
  return location;
}

function clearGlErrors(gl: WebGL2RenderingContext): void {
  while (gl.getError() !== gl.NO_ERROR) {
    // Drain stale errors before checking a required float operation.
  }
}

async function waitForGpuFence(
  gl: WebGL2RenderingContext,
  fence: WebGLSync,
): Promise<void> {
  // A hung fence otherwise blocks a master readback forever (e.g. after a
  // driver reset). Bound the wait so the caller's CPU fallback can run.
  const deadline = Date.now() + 30_000;
  while (true) {
    const status = gl.clientWaitSync(fence, 0, 0);
    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
    if (status === gl.WAIT_FAILED) throw new Error("GPU readback synchronization failed.");
    if (Date.now() >= deadline) throw new Error("GPU readback synchronization timed out.");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function fail(message: string): never {
  throw new Error(message);
}

const fullscreenVertexShader = `#version 300 es
  precision highp float;
  out vec2 v_texCoord;
  void main() {
    vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
    v_texCoord = vec2(position.x, 1.0 - position.y);
  }
`;

const shaderPrelude = `
  precision highp float;
  uniform sampler2D u_image;
  in vec2 v_texCoord;
  out vec4 outColor;

  ivec2 clampPixel(ivec2 pixel, ivec2 size) {
    return clamp(pixel, ivec2(0), size - ivec2(1));
  }

  vec3 samplePixel(ivec2 pixel) {
    ivec2 size = textureSize(u_image, 0);
    return texelFetch(u_image, clampPixel(pixel, size), 0).rgb;
  }

  vec3 sampleBilinear(vec2 uv) {
    ivec2 size = textureSize(u_image, 0);
    vec2 position = uv * vec2(size) - 0.5;
    ivec2 low = ivec2(floor(position));
    ivec2 high = low + ivec2(1);
    vec2 fraction = fract(position);
    vec3 top = mix(samplePixel(ivec2(low.x, low.y)), samplePixel(ivec2(high.x, low.y)), fraction.x);
    vec3 bottom = mix(samplePixel(ivec2(low.x, high.y)), samplePixel(ivec2(high.x, high.y)), fraction.x);
    return mix(top, bottom, fraction.y);
  }

  float luma(vec3 value) {
    return dot(value, vec3(0.2126, 0.7152, 0.0722));
  }
`;

const geometryFragmentShader = `#version 300 es
  ${shaderPrelude}
  uniform int u_rotation;
  uniform float u_straighten;
  uniform vec2 u_geometrySize;
  uniform vec2 u_tileOrigin;
  uniform vec2 u_tileSize;
  uniform vec2 u_topLeft;
  uniform vec2 u_topRight;
  uniform vec2 u_bottomRight;
  uniform vec2 u_bottomLeft;

  void main() {
    vec2 rectUv = (u_tileOrigin + v_texCoord * u_tileSize) / u_geometrySize;
    if (abs(u_straighten) > 1e-7) {
      float radians = radians(u_straighten);
      float cosine = cos(radians);
      float sine = sin(radians);
      float scale = max(
        abs(cosine) + abs(sine) * u_geometrySize.y / u_geometrySize.x,
        abs(cosine) + abs(sine) * u_geometrySize.x / u_geometrySize.y
      );
      vec2 centered = (rectUv - 0.5) * u_geometrySize / scale;
      vec2 rotated = vec2(
        cosine * centered.x + sine * centered.y,
        -sine * centered.x + cosine * centered.y
      );
      rectUv = rotated / u_geometrySize + 0.5;
    }

    vec2 top = mix(u_topLeft, u_topRight, rectUv.x);
    vec2 bottom = mix(u_bottomLeft, u_bottomRight, rectUv.x);
    vec2 rotatedUv = mix(top, bottom, rectUv.y);
    vec2 sourceUv = rotatedUv;
    if (u_rotation == 1) {
      sourceUv = vec2(rotatedUv.y, 1.0 - rotatedUv.x);
    } else if (u_rotation == 2) {
      sourceUv = vec2(1.0 - rotatedUv.x, 1.0 - rotatedUv.y);
    } else if (u_rotation == 3) {
      sourceUv = vec2(1.0 - rotatedUv.y, rotatedUv.x);
    }
    outColor = vec4(sampleBilinear(sourceUv), 1.0);
  }
`;

const bayerGeometryFragmentShader = `#version 300 es
  precision highp float;
  precision highp usampler2D;
  uniform highp usampler2D u_image;
  uniform ivec4 u_bayerPattern;
  uniform int u_rotation;
  uniform float u_straighten;
  uniform vec2 u_geometrySize;
  uniform vec2 u_tileOrigin;
  uniform vec2 u_tileSize;
  uniform vec2 u_topLeft;
  uniform vec2 u_topRight;
  uniform vec2 u_bottomRight;
  uniform vec2 u_bottomLeft;
  in vec2 v_texCoord;
  out vec4 outColor;

  ivec2 clampBayerPixel(ivec2 pixel) {
    ivec2 size = textureSize(u_image, 0);
    ivec2 reflected = pixel;
    if (reflected.x < 0) reflected.x = -reflected.x;
    if (reflected.y < 0) reflected.y = -reflected.y;
    if (reflected.x >= size.x) reflected.x = 2 * size.x - 2 - reflected.x;
    if (reflected.y >= size.y) reflected.y = 2 * size.y - 2 - reflected.y;
    return clamp(reflected, ivec2(0), size - ivec2(1));
  }

  int bayerChannel(ivec2 pixel) {
    ivec2 safePixel = clampBayerPixel(pixel);
    return u_bayerPattern[(safePixel.y & 1) * 2 + (safePixel.x & 1)];
  }

  float bayerSample(ivec2 pixel) {
    return float(texelFetch(u_image, clampBayerPixel(pixel), 0).r) / 65535.0;
  }

  float edgeAwareGreen(ivec2 pixel) {
    if (bayerChannel(pixel) == 1) return bayerSample(pixel);
    float center = bayerSample(pixel);
    float left1 = bayerSample(pixel + ivec2(-1, 0));
    float right1 = bayerSample(pixel + ivec2(1, 0));
    float left2 = bayerSample(pixel + ivec2(-2, 0));
    float right2 = bayerSample(pixel + ivec2(2, 0));
    float up1 = bayerSample(pixel + ivec2(0, -1));
    float down1 = bayerSample(pixel + ivec2(0, 1));
    float up2 = bayerSample(pixel + ivec2(0, -2));
    float down2 = bayerSample(pixel + ivec2(0, 2));
    float horizontal = (left1 + right1) * 0.5 + (2.0 * center - left2 - right2) * 0.25;
    float vertical = (up1 + down1) * 0.5 + (2.0 * center - up2 - down2) * 0.25;
    float horizontalGradient = abs(left1 - right1) + abs(2.0 * center - left2 - right2);
    float verticalGradient = abs(up1 - down1) + abs(2.0 * center - up2 - down2);
    float estimate = horizontalGradient < verticalGradient
      ? horizontal
      : verticalGradient < horizontalGradient ? vertical : (horizontal + vertical) * 0.5;
    return clamp(estimate, 0.0, 1.0);
  }

  float colorDifference(ivec2 pixel, int targetChannel) {
    return bayerChannel(pixel) == targetChannel
      ? bayerSample(pixel) - edgeAwareGreen(pixel)
      : 0.0;
  }

  vec3 demosaicPixel(ivec2 pixel) {
    int channel = bayerChannel(pixel);
    float center = bayerSample(pixel);
    float green = edgeAwareGreen(pixel);
    float red;
    float blue;
    if (channel == 0) {
      red = center;
      blue = green + (
        colorDifference(pixel + ivec2(-1, -1), 2)
        + colorDifference(pixel + ivec2(1, -1), 2)
        + colorDifference(pixel + ivec2(-1, 1), 2)
        + colorDifference(pixel + ivec2(1, 1), 2)
      ) * 0.25;
    } else if (channel == 2) {
      blue = center;
      red = green + (
        colorDifference(pixel + ivec2(-1, -1), 0)
        + colorDifference(pixel + ivec2(1, -1), 0)
        + colorDifference(pixel + ivec2(-1, 1), 0)
        + colorDifference(pixel + ivec2(1, 1), 0)
      ) * 0.25;
    } else {
      bool redIsHorizontal = bayerChannel(pixel + ivec2(1, 0)) == 0;
      red = green + (redIsHorizontal
        ? (colorDifference(pixel + ivec2(-1, 0), 0) + colorDifference(pixel + ivec2(1, 0), 0)) * 0.5
        : (colorDifference(pixel + ivec2(0, -1), 0) + colorDifference(pixel + ivec2(0, 1), 0)) * 0.5);
      blue = green + (redIsHorizontal
        ? (colorDifference(pixel + ivec2(0, -1), 2) + colorDifference(pixel + ivec2(0, 1), 2)) * 0.5
        : (colorDifference(pixel + ivec2(-1, 0), 2) + colorDifference(pixel + ivec2(1, 0), 2)) * 0.5);
    }
    return clamp(vec3(red, green, blue), 0.0, 1.0);
  }

  vec3 sampleDemosaicedBilinear(vec2 uv) {
    ivec2 size = textureSize(u_image, 0);
    vec2 position = uv * vec2(size) - 0.5;
    ivec2 low = ivec2(floor(position));
    ivec2 high = low + ivec2(1);
    vec2 fraction = fract(position);
    vec3 top = mix(
      demosaicPixel(ivec2(low.x, low.y)),
      demosaicPixel(ivec2(high.x, low.y)),
      fraction.x
    );
    vec3 bottom = mix(
      demosaicPixel(ivec2(low.x, high.y)),
      demosaicPixel(ivec2(high.x, high.y)),
      fraction.x
    );
    return mix(top, bottom, fraction.y);
  }

  void main() {
    vec2 rectUv = (u_tileOrigin + v_texCoord * u_tileSize) / u_geometrySize;
    if (abs(u_straighten) > 1e-7) {
      float straightenRadians = radians(u_straighten);
      float cosine = cos(straightenRadians);
      float sine = sin(straightenRadians);
      float scale = max(
        abs(cosine) + abs(sine) * u_geometrySize.y / u_geometrySize.x,
        abs(cosine) + abs(sine) * u_geometrySize.x / u_geometrySize.y
      );
      vec2 centered = (rectUv - 0.5) * u_geometrySize / scale;
      vec2 rotated = vec2(
        cosine * centered.x + sine * centered.y,
        -sine * centered.x + cosine * centered.y
      );
      rectUv = rotated / u_geometrySize + 0.5;
    }

    vec2 top = mix(u_topLeft, u_topRight, rectUv.x);
    vec2 bottom = mix(u_bottomLeft, u_bottomRight, rectUv.x);
    vec2 rotatedUv = mix(top, bottom, rectUv.y);
    vec2 sourceUv = rotatedUv;
    if (u_rotation == 1) {
      sourceUv = vec2(rotatedUv.y, 1.0 - rotatedUv.x);
    } else if (u_rotation == 2) {
      sourceUv = vec2(1.0 - rotatedUv.x, 1.0 - rotatedUv.y);
    } else if (u_rotation == 3) {
      sourceUv = vec2(1.0 - rotatedUv.y, rotatedUv.x);
    }
    outColor = vec4(sampleDemosaicedBilinear(sourceUv), 1.0);
  }
`;

const defectFragmentShader = `#version 300 es
  ${shaderPrelude}
  uniform bool u_dust;
  uniform bool u_scratches;

  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec3 center = samplePixel(pixel);
    vec3 result = center;
    if (u_dust) {
      vec3 neighbourSum = vec3(0.0);
      float lumaDeviation = 0.0;
      float centerLuma = luma(center);
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          if (x == 0 && y == 0) continue;
          vec3 sampleValue = samplePixel(pixel + ivec2(x, y));
          neighbourSum += sampleValue;
          lumaDeviation += abs(luma(sampleValue) - centerLuma);
        }
      }
      vec3 average = neighbourSum / 8.0;
      float required = max(0.01, 3.5 * lumaDeviation / 8.0);
      bvec3 affected = greaterThan(abs(center - average), vec3(required));
      int affectedCount = (affected.r ? 1 : 0) + (affected.g ? 1 : 0) + (affected.b ? 1 : 0);
      if (abs(centerLuma - luma(average)) >= required && affectedCount >= 2) {
        result = average;
      }
    }
    if (u_scratches) {
      vec3 left = samplePixel(pixel + ivec2(-2, 0));
      vec3 right = samplePixel(pixel + ivec2(2, 0));
      vec3 above = samplePixel(pixel + ivec2(0, -2));
      vec3 below = samplePixel(pixel + ivec2(0, 2));
      float horizontalDifference = abs(luma(result) - (luma(left) + luma(right)) * 0.5);
      float horizontalRequired = max(0.018, 2.7 * abs(luma(left) - luma(right)) * 0.5);
      float verticalDifference = abs(luma(result) - (luma(above) + luma(below)) * 0.5);
      float verticalRequired = max(0.018, 2.7 * abs(luma(above) - luma(below)) * 0.5);
      if (horizontalDifference >= horizontalRequired || verticalDifference >= verticalRequired) {
        result = horizontalDifference >= verticalDifference
          ? (left + right) * 0.5
          : (above + below) * 0.5;
      }
    }
    outColor = vec4(result, 1.0);
  }
`;

const denoiseFragmentShader = `#version 300 es
  ${shaderPrelude}
  uniform float u_rangeSigma;
  uniform ivec2 u_direction;

  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec3 center = samplePixel(pixel);
    float centerLuma = luma(center);
    vec3 accumulated = vec3(0.0);
    float weightSum = 0.0;
    float rangeDenominator = max(2.0 * u_rangeSigma * u_rangeSigma, 1e-8);
    for (int offset = -2; offset <= 2; offset++) {
      vec3 sampleValue = samplePixel(pixel + u_direction * offset);
      int distance = abs(offset);
      float spatial = distance == 0 ? 1.0 : distance == 1 ? 0.7548396 : 0.3246525;
      float difference = luma(sampleValue) - centerLuma;
      float weight = spatial * exp(-(difference * difference) / rangeDenominator);
      accumulated += sampleValue * weight;
      weightSum += weight;
    }
    outColor = vec4(accumulated / max(weightSum, 1e-8), 1.0);
  }
`;

const displayFragmentShader = `#version 300 es
  ${shaderPrelude}
  uniform vec2 u_cropOrigin;
  uniform vec2 u_cropSize;
  uniform bool u_fusedGeometry;
  uniform int u_rotation;
  uniform float u_straighten;
  uniform vec2 u_geometrySize;
  uniform vec2 u_topLeft;
  uniform vec2 u_topRight;
  uniform vec2 u_bottomRight;
  uniform vec2 u_bottomLeft;
  uniform vec3 u_base;
  uniform vec3 u_densityChannelRange;
  uniform vec3 u_curveDomainScale;
  uniform bool u_hasPhotonTransfer;
  uniform float u_ptcReadNoiseDn;
  uniform float u_ptcElectronsPerDn;
  uniform float u_ptcPrnu;
  uniform vec3 u_ptcNormalizationRangeDn;
  uniform int u_view;
  uniform int u_filmKind;
  uniform vec3 u_densityGain;
  uniform vec3 u_whiteBalance;
  uniform float u_preSaturation;
  uniform vec3 u_matrix0;
  uniform vec3 u_matrix1;
  uniform vec3 u_matrix2;
  uniform vec2 u_curveR[${maximumGpuCurvePoints}];
  uniform vec2 u_curveG[${maximumGpuCurvePoints}];
  uniform vec2 u_curveB[${maximumGpuCurvePoints}];
  uniform int u_curveRCount;
  uniform int u_curveGCount;
  uniform int u_curveBCount;
  uniform bool u_hasLut;
  uniform bool u_lutHardwareLinear;
  uniform highp sampler3D u_lut;
  uniform int u_lutSize;
  uniform vec3 u_lutDomainMin;
  uniform vec3 u_lutDomainMax;
  uniform float u_exposureStops;
  uniform float u_contrast;
  uniform float u_highlightCompression;
  uniform float u_saturation;
  uniform float u_sharpen;
  uniform float u_sharpenThreshold;
  uniform float u_whitePoint;
  uniform bool u_outputLinear;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  const float EPSILON = 1e-8;
  const float DISPLAY_CEILING = 0.9999847412109375;
  const float MID_GREY = 0.18;

  // Continues a curve past its last point with the terminal segment's log
  // slope (exponential in linear space), mirroring the CPU core. A hard
  // clamp flattens highlights and rotates the hue of coloured ones. Output
  // caps at the same 1e8 ceiling as the CPU so a hostile imported curve
  // cannot overflow into Infinity.
  float extrapolateCurveEnd(vec2 previous, vec2 last, float inputValue) {
    if (previous.y > 0.0 && last.y > 0.0) {
      float slope = (log2(last.y) - log2(previous.y)) / (last.x - previous.x);
      return min(last.y * exp2(slope * (inputValue - last.x)), 1e8);
    }
    return last.y;
  }

  float curveR(float inputValue) {
    if (u_curveRCount < 2) return inputValue;
    if (inputValue <= u_curveR[0].x) return u_curveR[0].y;
    for (int index = 1; index < ${maximumGpuCurvePoints}; index++) {
      if (index >= u_curveRCount) break;
      if (inputValue <= u_curveR[index].x) {
        vec2 left = u_curveR[index - 1];
        vec2 right = u_curveR[index];
        return mix(left.y, right.y, (inputValue - left.x) / max(right.x - left.x, 1e-9));
      }
    }
    return extrapolateCurveEnd(u_curveR[u_curveRCount - 2], u_curveR[u_curveRCount - 1], inputValue);
  }

  float curveG(float inputValue) {
    if (u_curveGCount < 2) return inputValue;
    if (inputValue <= u_curveG[0].x) return u_curveG[0].y;
    for (int index = 1; index < ${maximumGpuCurvePoints}; index++) {
      if (index >= u_curveGCount) break;
      if (inputValue <= u_curveG[index].x) {
        vec2 left = u_curveG[index - 1];
        vec2 right = u_curveG[index];
        return mix(left.y, right.y, (inputValue - left.x) / max(right.x - left.x, 1e-9));
      }
    }
    return extrapolateCurveEnd(u_curveG[u_curveGCount - 2], u_curveG[u_curveGCount - 1], inputValue);
  }

  float curveB(float inputValue) {
    if (u_curveBCount < 2) return inputValue;
    if (inputValue <= u_curveB[0].x) return u_curveB[0].y;
    for (int index = 1; index < ${maximumGpuCurvePoints}; index++) {
      if (index >= u_curveBCount) break;
      if (inputValue <= u_curveB[index].x) {
        vec2 left = u_curveB[index - 1];
        vec2 right = u_curveB[index];
        return mix(left.y, right.y, (inputValue - left.x) / max(right.x - left.x, 1e-9));
      }
    }
    return extrapolateCurveEnd(u_curveB[u_curveBCount - 2], u_curveB[u_curveBCount - 1], inputValue);
  }

  vec3 sampleLut(vec3 value) {
    vec3 normalized = clamp(
      (value - u_lutDomainMin) / max(u_lutDomainMax - u_lutDomainMin, vec3(EPSILON)),
      0.0,
      1.0
    );
    if (u_lutHardwareLinear) {
      vec3 coordinate = (
        normalized.bgr * float(u_lutSize - 1) + vec3(0.5)
      ) / float(u_lutSize);
      return texture(u_lut, coordinate).rgb;
    }
    vec3 position = normalized * float(u_lutSize - 1);
    ivec3 lowRgb = ivec3(floor(position));
    ivec3 highRgb = min(lowRgb + ivec3(1), ivec3(u_lutSize - 1));
    vec3 fraction = fract(position);
    vec3 c000 = texelFetch(u_lut, ivec3(lowRgb.b, lowRgb.g, lowRgb.r), 0).rgb;
    vec3 c100 = texelFetch(u_lut, ivec3(lowRgb.b, lowRgb.g, highRgb.r), 0).rgb;
    vec3 c010 = texelFetch(u_lut, ivec3(lowRgb.b, highRgb.g, lowRgb.r), 0).rgb;
    vec3 c110 = texelFetch(u_lut, ivec3(lowRgb.b, highRgb.g, highRgb.r), 0).rgb;
    vec3 c001 = texelFetch(u_lut, ivec3(highRgb.b, lowRgb.g, lowRgb.r), 0).rgb;
    vec3 c101 = texelFetch(u_lut, ivec3(highRgb.b, lowRgb.g, highRgb.r), 0).rgb;
    vec3 c011 = texelFetch(u_lut, ivec3(highRgb.b, highRgb.g, lowRgb.r), 0).rgb;
    vec3 c111 = texelFetch(u_lut, ivec3(highRgb.b, highRgb.g, highRgb.r), 0).rgb;
    vec3 c00 = mix(c000, c100, fraction.r);
    vec3 c10 = mix(c010, c110, fraction.r);
    vec3 c01 = mix(c001, c101, fraction.r);
    vec3 c11 = mix(c011, c111, fraction.r);
    return mix(mix(c00, c10, fraction.g), mix(c01, c11, fraction.g), fraction.b);
  }

  vec3 filmTransform(vec3 density) {
    if (u_filmKind == 0) {
      vec3 corrected = max(vec3(
        dot(u_matrix0, max(density, vec3(0.0))),
        dot(u_matrix1, max(density, vec3(0.0))),
        dot(u_matrix2, max(density, vec3(0.0)))
      ), vec3(0.0));
      float meanDensity = dot(corrected, vec3(0.3333333333));
      corrected = max(meanDensity + (corrected - meanDensity) * u_preSaturation, vec3(0.0));
      // Cap the normalized density exactly like the CPU path: a poorly
      // sampled Dmax ROI must not amplify highlights by orders of magnitude.
      vec3 normalizedDensity = min(corrected / max(u_densityChannelRange, vec3(0.05)), vec3(4.0));
      return max(pow(vec3(10.0), normalizedDensity * u_densityGain) - 1.0, 0.0) * u_whiteBalance;
    }
    vec3 curved = vec3(
      curveR(density.r * u_curveDomainScale.r),
      curveG(density.g * u_curveDomainScale.g),
      curveB(density.b * u_curveDomainScale.b)
    );
    // Negative cross-talk products floor at zero here, and white balance is
    // applied before the 3D LUT so the LUT samples a balanced signal;
    // both mirror the CPU transform exactly.
    vec3 transformed = max(vec3(
      dot(u_matrix0, curved),
      dot(u_matrix1, curved),
      dot(u_matrix2, curved)
    ), vec3(0.0)) * u_whiteBalance;
    if (u_hasLut) transformed = sampleLut(transformed);
    return transformed;
  }

  float mapLuminance(float inputLuma) {
    float result = inputLuma;
    // Log-domain contrast around mid grey: smooth across the white point.
    if (result > 0.0 && u_contrast != 1.0) {
      result = MID_GREY * pow(result / MID_GREY, u_contrast);
    }
    if (result > 0.0 && u_highlightCompression > 0.0) {
      float knee = 1.0 / (1.0 + u_highlightCompression);
      if (result > knee) {
        float shoulder = 1.0 - knee;
        result = knee + shoulder * (1.0 - exp(-(result - knee) / shoulder));
      }
    }
    return result;
  }

  vec3 linearToSrgb(vec3 value) {
    vec3 linear = clamp(value, 0.0, 1.0);
    vec3 low = linear * 12.92;
    vec3 high = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
    return mix(high, low, lessThanEqual(linear, vec3(0.0031308)));
  }

  vec3 toneMap(vec3 scene) {
    vec3 normalized = scene * exp2(u_exposureStops) / max(u_whitePoint, EPSILON);
    // Match the CPU tone stage: non-finite values saturate to white instead
    // of propagating NaN through luminance scaling.
    normalized = mix(clamp(normalized, vec3(0.0), vec3(1e6)), vec3(0.0), bvec3(isnan(normalized)));
    float sourceLuma = max(0.0, dot(normalized, LUMA));
    float mappedLuma = mapLuminance(sourceLuma);
    vec3 mapped = normalized * (sourceLuma > EPSILON ? mappedLuma / sourceLuma : 0.0);
    float outputLuma = dot(mapped, LUMA);
    mapped = vec3(outputLuma) + (mapped - vec3(outputLuma)) * u_saturation;
    // Gamut protection is unconditional: compress channels above the
    // display ceiling proportionally to preserve hue, then floor negatives.
    float maximum = max(mapped.r, max(mapped.g, mapped.b));
    if (maximum > DISPLAY_CEILING) mapped *= DISPLAY_CEILING / maximum;
    return max(mapped, vec3(0.0));
  }

  vec2 geometryToSourceUv(vec2 pixel) {
    vec2 rectUv = pixel / u_geometrySize;
    if (abs(u_straighten) > 1e-7) {
      float angle = radians(u_straighten);
      float cosine = cos(angle);
      float sine = sin(angle);
      float scale = max(
        abs(cosine) + abs(sine) * u_geometrySize.y / u_geometrySize.x,
        abs(cosine) + abs(sine) * u_geometrySize.x / u_geometrySize.y
      );
      vec2 centered = (rectUv - 0.5) * u_geometrySize / scale;
      vec2 rotated = vec2(
        cosine * centered.x + sine * centered.y,
        -sine * centered.x + cosine * centered.y
      );
      rectUv = rotated / u_geometrySize + 0.5;
    }
    vec2 top = mix(u_topLeft, u_topRight, rectUv.x);
    vec2 bottom = mix(u_bottomLeft, u_bottomRight, rectUv.x);
    vec2 rotatedUv = mix(top, bottom, rectUv.y);
    if (u_rotation == 1) return vec2(rotatedUv.y, 1.0 - rotatedUv.x);
    if (u_rotation == 2) return vec2(1.0 - rotatedUv.x, 1.0 - rotatedUv.y);
    if (u_rotation == 3) return vec2(1.0 - rotatedUv.y, rotatedUv.x);
    return rotatedUv;
  }

  vec3 sampleTransmission(vec2 topOriginPixel) {
    if (u_fusedGeometry) {
      return sampleBilinear(geometryToSourceUv(topOriginPixel));
    }
    vec2 imageSize = vec2(textureSize(u_image, 0));
    return sampleBilinear(vec2(
      topOriginPixel.x / imageSize.x,
      1.0 - topOriginPixel.y / imageSize.y
    ));
  }

  vec3 sharpenTransmission(vec2 pixel, vec3 center) {
    if (u_sharpen <= 0.0) return center;
    vec3 blurred = (
      sampleTransmission(pixel + vec2(-1.0, -1.0))
      + 2.0 * sampleTransmission(pixel + vec2(0.0, -1.0))
      + sampleTransmission(pixel + vec2(1.0, -1.0))
      + 2.0 * sampleTransmission(pixel + vec2(-1.0, 0.0))
      + 4.0 * sampleTransmission(pixel)
      + 2.0 * sampleTransmission(pixel + vec2(1.0, 0.0))
      + sampleTransmission(pixel + vec2(-1.0, 1.0))
      + 2.0 * sampleTransmission(pixel + vec2(0.0, 1.0))
      + sampleTransmission(pixel + vec2(1.0, 1.0))
    ) / 16.0;
    vec3 detail = center - blurred;
    bvec3 applyDetail = greaterThanEqual(abs(detail), vec3(u_sharpenThreshold));
    return mix(center, center + u_sharpen * detail, applyDetail);
  }

  vec3 regularizePhotonTransfer(vec3 signal) {
    if (!u_hasPhotonTransfer) return signal;
    vec3 positiveSignal = max(signal, vec3(0.0));
    vec3 signalDn = positiveSignal * u_ptcNormalizationRangeDn;
    vec3 varianceDn = vec3(u_ptcReadNoiseDn * u_ptcReadNoiseDn)
      + signalDn / max(u_ptcElectronsPerDn, 1e-8)
      + (u_ptcPrnu * signalDn) * (u_ptcPrnu * signalDn);
    vec3 sigma = sqrt(max(varianceDn, vec3(0.0))) / u_ptcNormalizationRangeDn;
    return sqrt(positiveSignal * positiveSignal + sigma * sigma);
  }

  void main() {
    vec2 pixel = vec2(
      u_cropOrigin.x + v_texCoord.x * u_cropSize.x,
      u_cropOrigin.y + v_texCoord.y * u_cropSize.y
    );
    vec3 transmission = sampleTransmission(pixel);
    transmission = sharpenTransmission(pixel, transmission);
    if (u_view == 1) {
      outColor = vec4(linearToSrgb(transmission), 1.0);
      return;
    }
    vec3 densitySignal = regularizePhotonTransfer(transmission);
    vec3 density = -log(max(densitySignal / max(u_base, vec3(1e-6)), vec3(1e-6))) / log(10.0);
    if (u_view == 2) {
      float value = clamp((density.r + density.g + density.b) / 1.7, 0.0, 1.0);
      outColor = vec4(linearToSrgb(vec3(value)), 1.0);
      return;
    }
    vec3 displayLinear = toneMap(filmTransform(density));
    outColor = vec4(u_outputLinear ? displayLinear : linearToSrgb(displayLinear), 1.0);
  }
`;

const encodeSrgb16FragmentShader = `#version 300 es
  precision highp float;
  precision highp usampler2D;
  uniform sampler2D u_image;
  uniform bool u_encodeSrgb;
  in vec2 v_texCoord;
  layout(location = 0) out uvec4 outColor;

  vec3 linearToSrgb(vec3 value) {
    vec3 linear = clamp(value, 0.0, 1.0);
    vec3 low = linear * 12.92;
    vec3 high = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
    return mix(high, low, lessThanEqual(linear, vec3(0.0031308)));
  }

  void main() {
    vec3 linear = clamp(texture(u_image, v_texCoord).rgb, 0.0, 1.0);
    vec3 encoded = u_encodeSrgb ? linearToSrgb(linear) : linear;
    outColor = uvec4(round(encoded * 65535.0), 65535u);
  }
`;
