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

  uniform float uAmbient;
  uniform float uBackground;
  uniform vec3  uTint;        // timeline tint (white = neutral)

  uniform int   uViewMode;   // 0 = flat build panel, 1 = lit cloud silhouette

  vec3 ledColor(float c, float r) {
    return texture2D(uLeds, vec2((c + 0.5) / uCols, (r + 0.5) / uRows)).rgb;
  }

  // --- procedural cumulus silhouette (viewed from below) -------------------
  // Overlapping soft lobes form a puffy heap. lobe = vec3(x, y, r): x is a
  // fraction of the panel width (so the heap spans wide clouds), y and r are in
  // height units. The lower lobes make the bulbous underside the LEDs light up.
  const int NLOBES = 9;
  vec3 lobeAt(int i) {
    if (i == 0) return vec3(0.50, 0.50, 0.30);
    if (i == 1) return vec3(0.30, 0.46, 0.24);
    if (i == 2) return vec3(0.70, 0.46, 0.24);
    if (i == 3) return vec3(0.16, 0.44, 0.18);
    if (i == 4) return vec3(0.84, 0.44, 0.18);
    if (i == 5) return vec3(0.40, 0.66, 0.20);
    if (i == 6) return vec3(0.60, 0.68, 0.18);
    if (i == 7) return vec3(0.50, 0.76, 0.16);
    return vec3(0.50, 0.40, 0.22);
  }
  // Metaball field at point a (aspect space, width = A). A soft MAX of gaussian
  // lobes keeps the field bounded in [0,1] (each lobe peaks at 1 at its centre),
  // so a fixed threshold gives a clean, predictable silhouette at any aspect.
  float cloudField(vec2 a, float A) {
    float f = 0.0;
    for (int i = 0; i < NLOBES; i++) {
      vec3 L = lobeAt(i);
      vec2 c = vec2(L.x * A, L.y);
      float r = L.z;
      vec2 d = a - c;
      f = max(f, exp(-dot(d, d) / (2.0 * r * r)));
    }
    return f;
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

    // Sky/room behind the cloud (used in cloud view, and as the panel backdrop).
    vec3 sky = mix(vec3(0.015, 0.018, 0.03), vec3(0.045, 0.055, 0.08), clamp(vUv.y, 0.0, 1.0));

    // Outside the cloud's bounding rect there are no LEDs: in panel view show the
    // plain backdrop so width/height read as a bounded rectangle; in cloud view
    // show the sky (the silhouette lives inside the rect).
    bool inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
    if (!inside) {
      gl_FragColor = vec4(uViewMode == 1 ? sky : vec3(0.015, 0.018, 0.03), 1.0);
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

    // Flat static cloud surface shading (no bumpiness controls).
    float shade = 0.72;

    vec3 cloudTint = vec3(0.92, 0.95, 1.0);

    // LED light stays a round spot: it is only attenuated by the *uniform*
    // diffuser opacity. The bumpy surface must NOT multiply/reshape it, or each
    // dot would get a directional gradient and look skewed.
    vec3 transmitted = light * uTransmission;

    vec3 col;
    if (uViewMode == 1) {
      // === Cloud view: light the underside of a puffy cumulus silhouette. ===
      float A = uCloudAspect;
      vec2 a = vec2(uv.x * A, uv.y);

      vec2 a2 = a;

      // f in [0,1]; the silhouette boundary sits at ~0.5.
      float f = cloudField(a2, A);
      float coverage = smoothstep(0.42, 0.6, f);

      // Form: normal from the field gradient -> rounded, lit-from-front lobes.
      float ce = 0.01;
      float fx = cloudField(a2 + vec2(ce, 0.0), A) - cloudField(a2 - vec2(ce, 0.0), A);
      float fy = cloudField(a2 + vec2(0.0, ce), A) - cloudField(a2 - vec2(0.0, ce), A);
      vec3 cn = normalize(vec3(-fx, -fy, 1.2 * ce));
      vec3 keyC = normalize(vec3(-0.25, 0.55, 0.8));
      float formShade = clamp(dot(cn, keyC) * 0.5 + 0.5, 0.0, 1.0);
      float form = mix(0.35, 1.0, formShade);

      // Fine surface texture (the existing bump relief) confined to the cloud.
      float relief = mix(0.5, 1.0, shade);

      // Thin silhouette edges glow (light leaks through the rim of a lit cloud):
      // a band peaking where the coverage transitions.
      float rim = coverage * (1.0 - coverage) * 4.0;

      // The colored LED light is the emissive content; form shades it into puffs,
      // a soft body fills shadowed areas, and the rim adds the glowing edge.
      vec3 glow = transmitted * (0.55 + 0.45 * form);
      vec3 body = cloudTint * (uAmbient * 1.5 + 0.10 * form * relief);
      vec3 cloudCol = glow + body + transmitted * rim * 0.6;

      // A faint colored halo bleeds just outside the silhouette (and fades to
      // pure sky away from it).
      float halo = smoothstep(0.12, 0.42, f) * (1.0 - coverage);
      col = mix(sky + transmitted * halo * 0.25, cloudCol, coverage);
    } else {
      // === Panel view: the flat, true-to-scale build surface. ===
      // The bumpy cloud is an additive relief layer sitting on top: front-lit
      // ridges, shadowed valleys, without distorting the LED spots.
      float relief = mix(0.12, 1.0, shade);
      float reliefStrength = 0.11;
      vec3 cloudBody = cloudTint * (uAmbient + reliefStrength * relief);
      col = transmitted + cloudBody;
      col += vec3(0.05, 0.07, 0.13) * uBackground;
    }

    // Timeline tint is a coloured-light multiplier over the lit cloud surface:
    // white cloud body * tint = tint colour.
    col *= uTint;

    // tone map + gamma
    col = vec3(1.0) - exp(-col * 1.25);
    col = pow(col, vec3(1.0 / 2.2));

    gl_FragColor = vec4(col, 1.0);
  }
`;
