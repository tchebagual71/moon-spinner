/**
 * GLSL for the Moon surface. One program family is used both for the base globe (a single
 * lat/lon grid patch covering the sphere) and for streamed tile patches (`#define TILE`), so
 * lighting, displacement and overlays are identical and the patches blend seamlessly.
 *
 * Photometry (all in linear light, observer treated as distant so phase is uniform over a frame):
 *   I = A * [ L(a) * 2 mu0/(mu0+mu) + (1-L(a)) * mu0 ] * f(a)          (lunar-Lambert, McEwen 1991/96)
 *   L(a) = 1 - 0.019 a + 2.42e-4 a^2 - 1.46e-6 a^3  (a = phase angle in degrees, clamped to 0..1)
 *   f(a) = exp(-0.8 a_rad) * (1 + B0/(1 + tan(a/2)/h)) / (1 + B0)      (opposition surge, Hapke SHOE form)
 * At zero phase mu0 == mu so the Lommel-Seeliger term is exactly 1 everywhere: a flat, limb-bright
 * full disc with no relief shading, as on the real full Moon.
 */

export const RAMP_SIZE = 8;

/** Phase function parameters shared between GLSL and the CPU auto-exposure. */
export const PHASE_B0 = 0.6;
export const PHASE_H = 0.07;
export const PHASE_K = 0.8;

export function phaseFunction(alphaRad: number): number {
  const th = Math.tan(Math.min(alphaRad, 3.1) * 0.5);
  const surge = (1 + PHASE_B0 / (1 + th / PHASE_H)) / (1 + PHASE_B0);
  return surge * Math.exp(-PHASE_K * alphaRad);
}

const COMMON = /* glsl */ `
#define PI 3.141592653589793
#define TWO_PI 6.283185307179586
uniform sampler2D uHeight;
uniform float uHScale;      // km -> sphere radii, times relief exaggeration
uniform vec4 uRect;         // patch extent in global uv: (u0, v0, u1, v1)
`;

export const VERTEX = /* glsl */ `
precision highp float;
precision highp sampler2D;
${COMMON}
uniform float uHeightLod;
out vec3 vDir;
out vec2 vTuv;

void main() {
  vec2 guv = mix(uRect.xy, uRect.zw, position.xy);
  float lon = (guv.x - 0.5) * TWO_PI;
  float lat = (guv.y - 0.5) * PI;
  float cl = cos(lat);
  vec3 dir = vec3(cl * sin(lon), sin(lat), cl * cos(lon));
  float h = textureLod(uHeight, guv, uHeightLod).r * uHScale;
  vDir = dir;
  vTuv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(dir * (1.0 + h), 1.0);
}
`;

export const FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;
${COMMON}
uniform sampler2D uColor;
uniform sampler2D uNormal;
uniform sampler2D uConf;
uniform vec2 uColorSize;
uniform float uNormalScale;   // relief / normalGain
uniform float uHMax;          // highest terrain, in radii (already times relief)
uniform vec3 uSunDir;
uniform vec3 uViewDir;        // unit vector from the Moon centre to the camera
uniform float uFullMix;       // 0 = sun-lit, 1 = 'full' exploration lighting
uniform float uExposure;
uniform float uEarthshine;
uniform float uConfOpacity;
uniform float uHatchPx;
uniform vec3 uRamp[${RAMP_SIZE}];
uniform float uRampStops[${RAMP_SIZE}];
uniform vec3 uSelDir;
uniform vec3 uSel;            // (ring radius, pixel size, enabled) in radians on the unit sphere
#ifdef TILE
uniform sampler2D uTile;
uniform float uTileAlpha;
uniform vec2 uTileTone;       // (gain, gamma) mapping WAC mosaic grey to base-map luminance
#endif

in vec3 vDir;
in vec2 vTuv;
out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 aces(vec3 x) {
  // Narkowicz 2015 fit of the ACES filmic curve
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

vec2 dirToUv(vec3 d) {
  return vec2(atan(d.x, d.z) / TWO_PI + 0.5, atan(d.y, length(d.xz)) / PI + 0.5);
}

#if SHADOW_STEPS > 0
// Horizon shadowing: march from the surface point toward the Sun over the height map.
float terrainShadow(vec3 dir, vec2 uv, float mu0g) {
  float h0 = textureLod(uHeight, uv, 0.0).r * uHScale;
  // Beyond tmax the ray is above the highest terrain on the Moon (sphere curvature included).
  float tmax = -mu0g + sqrt(max(mu0g * mu0g + 2.0 * max(uHMax - h0, 0.0), 0.0));
  tmax = min(tmax, 0.16);
  vec3 p0 = dir * (1.0 + h0);
  float jitter = ign(gl_FragCoord.xy);
  float res = 1.0;
  float texW = float(textureSize(uHeight, 0).x);
  for (int i = 0; i < SHADOW_STEPS; i++) {
    float f = (float(i) + 0.35 + 0.65 * jitter) / float(SHADOW_STEPS);
    float t = tmax * f * f;
    vec3 p = p0 + uSunDir * t;
    float r = length(p);
    float stepLen = tmax * (2.0 * f) / float(SHADOW_STEPS);
    float lod = clamp(log2(stepLen * texW / TWO_PI) - 1.0, 0.0, 5.0);
    float ht = textureLod(uHeight, dirToUv(p / r), lod).r * uHScale;
    // clearance relative to the Sun's angular radius (0.0047 rad) gives a soft penumbra
    res = min(res, (r - 1.0 - ht) / (t * 0.012) + 0.6);
  }
  return clamp(res, 0.0, 1.0);
}
#endif

vec3 rampColor(float c) {
  vec3 col = uRamp[0];
  for (int i = 1; i < ${RAMP_SIZE}; i++) {
    float k = clamp((c - uRampStops[i - 1]) / max(uRampStops[i] - uRampStops[i - 1], 1e-5), 0.0, 1.0);
    col = mix(col, uRamp[i], k);
  }
  return col;
}

void main() {
  vec3 dir = normalize(vDir);
  float cl = max(length(dir.xz), 1e-6);
  float sl = dir.y;
  float so = dir.x / cl;
  float co = dir.z / cl;
  float lon = atan(dir.x, dir.z);
  float lat = atan(dir.y, cl);
  vec2 uv = vec2(lon / TWO_PI + 0.5, lat / PI + 0.5);

  // Seam-free derivatives: u jumps at lon = +-180; a copy shifted by half a turn jumps at lon = 0.
  // Take, per axis, the derivative of whichever copy is continuous here.
  float uB = fract(uv.x + 0.5);
  float dax = dFdx(uv.x); float dbx = dFdx(uB);
  float day = dFdy(uv.x); float dby = dFdy(uB);
  vec2 gx = vec2(abs(dax) < abs(dbx) ? dax : dbx, dFdx(uv.y));
  vec2 gy = vec2(abs(day) < abs(dby) ? day : dby, dFdy(uv.y));

  // ---- albedo ----
  vec3 albedo = textureGrad(uColor, uv, gx, gy).rgb;
  float baseLum = dot(albedo, LUMA);
#ifdef TILE
  // WAC mosaic (greyscale, 100 m/px) supplies luminance, the base map supplies chroma.
  // Weight by how strongly the base texture is being magnified so detail fades in smoothly.
  vec2 fw = abs(gx) + abs(gy);
  float footprint = max(fw.y * uColorSize.y, fw.x * uColorSize.x * cl);
  float w = (1.0 - smoothstep(0.4, 0.85, footprint)) * uTileAlpha;
  float tl = pow(texture(uTile, vTuv).r, uTileTone.y) * uTileTone.x;
  vec3 chroma = albedo / max(baseLum, 0.004);
  albedo = mix(albedo, chroma * tl, w);
#endif

  // ---- normal: tangent frame (east, north, up) -> world, analytically from lat/lon ----
  vec3 nt = textureGrad(uNormal, uv, gx, gy).xyz * 2.0 - 1.0;
  vec2 slope = nt.xy / max(nt.z, 0.08) * uNormalScale;
  vec3 ntn = normalize(vec3(slope, 1.0));
  vec3 east = vec3(co, 0.0, -so);
  vec3 north = vec3(-sl * so, cl, -sl * co);
  vec3 n = normalize(east * ntn.x + north * ntn.y + dir * ntn.z);

  // ---- sun-lit photometry ----
  vec3 V = uViewDir;
  vec3 L = uSunDir;
  float mu0g = dot(dir, L);
  float mu0 = max(dot(n, L), 0.0);
  float mu = max(dot(n, V), 0.0);
  float cosA = clamp(dot(L, V), -1.0, 1.0);
  float alpha = acos(cosA);
  float deg = degrees(alpha);
  float Lf = clamp(1.0 + deg * (-0.019 + deg * (2.42e-4 - 1.46e-6 * deg)), 0.0, 1.0);
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  float disk = Lf * ls + (1.0 - Lf) * mu0;
  float th = tan(min(alpha, 3.1) * 0.5);
  float phase = (1.0 + ${PHASE_B0.toFixed(3)} / (1.0 + th / ${PHASE_H.toFixed(3)})) / ${(1 + PHASE_B0).toFixed(3)} * exp(-${PHASE_K.toFixed(3)} * alpha);
  // Terminator: the Sun's disc is 0.53 deg wide, so the geometric horizon cut is slightly soft.
  float lit = smoothstep(-0.006, 0.012, mu0g);
#if SHADOW_STEPS > 0
  if (uFullMix < 0.999 && mu0g > -0.006 && mu0g < 0.5) {
    float sh = terrainShadow(dir, uv, mu0g);
    lit *= mix(sh, 1.0, smoothstep(0.35, 0.5, mu0g));
  }
#endif
  vec3 sunlit = albedo * (disk * phase * lit);

  // Earthshine: sunlight reflected by the Earth, which sits at +Z (sub-Earth point ~ lon 0, lat 0).
  float muE = max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0);
  float earth = uEarthshine * (0.35 * muE + 0.65 * 2.0 * muE / (muE + mu + 1e-3)) * smoothstep(-0.05, 0.1, dir.z);
  vec3 lin = (sunlit + albedo * vec3(0.72, 0.84, 1.0) * earth) * uExposure;

  // ---- 'full' exploration lighting: even illumination + hill-shade from a fixed local direction ----
  const vec3 hl = vec3(-0.5145, 0.3430, 0.7860);   // from the north-west, 52 deg above the horizon
  float hill = dot(ntn, hl) / hl.z;
  float relief = clamp(mix(1.0, hill, 0.8), 0.12, 1.9);
  vec3 fullCol = albedo * relief * 0.95;

  lin = mix(lin, fullCol, uFullMix);
  vec3 col = toSrgb(aces(lin * 0.92));

  // ---- data-support overlay ----
  if (uConfOpacity > 0.002) {
    float c = textureGrad(uConf, uv, gx, gy).b;
    vec3 rc = rampColor(c);
    float shade = clamp(mix(1.0, hill, 0.55), 0.45, 1.35) * (0.62 + 0.55 * sqrt(clamp(baseLum, 0.0, 1.0)));
    vec3 oc = clamp(rc * shade, 0.0, 1.0);
    float lowMask = 1.0 - smoothstep(HATCH_T - 0.012, HATCH_T + 0.012, c);
    float s = (gl_FragCoord.x + gl_FragCoord.y) / uHatchPx;
    float stripe = 1.0 - smoothstep(0.16, 0.26, abs(fract(s) - 0.5));
    oc = mix(oc, vec3(0.97, 0.95, 1.0), stripe * lowMask * 0.62);
    col = mix(col, oc, uConfOpacity);
  }

  // ---- selection reticle (ring on the surface) ----
  if (uSel.z > 0.5) {
    float d = length(dir - uSelDir);
    float px = uSel.y;
    float e = abs(d - uSel.x);
    float ring = 1.0 - smoothstep(0.9 * px, 1.9 * px, e);
    float halo = 1.0 - smoothstep(2.0 * px, 3.4 * px, e);
    float dotc = 1.0 - smoothstep(1.6 * px, 2.6 * px, d);
    col = mix(col, vec3(0.02, 0.03, 0.05), halo * 0.55);
    col = mix(col, vec3(1.0, 0.86, 0.42), max(ring, dotc));
  }

  col += (ign(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
#ifdef TILE
  fragColor = vec4(col, uTileAlpha);
#else
  fragColor = vec4(col, 1.0);
#endif
}
`;

export const STAR_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 aColor;
attribute float aSize;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  p.z = 0.0;
  gl_Position = p;
  gl_PointSize = aSize * uPixelRatio;
}
`;

export const STAR_FRAGMENT = /* glsl */ `
precision mediump float;
uniform float uOpacity;
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float a = 1.0 - smoothstep(0.12, 0.5, length(q));
  gl_FragColor = vec4(vColor * (a * uOpacity), 1.0);
}
`;
