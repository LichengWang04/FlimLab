import type {
  GpuPipelinePayload,
  PreviewMode,
  PreviewTone,
  PreviewView,
  ProcessingRecipe,
} from "../../shared/contracts.ts";
import { WebGlFilmPipeline } from "./gpu-film-pipeline.ts";
import { probeWebGpuRestoration } from "./webgpu-restoration.ts";

export type PreviewRenderBackend = "webgl2-pipeline" | "webgl2-linear" | "webgl2" | "2d";

export interface PreviewCanvasFrame {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly sceneLinear?: Float32Array;
  readonly displayWhitePoint?: number;
  readonly gpuPipeline?: GpuPipelinePayload;
  readonly processing: ProcessingRecipe;
  readonly mode: PreviewMode;
  readonly view: PreviewView;
  readonly tone: PreviewTone;
}

export interface PreviewCanvasRenderer {
  readonly backend: "webgl2" | "2d";
  render(frame: PreviewCanvasFrame): PreviewRenderBackend;
  dispose(): void;
}

/**
 * Keeps a scene-linear texture resident on the GPU and changes only shader
 * uniforms for high-frequency tone edits. A final RGBA texture remains
 * available as the deterministic fallback.
 */
export function createPreviewCanvasRenderer(canvas: HTMLCanvasElement): PreviewCanvasRenderer {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
      stencil: false,
    });
  } catch {
    gl = null;
  }
  if (gl === null) return new Canvas2dPreviewRenderer(canvas);
  try {
    return new WebGlPreviewRenderer(canvas, gl);
  } catch (error) {
    // A WebGL2 context can exist while shader compilation or program
    // linking still fails (some drivers, remote desktops, software
    // rasterizers). Falling back keeps the app usable instead of
    // crashing the React tree from inside the effect.
    console.warn("[FilmLab] WebGL2 preview unavailable, falling back to Canvas2D.", error);
    return new Canvas2dPreviewRenderer(canvas);
  }
}

class WebGlPreviewRenderer implements PreviewCanvasRenderer {
  public readonly backend = "webgl2" as const;
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly linearModeLocation: WebGLUniformLocation;
  private readonly exposureLocation: WebGLUniformLocation;
  private readonly contrastLocation: WebGLUniformLocation;
  private readonly highlightCompressionLocation: WebGLUniformLocation;
  private readonly saturationLocation: WebGLUniformLocation;
  private readonly whitePointLocation: WebGLUniformLocation;
  private filmPipeline: WebGlFilmPipeline | null;
  private textureSource: Uint8Array | Float32Array | undefined;
  private textureWidth = 0;
  private textureHeight = 0;
  private textureIsLinear = false;
  private contextLost = false;
  private canvas2d: CanvasRenderingContext2D | null = null;

  public constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    void probeWebGpuRestoration().then((available) => {
      canvas.dataset.webgpuCompute = available ? "available" : "unavailable";
    });
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
      in vec2 a_position;
      in vec2 a_texCoord;
      out vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;

      uniform sampler2D u_image;
      uniform bool u_linearScene;
      uniform float u_exposureStops;
      uniform float u_contrast;
      uniform float u_highlightCompression;
      uniform float u_saturation;
      uniform float u_whitePoint;

      in vec2 v_texCoord;
      out vec4 outColor;

      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
      const float EPSILON = 1e-8;
      const float DISPLAY_CEILING = 0.9999847412109375;
      const float MID_GREY = 0.18;

      float mapLuminance(float inputLuma) {
        float result = inputLuma;
        // Log-domain contrast around mid grey, matching the CPU core.
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

      void main() {
        vec3 source = texture(u_image, v_texCoord).rgb;
        if (!u_linearScene) {
          outColor = vec4(source, 1.0);
          return;
        }

        float exposure = exp2(u_exposureStops);
        vec3 normalized = source * exposure / max(u_whitePoint, EPSILON);
        // Match the CPU tone stage: non-finite values saturate to white
        // instead of propagating NaN through luminance scaling.
        normalized = mix(clamp(normalized, vec3(0.0), vec3(1e6)), vec3(0.0), bvec3(isnan(normalized)));
        float sourceLuma = max(0.0, dot(normalized, LUMA));
        float mappedLuma = mapLuminance(sourceLuma);
        float scale = sourceLuma > EPSILON ? mappedLuma / sourceLuma : 0.0;
        vec3 mapped = normalized * scale;
        float outputLuma = dot(mapped, LUMA);
        mapped = vec3(outputLuma) + (mapped - vec3(outputLuma)) * u_saturation;

        // Unconditional hue-preserving gamut guard, matching the CPU core.
        float maximum = max(mapped.r, max(mapped.g, mapped.b));
        if (maximum > DISPLAY_CEILING) {
          mapped *= DISPLAY_CEILING / maximum;
        }
        outColor = vec4(linearToSrgb(max(mapped, vec3(0.0))), 1.0);
      }
    `);
    this.program = gl.createProgram() ?? fail("WebGL preview program could not be created.");
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program) ?? "WebGL preview program could not be linked.");
    }

    this.vertexBuffer = gl.createBuffer() ?? fail("WebGL preview vertex buffer could not be created.");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0,
    ]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, "a_position");
    const textureCoordinate = gl.getAttribLocation(this.program, "a_texCoord");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(textureCoordinate);
    gl.vertexAttribPointer(textureCoordinate, 2, gl.FLOAT, false, 16, 8);

    this.linearModeLocation = requireUniform(gl, this.program, "u_linearScene");
    this.exposureLocation = requireUniform(gl, this.program, "u_exposureStops");
    this.contrastLocation = requireUniform(gl, this.program, "u_contrast");
    this.highlightCompressionLocation = requireUniform(gl, this.program, "u_highlightCompression");
    this.saturationLocation = requireUniform(gl, this.program, "u_saturation");
    this.whitePointLocation = requireUniform(gl, this.program, "u_whitePoint");

    this.texture = gl.createTexture() ?? fail("WebGL preview texture could not be created.");
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(this.program);
    gl.uniform1i(requireUniform(gl, this.program, "u_image"), 0);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      this.filmPipeline = new WebGlFilmPipeline(canvas, gl);
    } catch {
      this.filmPipeline = null;
    }
  }

  public render(frame: PreviewCanvasFrame): PreviewRenderBackend {
    if (this.contextLost) {
      // The GPU context is gone for good; every GL object is invalid and
      // the film pipeline can never recover. Draw the deterministic RGBA
      // fallback through a Canvas2D context so the preview keeps working
      // instead of freezing on the last frame or going black.
      return this.renderCanvas2d(frame);
    }
    if (frame.gpuPipeline !== undefined && this.filmPipeline !== null) {
      try {
        this.filmPipeline.render({
          pipeline: frame.gpuPipeline,
          processing: frame.processing,
          mode: frame.mode,
          view: frame.view,
          tone: frame.tone,
          displayWhitePoint: frame.displayWhitePoint ?? 1,
        });
        return "webgl2-pipeline";
      } catch (error: unknown) {
        this.canvas.dataset.gpuPipelineError = error instanceof Error ? error.message : "GPU pipeline failed.";
        this.filmPipeline.dispose();
        this.filmPipeline = null;
      }
    }
    const { width, height } = frame;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const canUseLinearScene = isGpuToneFrame(frame);
    const source = canUseLinearScene ? frame.sceneLinear : frame.rgba;
    if (source !== this.textureSource || width !== this.textureWidth || height !== this.textureHeight || canUseLinearScene !== this.textureIsLinear) {
      if (canUseLinearScene) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        clearGlErrors(gl);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, source as Float32Array);
        if (gl.getError() !== gl.NO_ERROR) {
          return this.renderRgbaFallback(frame);
        }
      } else {
        uploadRgba(gl, frame.rgba, width, height);
      }
      this.textureSource = source;
      this.textureWidth = width;
      this.textureHeight = height;
      this.textureIsLinear = canUseLinearScene;
    }

    gl.uniform1i(this.linearModeLocation, canUseLinearScene ? 1 : 0);
    gl.uniform1f(this.exposureLocation, frame.tone.exposureStops);
    gl.uniform1f(this.contrastLocation, frame.tone.contrast);
    gl.uniform1f(this.highlightCompressionLocation, frame.tone.highlightCompression);
    gl.uniform1f(this.saturationLocation, frame.tone.saturation);
    gl.uniform1f(this.whitePointLocation, frame.displayWhitePoint ?? 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return canUseLinearScene ? "webgl2-linear" : "webgl2";
  }

  public dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.filmPipeline?.dispose();
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteProgram(this.program);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.filmPipeline?.dispose();
    this.filmPipeline = null;
    this.textureSource = undefined;
    this.canvas.dataset.gpuError = "WebGL context lost; preview fell back to Canvas2D.";
  };

  private renderCanvas2d(frame: PreviewCanvasFrame): PreviewRenderBackend {
    if (this.canvas2d === null) {
      // After a lost WebGL context the canvas is released, so requesting a
      // 2D context here succeeds on standard browsers.
      this.canvas2d = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
      if (this.canvas2d === null) {
        // Claiming success without drawing would leave a silently black
        // preview. Surface the failure instead: the app-level error
        // boundary presents it and the next frame retries the fallback.
        throw new Error("Canvas2D fallback unavailable after WebGL context loss.");
      }
    }
    if (this.canvas.width !== frame.width) this.canvas.width = frame.width;
    if (this.canvas.height !== frame.height) this.canvas.height = frame.height;
    const clamped = new Uint8ClampedArray(frame.rgba.buffer as ArrayBuffer, frame.rgba.byteOffset, frame.rgba.byteLength);
    this.canvas2d.putImageData(new ImageData(clamped, frame.width, frame.height), 0, 0);
    return "2d";
  }

  private renderRgbaFallback(frame: PreviewCanvasFrame): PreviewRenderBackend {
    const gl = this.gl;
    uploadRgba(gl, frame.rgba, frame.width, frame.height);
    this.textureSource = frame.rgba;
    this.textureWidth = frame.width;
    this.textureHeight = frame.height;
    this.textureIsLinear = false;
    gl.uniform1i(this.linearModeLocation, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return "webgl2";
  }
}

class Canvas2dPreviewRenderer implements PreviewCanvasRenderer {
  public readonly backend = "2d" as const;
  private readonly context: CanvasRenderingContext2D;

  private readonly canvas: HTMLCanvasElement;

  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false, desynchronized: true })
      ?? fail("Browser cannot create a preview canvas.");
  }

  public render(frame: PreviewCanvasFrame): PreviewRenderBackend {
    if (this.canvas.width !== frame.width) this.canvas.width = frame.width;
    if (this.canvas.height !== frame.height) this.canvas.height = frame.height;
    const clamped = new Uint8ClampedArray(frame.rgba.buffer as ArrayBuffer, frame.rgba.byteOffset, frame.rgba.byteLength);
    this.context.putImageData(new ImageData(clamped, frame.width, frame.height), 0, 0);
    return "2d";
  }

  public dispose(): void {
    // Canvas2D owns no explicit GPU resources.
  }
}

export function isGpuToneFrame(frame: PreviewCanvasFrame): frame is PreviewCanvasFrame & {
  readonly sceneLinear: Float32Array;
  readonly displayWhitePoint: number;
} {
  return frame.sceneLinear instanceof Float32Array
    && frame.sceneLinear.length === frame.width * frame.height * 3
    && typeof frame.displayWhitePoint === "number"
    && Number.isFinite(frame.displayWhitePoint)
    && frame.displayWhitePoint > 0;
}

function uploadRgba(gl: WebGL2RenderingContext, rgba: Uint8Array, width: number, height: number): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
}

function clearGlErrors(gl: WebGL2RenderingContext): void {
  while (gl.getError() !== gl.NO_ERROR) {
    // Drain stale errors before testing the float-texture upload.
  }
}

function requireUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  return gl.getUniformLocation(program, name) ?? fail("WebGL preview uniform is unavailable: " + name);
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type) ?? fail("WebGL preview shader could not be created.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "WebGL preview shader could not be compiled.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function fail(message: string): never {
  throw new Error(message);
}
