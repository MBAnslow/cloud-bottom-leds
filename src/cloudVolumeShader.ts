/**
 * 3D volumetric cloud, lit from an LED plane embedded in its base — the real
 * physical layout we're building: a grid of LEDs sitting just inside the bottom
 * of a cloud, throwing coloured light up into the volume.
 *
 * Two passes:
 *   1) Emission pass: accumulate the LEDs' flux-conserving gaussian glow into an
 *      offscreen texture (the light leaving the base plane, in cloud footprint
 *      UV space). This reuses the exact same physical spread as the flat view.
 *   2) Volume pass: a full-screen ray-march of a procedural cloud density field
 *      inside an axis-aligned box. At each step the light is the base emission
 *      (sampled with a height-growing blur and attenuated upward through the
 *      medium), scattered toward the eye and composited front-to-back.
 *
 * The camera is a real perspective camera driven by OrbitControls, so the build
 * can be inspected from any angle (including from underneath).
 */

// Shared full-screen pass-through (NDC quad). vUv in [0,1].
export const fullscreenVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// --- Pass 1: LED emission at the base plane ------------------------------
export const emissionFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uLeds;
  uniform float uCols;
  uniform float uRows;
  uniform vec2  uSigma;     // light-spread std-dev (x,y) in LED-pitch units
  uniform float uLedGain;
  uniform float uWhiteMix;  // RGBW white-die contribution

  vec3 ledColor(float c, float r) {
    return texture2D(uLeds, vec2((c + 0.5) / uCols, (r + 0.5) / uRows)).rgb;
  }

  void main() {
    vec2 p = vec2(vUv.x * uCols, vUv.y * uRows);
    float baseC = floor(p.x);
    float baseR = floor(p.y);
    float sx = max(1e-4, uSigma.x);
    float sy = max(1e-4, uSigma.y);
    float coeff = uLedGain / (6.2831853 * sx * sy);
    vec3 light = vec3(0.0);
    const int R = 10;
    for (int dj = -R; dj <= R; dj++) {
      for (int di = -R; di <= R; di++) {
        float cc = baseC + float(di);
        float rr = baseR + float(dj);
        if (cc < 0.0 || cc > uCols - 1.0 || rr < 0.0 || rr > uRows - 1.0) continue;
        vec2 center = vec2(cc + 0.5, rr + 0.5);
        vec2 d = p - center;
        float w = coeff * exp(-0.5 * ((d.x * d.x) / (sx * sx) + (d.y * d.y) / (sy * sy)));
        vec3 c = ledColor(cc, rr);
        c += uWhiteMix * min(min(c.r, c.g), c.b) * vec3(1.0);
        light += c * w;
      }
    }
    gl_FragColor = vec4(light, 1.0);
  }
`;

// --- Pass 2: volumetric ray-march ----------------------------------------
export const volumeFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2  uResolution;
  uniform mat4  uInvViewProj;
  uniform vec3  uCamPos;

  uniform sampler2D uEmission;  // base-plane LED glow (footprint UV)
  uniform vec3  uBoxHalf;       // half extents: x, height(y from 0), z

  uniform float uCloudDensity;  // overall optical thickness scale
  uniform float uAmbient;       // base self-lit fill
  uniform float uTransmission;  // diffuser transmittance (dims the light)
  uniform float uLightReach;    // how far light climbs before fading (0..1 of height)
  uniform vec3  uSkyBottom;     // cloud-view background gradient (bottom)
  uniform vec3  uSkyTop;        // cloud-view background gradient (top)

  // Cloud density at a world point inside the box: smooth dome-like body
  // without bump/noise controls.
  float densityAt(vec3 P) {
    vec3 h = uBoxHalf;
    // Normalised position so noise frequency is independent of physical size.
    vec3 np = P / h;                 // x,z in [-1,1], y in [0,1]
    float r = length(np.xz);
    float cy = clamp(np.y, 0.0, 1.0);

    // Base dome profile: max radius allowed shrinks toward the top
    // (quarter-ellipse), giving a rounded heap that's wide at the base.
    float dome = sqrt(max(0.0, 1.0 - cy * cy));
    float env = smoothstep(dome + 0.10, dome - 0.03, r);
    if (env <= 0.0) return 0.0;

    // Keep a fuller flat base so the LEDs are embedded inside the bottom.
    float d = env * 0.82;
    float baseFill = (1.0 - smoothstep(0.0, 0.16, cy)) * env;
    d = max(d, baseFill);
    return clamp(d, 0.0, 1.0) * uCloudDensity;
  }

  // Base emission sampled with a height-growing blur (light spreads as it rises).
  vec3 emissionAt(vec2 uv, float cy) {
    float r = 0.02 + 0.28 * cy;
    vec3 s  = texture2D(uEmission, uv).rgb * 0.36;
    s += texture2D(uEmission, uv + vec2(r, 0.0)).rgb * 0.16;
    s += texture2D(uEmission, uv - vec2(r, 0.0)).rgb * 0.16;
    s += texture2D(uEmission, uv + vec2(0.0, r)).rgb * 0.16;
    s += texture2D(uEmission, uv - vec2(0.0, r)).rgb * 0.16;
    return s;
  }

  vec2 hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
    vec3 t0 = (bmin - ro) / rd;
    vec3 t1 = (bmax - ro) / rd;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tn = max(max(tmin.x, tmin.y), tmin.z);
    float tf = min(min(tmax.x, tmax.y), tmax.z);
    return vec2(tn, tf);
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 pf = uInvViewProj * vec4(ndc, 1.0, 1.0);
    pf /= pf.w;
    vec3 ro = uCamPos;
    vec3 rd = normalize(pf.xyz - ro);

    vec3 sky = mix(uSkyBottom, uSkyTop, clamp(vUv.y, 0.0, 1.0));

    vec3 bmin = vec3(-uBoxHalf.x, 0.0, -uBoxHalf.z);
    vec3 bmax = vec3( uBoxHalf.x, uBoxHalf.y, uBoxHalf.z);
    vec2 hb = hitBox(ro, rd, bmin, bmax);
    float tn = max(hb.x, 0.0);
    float tf = hb.y;

    vec3 col = vec3(0.0);
    float trans = 1.0;

    if (tf > tn) {
      const int STEPS = 64;
      float stepLen = (tf - tn) / float(STEPS);
      // The cloud material is white; it is illuminated by a dim white "sky"
      // (brighter toward the top) for its puffy form, plus the coloured LED
      // light rising from the base.
      vec3 white = vec3(1.0);
      for (int i = 0; i < STEPS; i++) {
        float t = tn + (float(i) + 0.5) * stepLen;
        vec3 P = ro + rd * t;
        float dens = densityAt(P);
        if (dens > 0.003) {
          float cy = clamp(P.y / uBoxHalf.y, 0.0, 1.0);
          vec2 uv = vec2((P.x + uBoxHalf.x) / (2.0 * uBoxHalf.x),
                         (P.z + uBoxHalf.z) / (2.0 * uBoxHalf.z));

          // White body: keep it subtle so LED colour reads, with gentle top lift.
          vec3 body = white * (0.03 + 0.22 * cy + 0.35 * uAmbient);

          // Coloured LED light, strongest at the base, fading as it climbs.
          float climb = exp(-cy / max(0.05, uLightReach));
          vec3 L = emissionAt(uv, cy) * climb * uTransmission * (1.15 - 0.35 * cy);

          vec3 scat = body + L;
          float a = 1.0 - exp(-20.0 * dens * stepLen);
          col += trans * a * scat;
          trans *= (1.0 - a);
          if (trans < 0.01) break;
        }
      }
    }

    col += trans * sky;
    col = vec3(1.0) - exp(-col * 0.95);
    col = pow(col, vec3(1.0 / 2.2));
    gl_FragColor = vec4(col, 1.0);
  }
`;
