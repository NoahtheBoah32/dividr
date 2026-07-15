/**
 * relightGL — the screen-space relighter (WebGL1). Replaces the flat 2D radial-glow.
 *
 * Given the composited preview frame (any canvas/video/image source) and a RelightConfig,
 * it reconstructs per-pixel surface normals from the image's OWN luminance heightfield
 * (a large-scale FORM gradient + a fine DETAIL gradient — no subject matte, no isolation)
 * and shades them with a movable point-light, entirely in linear light. The whole
 * environment is lit by the same light, so it reads as controlling the light INSIDE the
 * scene rather than a sticker on top. Resolution-invariant: kernels are sized in UV
 * fractions, so Full/Half/Quarter previews look the same.
 *
 * Self-contained: owns its GL context + output canvas, no React, no tokens, no model.
 */
import type { RelightConfig } from './paintedLightUtils';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){
  vUv = (aPos + 1.0) * 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;    // 1/resolution
uniform float uAspect;  // W/H
uniform vec2 uLight;    // 0..1 (y up — already flipped from DOM y-down)
uniform float uLz;      // light height above the plane
uniform vec3 uColor;    // sRGB 0..1, normalized so the brightest channel is 1
uniform float uInt, uAmbient, uWrap, uForm, uDetail, uSheen, uRim, uSpill, uNeg, uRadius, uEngaged;

const float SHIN = 22.0;

vec3 s2l(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 l2s(vec3 c){ c=max(c,0.0); return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(vec3(0.0031308), c)); }
float lum(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
float linLuma(vec2 uv){ return lum(s2l(texture2D(uTex, clamp(uv, 0.0005, 0.9995)).rgb)); }
float softLuma(vec2 uv){
  vec2 t = uTexel;
  float s = linLuma(uv) * 2.0;
  s += linLuma(uv + vec2(t.x,0.0)) + linLuma(uv - vec2(t.x,0.0));
  s += linLuma(uv + vec2(0.0,t.y)) + linLuma(uv - vec2(0.0,t.y));
  return s / 6.0;
}

void main(){
  vec3 srgb = texture2D(uTex, vUv).rgb;
  if(uEngaged < 0.5){ gl_FragColor = vec4(srgb, 1.0); return; }
  vec3 lin = s2l(srgb);

  // ---- surface normals from the luminance heightfield (form + detail) ----
  float formUV = 0.024;                       // ~2.4% of width — the "shape" scale
  vec2 fo = vec2(formUV, formUV * uAspect);
  float fL = softLuma(vUv - vec2(fo.x, 0.0));
  float fR = softLuma(vUv + vec2(fo.x, 0.0));
  float fD = softLuma(vUv + vec2(0.0, fo.y)); // +uv.y = up
  float fU = softLuma(vUv - vec2(0.0, fo.y));
  vec2 formG = vec2(fR - fL, fD - fU);

  float dL = linLuma(vUv - vec2(uTexel.x, 0.0));
  float dR = linLuma(vUv + vec2(uTexel.x, 0.0));
  float dD = linLuma(vUv + vec2(0.0, uTexel.y));
  float dU = linLuma(vUv - vec2(0.0, uTexel.y));
  vec2 detG = vec2(dR - dL, dD - dU);

  // Hard luminance edges (a dark figure against a bright wall) are OCCLUSION
  // boundaries, not surface shape — shading them as tilt is what painted the
  // bright "wrap" halo around people. Fade the tilt toward flat as edge
  // contrast rises, then soft-clamp what remains.
  float edgeMag = length(formG) * 2.0 + length(detG);
  float edgeKeep = 1.0 - smoothstep(0.16, 0.5, edgeMag);
  vec2 nT = (formG * uForm * 4.5 + detG * uDetail * 9.0) * mix(0.25, 1.0, edgeKeep);
  nT = nT / (1.0 + abs(nT) * 0.7);
  vec3 N = normalize(vec3(-nT, 1.0));

  // ---- movable point light in aspect-corrected UV space ----
  vec2 P  = vec2(vUv.x * uAspect, vUv.y);
  vec2 LP = vec2(uLight.x * uAspect, uLight.y);
  vec2 d  = LP - P;
  float dist = length(d);
  vec3 L = normalize(vec3(d, uLz));
  float ndl = dot(N, L);

  float r2 = max(uRadius * uRadius, 1e-4);
  float falloff = r2 / (r2 + dist * dist);

  // half-Lambert wrap — soft, never fully black on the shadow side
  float wrapped = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  float key = wrapped * falloff;

  // Light needs a SURFACE to land on — every additive term below is gated by scene
  // visibility so nothing fogs the black voids into a milky "glaze".
  float sceneVis = smoothstep(0.0, 0.22, lum(lin));

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), SHIN) * uSheen * falloff * (0.2 + 0.8 * sceneVis);

  // rim gated to the lit side so it can't ring the whole frame
  float fres = pow(1.0 - clamp(N.z, 0.0, 1.0), 3.0);
  float rim = fres * clamp(ndl * 0.5 + 0.5, 0.0, 1.0) * uRim * falloff * (0.2 + 0.8 * sceneVis);

  // room spill around the light
  float spill = uSpill * exp(-dist * dist / (2.0 * r2 * 0.4)) * (0.08 + 0.92 * sceneVis);

  vec3 lcol = s2l(uColor);
  // Steeper reflectance curve: true blacks reflect almost nothing, so the key
  // reveals real surfaces instead of laying a grey veil over dark areas.
  vec3 albedo = pow(lin, vec3(0.85));

  // ADDITIVE ONLY — the untouched original frame is the base. Every term below
  // ADDS light on top of it: at zero sliders the output IS the input, and nothing
  // here can darken the footage. Negative fill (explicit, defaults to 0) is the
  // single opt-in darkener.
  vec3 ambC = albedo * lcol * (uAmbient * 1.6);     // scene-wide ambient lift, 0 = none
  vec3 keyC = albedo * lcol * (key * uInt);         // directional key light
  vec3 hi   = lcol * ((spec + rim) * uInt);         // clean highlights
  vec3 spl  = lcol * (spill * uInt * 0.6);          // soft room spill
  vec3 added = ambC + keyC + hi + spl;
  added = added / (1.0 + added * 0.35);             // soft shoulder on the ADDED light only

  vec3 outLin = lin + added;

  float away = clamp(-ndl, 0.0, 1.0);
  outLin *= (1.0 - uNeg * away * 0.85);             // negative fill on the far side (opt-in)

  vec3 disp = l2s(clamp(outLin, 0.0, 8.0));
  // cheap ordered dither breaks banding in the lifted shadows (no Math.random)
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  disp += (dither - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(disp, 0.0, 1.0), 1.0);
}`;

const U_NAMES = [
  'uTex', 'uTexel', 'uAspect', 'uLight', 'uLz', 'uColor', 'uInt', 'uAmbient',
  'uWrap', 'uForm', 'uDetail', 'uSheen', 'uRim', 'uSpill', 'uNeg', 'uRadius',
  'uEngaged',
] as const;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('[relightGL] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export type RelightSource = HTMLCanvasElement | HTMLVideoElement | HTMLImageElement | ImageBitmap;

/** Params the shader needs per frame. `pos` stays in DOM y-down space; we flip it here. */
export interface RelightRenderParams
  extends Omit<RelightConfig, 'enabled' | 'mode'> {
  /** Legacy field — the additive model has a single look; accepted and ignored. */
  mode?: 'shape' | 'faux';
  engaged: boolean;
}

export class Relighter {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private prog: WebGLProgram | null = null;
  private buf: WebGLBuffer | null = null;
  private tex: WebGLTexture | null = null;
  private loc: Partial<Record<(typeof U_NAMES)[number], WebGLUniformLocation | null>> = {};
  private w = 0;
  private h = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
    }) as WebGLRenderingContext | null;
    this.gl = gl;
    if (!gl) return;

    // Under context pressure (video pipeline, thumbnails, other GL users) the browser
    // EVICTS the oldest context: "Too many active WebGL contexts. Oldest context will
    // be lost." Without these handlers a lost context silently no-ops every render and
    // the light freezes. preventDefault() opts into automatic restoration; on restore
    // all GL resources are gone, so we rebuild them.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.prog = null; // renders no-op until restored
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.w = 0;
      this.h = 0;
      this.initGL();
    });

    this.initGL();
  }

  /** (Re)build shaders, program, quad buffer, and texture — used at construction and after context restore. */
  private initGL(): void {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    this.prog = null;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      // eslint-disable-next-line no-console
      console.warn('[relightGL] link failed:', gl.getProgramInfoLog(prog));
      return;
    }
    this.prog = prog;
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    for (const n of U_NAMES) this.loc[n] = gl.getUniformLocation(prog, n);

    // Fullscreen quad (two triangles).
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  get ok(): boolean {
    return !!this.gl && !!this.prog;
  }

  /** True when the GL context is currently lost (evicted). Renders no-op until restore. */
  get lost(): boolean {
    return !this.gl || this.gl.isContextLost();
  }

  /** Upload `src`, set uniforms, draw the relit frame into this.canvas at src resolution. */
  render(src: RelightSource, w: number, h: number, p: RelightRenderParams): void {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || !this.prog || w <= 0 || h <= 0) return;

    if (w !== this.w || h !== this.h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.w = w;
      this.h = h;
      gl.viewport(0, 0, w, h);
    }

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    } catch {
      return; // source not yet decodable this tick
    }

    // Dev observability: lets tests confirm the mounted loop is actually rendering.
    const stats = ((globalThis as any).__relightStats ??= { renders: 0, lastIntensity: 0, lastEngaged: false, lastAt: 0 });
    stats.renders++;
    stats.lastIntensity = p.intensity;
    stats.lastEngaged = !!p.engaged;
    stats.lastAt = Date.now();

    const L = this.loc;
    gl.uniform1i(L.uTex ?? null, 0);
    gl.uniform2f(L.uTexel ?? null, 1 / w, 1 / h);
    gl.uniform1f(L.uAspect ?? null, w / h);
    gl.uniform2f(L.uLight ?? null, p.pos[0], 1 - p.pos[1]); // DOM y-down → UV y-up
    gl.uniform1f(L.uLz ?? null, p.height);
    const mx = Math.max(1, p.color[0], p.color[1], p.color[2]);
    gl.uniform3f(L.uColor ?? null, p.color[0] / mx, p.color[1] / mx, p.color[2] / mx);
    gl.uniform1f(L.uInt ?? null, p.intensity);
    gl.uniform1f(L.uAmbient ?? null, p.ambient);
    gl.uniform1f(L.uWrap ?? null, p.wrap);
    // Form above ~0.9 turns the heightfield into an embossed "glaze" over the whole
    // frame — clamp it regardless of what an old stored config carries.
    gl.uniform1f(L.uForm ?? null, Math.min(Math.max(p.form ?? 0.45, 0), 0.9));
    gl.uniform1f(L.uDetail ?? null, p.detail);
    gl.uniform1f(L.uSheen ?? null, p.sheen);
    gl.uniform1f(L.uRim ?? null, p.rim);
    gl.uniform1f(L.uSpill ?? null, p.spill);
    gl.uniform1f(L.uNeg ?? null, p.neg);
    gl.uniform1f(L.uRadius ?? null, p.radius);
    gl.uniform1f(L.uEngaged ?? null, p.engaged ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.buf) gl.deleteBuffer(this.buf);
    if (this.prog) gl.deleteProgram(this.prog);
    this.tex = null;
    this.buf = null;
    this.prog = null;
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    this.gl = null;
  }
}
