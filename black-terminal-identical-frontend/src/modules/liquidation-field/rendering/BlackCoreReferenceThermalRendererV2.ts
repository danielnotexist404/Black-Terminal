import {
  BufferImageSource,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup
} from "pixi.js";
import type { LiquidationFieldSettings } from "../core/types.ts";
import { bclifUint8ToHalf, type BclifDisplayProjection } from "./displayProjection.ts";
import { createThermalPalette } from "./thermalPalette.ts";

const VERTEX = [
  "in vec2 aPosition;",
  "in vec2 aUV;",
  "out vec2 vUV;",
  "uniform mat3 uProjectionMatrix;",
  "uniform mat3 uWorldTransformMatrix;",
  "uniform vec4 uWorldColorAlpha;",
  "uniform vec2 uResolution;",
  "uniform mat3 uTransformMatrix;",
  "uniform vec4 uColor;",
  "uniform float uRound;",
  "void main(void) {",
  "  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;",
  "  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);",
  "  vUV = aUV;",
  "}"
].join("\n");

const FRAGMENT = [
  "in vec2 vUV;",
  "out vec4 finalColor;",
  "uniform sampler2D uExposureTexture;",
  "uniform sampler2D uConfidenceTexture;",
  "uniform sampler2D uValidityTexture;",
  "uniform sampler2D uVisibilityTexture;",
  "uniform sampler2D uYellowTexture;",
  "uniform sampler2D uPaletteTexture;",
  "uniform vec2 uTexel;",
  "uniform vec3 uMissingColor;",
  "uniform float uOpacity;",
  "uniform float uAuthorityMode;",
  "uniform float uViewMode;",
  "uniform float uPriceSmoothing;",
  "uniform float uTimeSmoothing;",
  "uniform float uPurpleFloor;",
  "uniform float uDitherStrength;",
  "",
  "vec2 fieldUv(vec2 chartUv) {",
  "  return vec2(clamp(1.0 - chartUv.y, 0.0, 1.0), clamp(chartUv.x, 0.0, 1.0));",
  "}",
  "",
  "float validAt(vec2 uv) {",
  "  return texture(uValidityTexture, clamp(uv, vec2(0.0), vec2(1.0))).r;",
  "}",
  "",
  "float filteredExposure(vec2 uv) {",
  "  float centerValid = validAt(uv);",
  "  if (centerValid < 0.5) return 0.0;",
  "  float center = texture(uExposureTexture, uv).r;",
  "  float total = center;",
  "  float weight = 1.0;",
  "  vec2 priceOffset = vec2(uTexel.x, 0.0);",
  "  vec2 timeOffset = vec2(0.0, uTexel.y);",
  "  vec2 p1 = clamp(uv - priceOffset, vec2(0.0), vec2(1.0));",
  "  vec2 p2 = clamp(uv + priceOffset, vec2(0.0), vec2(1.0));",
  "  vec2 t1 = clamp(uv - timeOffset, vec2(0.0), vec2(1.0));",
  "  vec2 t2 = clamp(uv + timeOffset, vec2(0.0), vec2(1.0));",
  "  float vp1 = validAt(p1) * uPriceSmoothing;",
  "  float vp2 = validAt(p2) * uPriceSmoothing;",
  "  float vt1 = validAt(t1) * uTimeSmoothing;",
  "  float vt2 = validAt(t2) * uTimeSmoothing;",
  "  total += texture(uExposureTexture, p1).r * vp1;",
  "  total += texture(uExposureTexture, p2).r * vp2;",
  "  total += texture(uExposureTexture, t1).r * vt1;",
  "  total += texture(uExposureTexture, t2).r * vt2;",
  "  weight += vp1 + vp2 + vt1 + vt2;",
  "  float neighborhood = total / max(weight, 1.0);",
  // Display smoothing removes one-pixel aliasing without erasing narrow
  // high-magnitude shelves. A full box average was the V9 dimming defect: a
  // one-row shelf surrounded by valid low exposure lost most of its scalar.
  "  return max(center * 0.94, mix(center, neighborhood, 0.22));",
  "}",
  "",
  "float dither(vec2 pixel) {",
  "  return fract(sin(dot(pixel, vec2(12.9898, 78.233)) + 37.719) * 43758.5453) - 0.5;",
  "}",
  "",
  "void main(void) {",
  "  vec2 uv = fieldUv(vUV);",
  "  float valid = validAt(uv);",
  "  if (uViewMode > 1.5 && uViewMode < 2.5) {",
  "    vec3 diagnostic = vec3(valid);",
  "    finalColor = vec4(diagnostic, 1.0);",
  "    return;",
  "  }",
  "  if (valid < 0.5) {",
  "    finalColor = vec4(uMissingColor, 1.0);",
  "    return;",
  "  }",
  "  float scalar = filteredExposure(uv);",
  "  if (uViewMode > 0.5 && uViewMode < 1.5) {",
  "    finalColor = vec4(vec3(scalar), 1.0);",
  "    return;",
  "  }",
  "  float confidence = texture(uConfidenceTexture, uv).r;",
  "  float visible = texture(uVisibilityTexture, uv).r;",
  "  float yellowEligible = texture(uYellowTexture, uv).r;",
  "  if (uViewMode > 2.5 && uViewMode < 3.5) {",
  "    finalColor = vec4(vec3(confidence), 1.0);",
  "    return;",
  "  }",
  "  if (uViewMode > 3.5 && uViewMode < 4.5) {",
  "    finalColor = vec4(vec3(visible), 1.0);",
  "    return;",
  "  }",
  "  if (uViewMode > 4.5 && scalar < 0.63) scalar = uPurpleFloor * 0.35;",
  "  if (uAuthorityMode > 0.5 && yellowEligible < 0.5) scalar = min(scalar, 0.94);",
  "  scalar = max(scalar, uPurpleFloor);",
  "  scalar = clamp(scalar + dither(gl_FragCoord.xy) * uDitherStrength, 0.0, 1.0);",
  "  vec3 color = texture(uPaletteTexture, vec2(scalar, 0.5)).rgb;",
  "  if (uAuthorityMode > 0.5) {",
  "    float saturationAuthority = smoothstep(0.25, 0.78, confidence);",
  "    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));",
  "    color = mix(vec3(luminance), color, 0.38 + 0.62 * saturationAuthority);",
  "  }",
  "  float alpha = visible * max(0.18, uOpacity * (0.82 + 0.18 * pow(confidence, 0.7)));",
  "  finalColor = vec4(color * alpha, alpha);",
  "}"
].join("\n");

export interface BclifReferenceRendererMetrics {
  renderer: "REFERENCE_THERMAL_V2";
  scalarFormat: "r16float";
  confidenceFormat: "r8unorm";
  validityFormat: "r8unorm";
  visibilityFormat: "r8unorm";
  paletteFormat: "rgba8unorm";
  textureCount: 6;
  dimensions: string | null;
  shaderPasses: 1;
  mipmaps: false;
  blendMode: "normal";
}

export class BlackCoreReferenceThermalRendererV2 {
  readonly metrics: BclifReferenceRendererMetrics = {
    renderer: "REFERENCE_THERMAL_V2",
    scalarFormat: "r16float",
    confidenceFormat: "r8unorm",
    validityFormat: "r8unorm",
    visibilityFormat: "r8unorm",
    paletteFormat: "rgba8unorm",
    textureCount: 6,
    dimensions: null,
    shaderPasses: 1,
    mipmaps: false,
    blendMode: "normal"
  };

  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  private uniforms: UniformGroup | null = null;
  private exposure: BufferImageSource | null = null;
  private confidence: BufferImageSource | null = null;
  private validity: BufferImageSource | null = null;
  private visibility: BufferImageSource | null = null;
  private yellow: BufferImageSource | null = null;
  private palette: BufferImageSource | null = null;
  private paletteName = "";
  private columns = 0;
  private rows = 0;

  get view() {
    return this.mesh;
  }

  upload(projection: BclifDisplayProjection, settings: LiquidationFieldSettings) {
    const dimensionsChanged = projection.columns !== this.columns || projection.rows !== this.rows;
    if (dimensionsChanged || !this.mesh) {
      this.destroyGpuResources();
      this.columns = projection.columns;
      this.rows = projection.rows;
      this.createGpuResources(projection, settings);
    } else {
      this.updateScalarResources(projection);
      this.updateUniforms(settings);
      this.updatePalette(settings);
    }
    this.metrics.dimensions = projection.columns + "x" + projection.rows;
  }

  draw(x: number, y: number, width: number, height: number, visible: boolean) {
    if (!this.mesh) return false;
    this.mesh.position.set(x, y);
    this.mesh.scale.set(Math.max(1, width), Math.max(1, height));
    this.mesh.visible = visible;
    return visible;
  }

  setVisible(visible: boolean) {
    if (this.mesh) this.mesh.visible = visible;
  }

  destroy() {
    this.destroyGpuResources();
    this.columns = 0;
    this.rows = 0;
    this.metrics.dimensions = null;
  }

  private createGpuResources(projection: BclifDisplayProjection, settings: LiquidationFieldSettings) {
    const width = projection.rows;
    const height = projection.columns;
    this.exposure = scalarSource(projection.exposureHalf ?? bclifUint8ToHalf(projection.intensity), width, height, "r16float");
    this.confidence = scalarSource(projection.confidence, width, height, "r8unorm");
    this.validity = scalarSource(projection.validity, width, height, "r8unorm");
    this.visibility = scalarSource(projection.alpha, width, height, "r8unorm");
    this.yellow = scalarSource(projection.yellowEligible, width, height, "r8unorm");
    this.palette = paletteSource(createThermalPalette(settings.palette));
    this.paletteName = settings.palette;

    this.uniforms = new UniformGroup({
      uTexel: { value: new Float32Array([1 / width, 1 / height]), type: "vec2<f32>" },
      uMissingColor: { value: new Float32Array([5 / 255, 2 / 255, 11 / 255]), type: "vec3<f32>" },
      uOpacity: { value: settings.opacity / 100, type: "f32" },
      uAuthorityMode: { value: settings.authoritySemantics === "VERIFIED_AUTHORITY" ? 1 : 0, type: "f32" },
      uViewMode: { value: referenceViewMode(settings), type: "f32" },
      uPriceSmoothing: { value: smoothingWeight(settings.priceSigmaRows, 0.9), type: "f32" },
      uTimeSmoothing: { value: smoothingWeight(settings.timeSigmaColumns, 0.65), type: "f32" },
      uPurpleFloor: { value: settings.backgroundFloor / 255, type: "f32" },
      uDitherStrength: { value: 0.5 / 255, type: "f32" }
    });

    this.shader = Shader.from({
      gl: {
        name: "black-core-reference-thermal-v2",
        vertex: VERTEX,
        fragment: FRAGMENT,
        preferredFragmentPrecision: "highp"
      },
      resources: {
        bclifUniforms: this.uniforms,
        uExposureTexture: this.exposure,
        uConfidenceTexture: this.confidence,
        uValidityTexture: this.validity,
        uVisibilityTexture: this.visibility,
        uYellowTexture: this.yellow,
        uPaletteTexture: this.palette
      }
    });

    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3])
    });
    geometry.batchMode = "no-batch";
    this.mesh = new Mesh({ geometry, shader: this.shader });
    this.mesh.zIndex = -10;
    this.mesh.blendMode = "normal";
  }

  private updateScalarResources(projection: BclifDisplayProjection) {
    if (!this.exposure || !this.confidence || !this.validity || !this.visibility || !this.yellow) return;
    this.exposure.resource = projection.exposureHalf ?? bclifUint8ToHalf(projection.intensity);
    this.confidence.resource = projection.confidence;
    this.validity.resource = projection.validity;
    this.visibility.resource = projection.alpha;
    this.yellow.resource = projection.yellowEligible;
    this.exposure.update();
    this.confidence.update();
    this.validity.update();
    this.visibility.update();
    this.yellow.update();
  }

  private updateUniforms(settings: LiquidationFieldSettings) {
    if (!this.uniforms) return;
    this.uniforms.uniforms.uOpacity = settings.opacity / 100;
    this.uniforms.uniforms.uAuthorityMode = settings.authoritySemantics === "VERIFIED_AUTHORITY" ? 1 : 0;
    this.uniforms.uniforms.uViewMode = referenceViewMode(settings);
    this.uniforms.uniforms.uPriceSmoothing = smoothingWeight(settings.priceSigmaRows, 0.9);
    this.uniforms.uniforms.uTimeSmoothing = smoothingWeight(settings.timeSigmaColumns, 0.65);
    this.uniforms.uniforms.uPurpleFloor = settings.backgroundFloor / 255;
  }

  private updatePalette(settings: LiquidationFieldSettings) {
    if (!this.palette || this.paletteName === settings.palette) return;
    this.palette.resource = createThermalPalette(settings.palette);
    this.palette.update();
    this.paletteName = settings.palette;
  }

  private destroyGpuResources() {
    if (this.mesh?.parent) this.mesh.parent.removeChild(this.mesh);
    this.mesh?.geometry.destroy();
    this.mesh?.destroy();
    this.shader?.destroy(true);
    for (const source of [this.exposure, this.confidence, this.validity, this.visibility, this.yellow, this.palette]) {
      source?.destroy();
    }
    this.mesh = null;
    this.shader = null;
    this.uniforms = null;
    this.exposure = null;
    this.confidence = null;
    this.validity = null;
    this.visibility = null;
    this.yellow = null;
    this.palette = null;
  }
}

function scalarSource(
  resource: Uint8Array | Uint16Array,
  width: number,
  height: number,
  format: "r8unorm" | "r16float"
) {
  const source = new BufferImageSource({ resource, width, height, format });
  source.style.scaleMode = "nearest";
  source.autoGenerateMipmaps = false;
  return source;
}

function paletteSource(resource: Uint8Array) {
  const source = new BufferImageSource({ resource, width: 256, height: 1, format: "rgba8unorm" });
  source.style.scaleMode = "linear";
  source.autoGenerateMipmaps = false;
  return source;
}

function smoothingWeight(value: number, maximum: number) {
  return Math.max(0, Math.min(maximum, value / 1.5));
}

function referenceViewMode(settings: LiquidationFieldSettings) {
  if (settings.viewMode === "RAW_EXPOSURE") return 1;
  if (settings.viewMode === "VALIDITY_MASK") return 2;
  if (settings.viewMode === "CONFIDENCE_FIELD") return 3;
  if (settings.viewMode === "ALPHA_OUTPUT") return 4;
  if (settings.viewMode === "SHELF_LINES_ONLY") return 5;
  return 0;
}
