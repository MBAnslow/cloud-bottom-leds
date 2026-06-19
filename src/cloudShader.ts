export const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // full-screen quad: ignore camera transforms
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform vec2  uResolution;
  uniform float uTime;

  uniform sampler2D uLeds;   // cols x rows, RGBA float, .rgb = LED color
  uniform float uCols;
  uniform float uRows;
  uniform float uCloudAspect; // physical cloud width / height
  uniform vec2  uSigma;      // light-spread std-dev (x,y) in LED-pitch units
  uniform float uLedGain;    // emitter brightness / drive
  uniform float uWhiteMix;   // RGBW white-die contribution (0 for RGB types)
  uniform float uTransmission; // diffuser transmittance 0..1 (1 - opacity)

  uniform float uBumpHeight;
  uniform float uBumpScale;
  uniform int   uBumpDetail;

  uniform float uAmbient;
  uniform float uBackground;

  // --- value noise / fbm for the cloud surface ---
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= uBumpDetail) break;
      s += a * noise(p);
      norm += a;
      p *= 2.0;
      a *= 0.5;
    }
    return norm > 0.0 ? s / norm : 0.0;
  }

  vec3 ledColor(float c, float r) {
    return texture2D(uLeds, vec2((c + 0.5) / uCols, (r + 0.5) / uRows)).rgb;
  }

  void main() {
    // Fit the physical cloud rectangle into the screen (contain), preserving
    // its real width:height aspect so the LEDs are spaced (never stretched).
    float screenAspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = vUv;
    if (screenAspect > uCloudAspect) {
      float s = uCloudAspect / screenAspect;
      uv.x = (vUv.x - 0.5) / s + 0.5;
    } else {
      float s = screenAspect / uCloudAspect;
      uv.y = (vUv.y - 0.5) / s + 0.5;
    }

    // Outside the cloud panel: plain background so the cloud's width & height
    // read clearly as a bounded rectangle.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(vec3(0.015, 0.018, 0.03), 1.0);
      return;
    }

    // Grid space (row 0 at top).
    vec2 p = vec2(uv.x, 1.0 - uv.y) * vec2(uCols, uRows);
    float baseC = floor(p.x);
    float baseR = floor(p.y);

    // Each LED spreads its flux as a flux-conserving 2D gaussian on the
    // diffuser (normalised so total energy is constant): moving LEDs back
    // widens the spot AND lowers its peak, evening the light out.
    // Only a tiny numerical epsilon to avoid divide-by-zero below; the real
    // (round-preserving) floor is applied as a scalar in mm on the CPU side.
    float sx = max(1e-4, uSigma.x);
    float sy = max(1e-4, uSigma.y);
    float coeff = uLedGain / (6.2831853 * sx * sy);
    vec3 light = vec3(0.0);

    // The window must comfortably cover the larger per-axis sigma, otherwise the
    // gaussian gets truncated on one axis and the spot looks squashed/elliptical.
    // R = 10 covers up to ~3.3 sigma when sigma (in cell units) is capped at 3.0.
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
        // RGBW: a dedicated white die lifts the common (min) channel, giving
        // cleaner, brighter, less-saturated output than mixing R+G+B.
        c += uWhiteMix * min(min(c.r, c.g), c.b) * vec3(1.0);
        light += c * w;
      }
    }

    // --- cloud surface from fbm (static physical surface) ---
    // scale x by aspect so bumps stay round on non-square panels
    vec2 q = vec2(uv.x * uCloudAspect, uv.y) * uBumpScale;
    float h = fbm(q);

    // surface normal from height gradient -> bump shading
    float eps = 0.015 * uBumpScale;
    float hx = fbm(q + vec2(eps, 0.0)) - fbm(q - vec2(eps, 0.0));
    float hy = fbm(q + vec2(0.0, eps)) - fbm(q - vec2(0.0, eps));
    vec3 n = normalize(vec3(-hx * uBumpHeight * 12.0, -hy * uBumpHeight * 12.0, 1.0));
    vec3 keyDir = normalize(vec3(-0.35, 0.5, 0.78));
    float shade = clamp(dot(n, keyDir), 0.0, 1.0);

    vec3 cloudTint = vec3(0.92, 0.95, 1.0);

    // LED light stays a round spot: it is only attenuated by the *uniform*
    // diffuser opacity. The bumpy surface must NOT multiply/reshape it, or each
    // dot would get a directional gradient and look skewed.
    vec3 transmitted = light * uTransmission;

    // The bumpy cloud is an additive relief layer sitting on top: front-lit
    // ridges, shadowed valleys. This gives the 3D cloud look without distorting
    // the LED spots. Its strength scales with bumpiness.
    float relief = mix(0.12, 1.0, shade);
    float reliefStrength = 0.05 + 0.22 * uBumpHeight;
    vec3 cloudBody = cloudTint * (uAmbient + reliefStrength * relief);

    vec3 col = transmitted + cloudBody;
    col += vec3(0.05, 0.07, 0.13) * uBackground;

    // tone map + gamma
    col = vec3(1.0) - exp(-col * 1.25);
    col = pow(col, vec3(1.0 / 2.2));

    gl_FragColor = vec4(col, 1.0);
  }
`;
