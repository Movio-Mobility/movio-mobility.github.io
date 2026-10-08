/*
 * GRID studio background
 * ----------------------
 * 1. Simulation  — one WebGL2 transform-feedback pass per frame. A vertex shader reads each
 *                  particle's (position, age, velocity, lifespan, colour) and writes the next state
 *                  into a second buffer: 4D simplex noise forces, gravitational attractors,
 *                  lifespan/respawn and colour shifts all happen there. The CPU only sets uniforms.
 * 2. Particles   — instanced quads. Each particle's depth from a fixed camera gives a thin-lens
 *                  circle of confusion; out-of-focus particles become soft hexagonal bokeh discs.
 *                  Drawn additively into a CSS-resolution light buffer.
 * 3. Studio      — full-screen shader painting the grey cyclorama, compositing the light buffer.
 * 4. Night       : the footer takes the house lights down and puts the field out. See nightGrade().
 *
 * index.html carries a hand-synced copy of this engine inline, because it must paint before
 * anything else loads. The night grade lives in both: `uHouse` in STUDIO_FS, nightGrade(),
 * setNight(), and the five uniform sites that read N instead of S. Change one, change both.
 * sweepX() and its uDriftVel/uDriftEnergy uniforms live here only: the home page never
 * travels sideways, and journey.js feature-detects it. So does setForm(), the drawing the
 * Gen2 order page gathers the field into: it is JavaScript over the pod's existing targets
 * and force, and powerpod-gen2.js feature-detects it. The force's uPodK and uPodNoise are the
 * home copy's, ported as they are (index.html, setFormation), so the two still agree there.
 *
 * Cost. The engine works out how hard to work with assets/perf.js (GridPerf), shared with the
 * pod so the two canvases are always paced together. It draws the composite at CSS resolution
 * (see applySize), compiles its shaders on the driver's threads, builds the road's riders only
 * when the opening will show them, and reads no layout inside a frame. The performance
 * pass in both copies is mirrored too: change one, change both.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const canvas = document.getElementById('bg');
  const headline = document.querySelector('.headline');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const skipIntro = root.classList.contains('skip-intro');
  const perf = window.GridPerf || null;

  const reveal = () => headline.classList.add('is-revealed');
  const fallback = (reason) => {
    if (reason) console.warn('[gridBG] using static background:', reason);
    root.classList.remove('gl', 'gl-live');
    reveal();
  };

  // ---------------------------------------------------------------- tuning
  const TAN_HALF_FOV = Math.tan((25 * Math.PI) / 180); // 50° across the shorter screen side
  const RIBBON_DEPTH = 6.0;
  const SWEEP_DEPTH = 7.0;
  const ATTRACTOR_MASS = [26, 18, 12];
  const RESIDUAL_PULL = 0.12;
  const DRIFT_DENSITY = 0.07; // share of particles left drifting once the shape behind the headline scatters
  const SHEET_DEPTH = 3.2;    // in front of the drift plane: where a dialog panel is built
  // A panel needs more particles than the idle drift, but only while it is open.
  const SHEET_DENSITY = window.matchMedia('(hover: none) and (pointer: coarse)').matches ? 0.13 : 0.2;
  const SCROLL_FOLLOW = 0.6;  // how strongly scrolling sweeps particles (1 = locked to content at the ribbon depth)
  const MIN_QUALITY = 0.6;    // emergency shedding floor (the governor's last resort, see perf.js)
  const MAX_CANVAS_PIXELS = 3.5e6;
  const MAX_PARTICLE_PIXELS = 2.0e6;

  // ---------------------------------------------------------------- GLSL
  const HASH_GLSL = `
    uvec3 pcg3d(uvec3 v) {
      v = v * 1664525u + 1013904223u;
      v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
      v ^= v >> 16u;
      v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
      return v;
    }
    vec3 rand3(uint a, uint b, uint c) {
      return vec3(pcg3d(uvec3(a, b, c))) * (1.0 / 4294967295.0);
    }
  `;

  // 4D simplex noise — Ian McEwan, Stefan Gustavson (Ashima Arts). MIT License.
  // https://github.com/stegu/webgl-noise
  const NOISE_GLSL = `
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    float mod289(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
    float permute(float x) { return mod289(((x * 34.0) + 10.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    float taylorInvSqrt(float r) { return 1.79284291400159 - 0.85373472095314 * r; }

    vec4 grad4(float j, vec4 ip) {
      const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
      vec4 p, s;
      p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
      p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
      s = vec4(lessThan(p, vec4(0.0)));
      p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
      return p;
    }

    float snoise(vec4 v) {
      const vec4 C = vec4(0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958);
      const float F4 = 0.309016994374947451;

      vec4 i  = floor(v + dot(v, vec4(F4)));
      vec4 x0 = v - i + dot(i, C.xxxx);

      vec4 i0;
      vec3 isX = step(x0.yzw, x0.xxx);
      vec3 isYZ = step(x0.zww, x0.yyz);
      i0.x = isX.x + isX.y + isX.z;
      i0.yzw = 1.0 - isX;
      i0.y += isYZ.x + isYZ.y;
      i0.zw += 1.0 - isYZ.xy;
      i0.z += isYZ.z;
      i0.w += 1.0 - isYZ.z;

      vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);
      vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);
      vec4 i3 = clamp(i0, 0.0, 1.0);

      vec4 x1 = x0 - i1 + C.xxxx;
      vec4 x2 = x0 - i2 + C.yyyy;
      vec4 x3 = x0 - i3 + C.zzzz;
      vec4 x4 = x0 + C.wwww;

      i = mod289(i);
      float j0 = permute(permute(permute(permute(i.w) + i.z) + i.y) + i.x);
      vec4 j1 = permute(permute(permute(permute(
                  i.w + vec4(i1.w, i2.w, i3.w, 1.0))
                + i.z + vec4(i1.z, i2.z, i3.z, 1.0))
                + i.y + vec4(i1.y, i2.y, i3.y, 1.0))
                + i.x + vec4(i1.x, i2.x, i3.x, 1.0));

      vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);
      vec4 p0 = grad4(j0,   ip);
      vec4 p1 = grad4(j1.x, ip);
      vec4 p2 = grad4(j1.y, ip);
      vec4 p3 = grad4(j1.z, ip);
      vec4 p4 = grad4(j1.w, ip);

      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;
      p4 *= taylorInvSqrt(dot(p4, p4));

      vec3 m0 = max(0.6 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
      vec2 m1 = max(0.6 - vec2(dot(x3, x3), dot(x4, x4)), 0.0);
      m0 = m0 * m0;
      m1 = m1 * m1;
      return 49.0 * (dot(m0 * m0, vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2)))
                   + dot(m1 * m1, vec2(dot(p3, x3), dot(p4, x4))));
    }
  `;

  // Shared noise flow field; include after NOISE_GLSL.
  const FLOW_GLSL = `
    vec3 noiseGradient(vec4 q) {
      const float e = 0.35;
      float n = snoise(q);
      return vec3(snoise(q + vec4(e, 0.0, 0.0, 0.0)) - n,
                  snoise(q + vec4(0.0, e, 0.0, 0.0)) - n,
                  snoise(q + vec4(0.0, 0.0, e, 0.0)) - n) / e;
    }

    // Wind / water: the cross product of two 4D noise gradients is a divergence-free flow,
    // so particles swirl in continuous currents instead of clumping. Sampled at each
    // particle's exact position, the force changes smoothly as the particle moves.
    vec3 flowField(vec3 p, float t) {
      vec3 q = p * vec3(0.16, 0.24, 0.2);   // stretched on x → long horizontal waves
      float tt = t * 0.045;
      vec3 g1 = noiseGradient(vec4(q, tt));
      vec3 g2 = noiseGradient(vec4(q + vec3(19.1, 7.3, 31.7), tt + 11.0));
      vec3 current = vec3(0.08, 0.05 * sin(p.x * 0.55 + t * 0.35), 0.0);
      return cross(g1, g2) * 0.2 + current;
    }
  `;

  // The wave "road": five layered, travelling sine lanes spread around the focal plane.
  // Needs uniforms uRibbonDepth and uAspect declared by the including shader.
  const LANE_GLSL = `
    float laneDepth(float band) { return uRibbonDepth + (band - 2.0) * 0.55; }

    // Vertical lane scale; kept compact on tall portrait screens.
    float laneScale(float hh) { return hh * sqrt(min(uAspect, 1.0)); }

    float laneY(float band, float x, float t, float hw, float vs) {
      float k = 3.9269908 / hw;              // ≈ 1.25 wavelengths across the screen
      float phase = k * x + t * 0.55 + band * 0.45;
      return (band - 2.0) * 0.13 * vs
           + 0.075 * vs * sin(phase)
           + 0.02 * vs * sin(2.3 * phase - t * 0.3);
    }

    float laneSlope(float band, float x, float t, float hw, float vs) {
      float k = 3.9269908 / hw;
      float phase = k * x + t * 0.55 + band * 0.45;
      return 0.075 * vs * k * cos(phase) + 0.046 * vs * k * cos(2.3 * phase - t * 0.3);
    }
  `;

  // ---- 1. simulation (transform feedback, rasterizer discarded) ----
  const UPDATE_VS = `#version 300 es
    precision highp float;
    precision highp int;

    layout(location = 0) in vec4 aPosAge;   // xyz position, w age
    layout(location = 1) in vec4 aVelLife;  // xyz velocity, w lifespan
    layout(location = 2) in vec4 aColor;    // rgb colour, a opacity

    out vec4 vPosAge;
    out vec4 vVelLife;
    out vec4 vColor;

    uniform float uTime;
    uniform float uDt;
    uniform uint  uFrame;
    uniform float uAspect;
    uniform float uTanHalfY;
    uniform float uSweep;        // weight of the sweeping point attractors
    uniform float uRibbon;       // weight of the wave-ribbon formation
    uniform float uRibbonDepth;
    uniform float uPrewarm;      // 1 on the first pass: stagger ages so lifespans don't expire together
    uniform vec4  uAttr[3];      // xyz position, w mass
    uniform float uDensity;      // fraction of particles kept visible (the rest fade out)
    uniform float uCount;        // particle capacity
    uniform float uScrollVel;    // world-space velocity the page scroll sweeps particles toward
    uniform float uScrollEnergy; // decaying peak of uScrollVel, lets coasting particles keep their speed
    uniform float uDriftVel;     // the horizontal twin of uScrollVel, fed by sweepX (journey's tape)
    uniform float uDriftEnergy;  // decaying peak of uDriftVel
    uniform float uPod;          // weight of the PowerPod silhouette formation
    uniform sampler2D uPodTargets;
    uniform vec2  uPodTexSize;
    uniform float uPodK;         // how hard a formation holds its points: 22 lets a drawing breathe
    uniform float uPodNoise;     // how much of the drift still moves a point held in a formation
    uniform float uHalo;         // weight of the optional store-card rim (does not use uPod)
    uniform vec4  uHaloRect;     // xy center, zw half-extents, world units at uHaloDepth
    uniform float uHaloRadius;   // corner radius, world units
    uniform float uHaloDepth;
    uniform float uHaloFill;     // 0 = hover around the outline, 1 = fill the rect as a panel
    uniform float uHaloGrip;     // 0 = the calm idle rim, 1 = a firm, fast gather

    ${HASH_GLSL}
    ${NOISE_GLSL}
    ${FLOW_GLSL}
    ${LANE_GLSL}

    // Plummer-softened gravity plus a swirl around the view axis, so particles arc
    // behind the attractors as they travel across the screen.
    vec3 sweepForce(vec3 p, vec3 v) {
      vec3 a = vec3(0.0);
      for (int i = 0; i < 3; i++) {
        vec3 d = uAttr[i].xyz - p;
        float r2 = dot(d, d) + 2.4;
        float g = uAttr[i].w * inversesqrt(r2 * r2 * r2);
        a += d * g;
        a += vec3(-d.y, d.x, 0.0) * g * 0.8;
      }
      return a - v * 0.8;
    }

    // Each particle belongs to one of the five lanes, spread along it with a little thickness.
    vec3 ribbonTarget(vec3 h, float t) {
      float band = floor(h.x * 5.0);
      float depth = laneDepth(band);
      float hh = depth * uTanHalfY;
      float hw = hh * uAspect;
      float vs = laneScale(hh);
      float x = (h.y * 2.0 - 1.0) * hw * 1.15;
      float y = laneY(band, x, t, hw, vs) + (h.z - 0.5) * 0.018 * vs;
      float z = -depth + (fract(h.z * 17.0) - 0.5) * 0.3;
      return vec3(x, y, z);
    }

    vec3 podTarget(uint id) {
      ivec2 size = ivec2(max(uPodTexSize, vec2(1.0)));
      int i = int(id);
      ivec2 px = ivec2(i % size.x, i / size.x);
      return texelFetch(uPodTargets, px, 0).xyz;
    }

    // Closest point on a rounded-rect outline — nearby sparks collect on the rim
    // instead of snapping to a pre-assigned slot.
    vec2 closestOnRoundRect(vec2 p, vec2 c, vec2 he, float rad) {
      vec2 q = p - c;
      vec2 sgn = vec2(q.x >= 0.0 ? 1.0 : -1.0, q.y >= 0.0 ? 1.0 : -1.0);
      vec2 aq = abs(q);
      float r = clamp(rad, 0.0, min(he.x, he.y) - 0.001);
      vec2 inner = max(he - vec2(r), vec2(1e-4));
      vec2 d = aq - inner;
      vec2 local;
      if (d.x > 0.0 && d.y > 0.0) {
        local = inner + normalize(max(d, vec2(1e-6))) * r;
      } else if (d.x > d.y) {
        local = vec2(he.x, clamp(aq.y, 0.0, inner.y));
      } else {
        local = vec2(clamp(aq.x, 0.0, inner.x), he.y);
      }
      return c + local * sgn;
    }

    vec2 pointOnRoundRect(float s, vec2 he, float rad) {
      float r = clamp(rad, 0.0, min(he.x, he.y) - 0.001);
      vec2 inner = max(he - vec2(r), vec2(1e-4));
      float Lh = inner.x * 2.0;
      float Lv = inner.y * 2.0;
      float Lc = 1.57079637 * r;
      float tot = max(2.0 * Lh + 2.0 * Lv + 4.0 * Lc, 1e-4);
      float d = fract(s) * tot;
      if (d < Lh) return vec2(-inner.x + d, he.y);
      d -= Lh;
      if (d < Lc) {
        float a = d / max(r, 1e-4);
        return vec2(inner.x + sin(a) * r, inner.y + cos(a) * r);
      }
      d -= Lc;
      if (d < Lv) return vec2(he.x, inner.y - d);
      d -= Lv;
      if (d < Lc) {
        float a = d / max(r, 1e-4);
        return vec2(inner.x + cos(a) * r, -inner.y - sin(a) * r);
      }
      d -= Lc;
      if (d < Lh) return vec2(inner.x - d, -he.y);
      d -= Lh;
      if (d < Lc) {
        float a = d / max(r, 1e-4);
        return vec2(-inner.x - sin(a) * r, -inner.y - cos(a) * r);
      }
      d -= Lc;
      if (d < Lv) return vec2(-he.x, -inner.y + d);
      d -= Lv;
      float a = d / max(r, 1e-4);
      return vec2(-inner.x - cos(a) * r, inner.y + sin(a) * r);
    }

    vec3 haloTarget(vec3 p, vec3 h, vec3 h2, float t) {
      vec2 c = uHaloRect.xy;
      vec2 he = uHaloRect.zw * 1.018;
      vec2 closest = closestOnRoundRect(p.xy, c, he, uHaloRadius);
      vec2 home = c + pointOnRoundRect(fract(h2.x + t * mix(0.004, 0.010, h2.y)), he, uHaloRadius);
      vec2 rim = mix(closest, home, 0.36);
      vec2 outward = rim - c;
      float olen = max(length(outward), 1e-4);
      // Idle: a wide band and a spread of depths, a loose cloud rather than a traced outline.
      // Gripping draws that band in, so a panel gets a clean edge of light.
      rim += (outward / olen) * ((h.y - 0.5) * mix(0.14, 0.05, uHaloGrip));

      // Filling: a stable point inside the rect, drifting slowly, so the field can
      // stand in for a panel instead of only its edge.
      vec2 jitter = vec2(sin(t * 0.21 + h2.z * 31.4), cos(t * 0.17 + h2.x * 27.7)) * 0.012;
      vec2 inside = c + (h2.xy - 0.5) * 2.0 * (he * 0.94) + jitter;
      vec2 target = mix(rim, inside, uHaloFill);

      // The panel forms flat; the idle rim keeps its depth spread.
      return vec3(target, -uHaloDepth + (h2.z - 0.5) * mix(0.3, 0.06, uHaloGrip));
    }

    void main() {
      uint id = uint(gl_VertexID);
      vec3 h  = rand3(id, 0x5bd1u, 0x2e9fu);   // stable per-particle traits
      vec3 h2 = rand3(id, 0x68e3u, 0x1b87u);

      vec3 p = aPosAge.xyz;
      float age = aPosAge.w;
      vec3 v = aVelLife.xyz;
      float life = aVelLife.w;
      float dt = uDt;

      // How strongly the attractors override the noise field for this particle.
      // A per-particle lag staggers who joins the formation first.
      float W = clamp(uSweep + uRibbon + uPod, 0.0, 1.0);
      float lag = h.x * 0.5;
      float w = smoothstep(lag, lag + 0.5, W);

      vec3 aNoise = flowField(p, uTime);
      vec3 a = aNoise;
      if (w > 0.0005) {
        float total = max(uSweep + uRibbon + uPod, 1e-4);
        vec3 aAttr = vec3(0.0);
        if (uSweep > 0.0005) aAttr += sweepForce(p, v) * (uSweep / total);
        if (uRibbon > 0.0005) aAttr += ((ribbonTarget(h2, uTime) - p) * 5.5 - v * 4.7) * (uRibbon / total);
        if (uPod > 0.0005) aAttr += ((podTarget(id) - p) * uPodK - v * (1.8 * sqrt(uPodK))) * (uPod / total);
        a = mix(aNoise, aAttr + aNoise * mix(0.3, uPodNoise, min(uPod * 4.0, 1.0)), w);
      }

      // Optional rim: a few of the brighter sparks already drifting near one card
      // hover around it. The pull is short-range and softly damped, so the rest of
      // the field keeps floating on the noise. Independent of uPod so scroll-follow
      // is not damped.
      float haloW = 0.0;
      if (uHalo > 0.0005) {
        // Gripping widens who takes part: at rest only the brighter sparks, at full
        // grip the whole field, so a panel can be built out of it.
        float join = mix(smoothstep(0.6, 0.9, h.z), smoothstep(0.02, 0.3, h.z), uHaloGrip);
        float lagH = h.x * mix(0.4, 0.16, uHaloGrip);
        haloW = join * smoothstep(lagH, lagH + 0.4, uHalo);
        vec3 ht = haloTarget(p, h, h2, uTime);
        float dist = length(p - ht);
        float capture = exp(-dist * mix(0.9, 0.28, uHaloGrip));
        float pull = haloW * mix(mix(0.03, 0.6, capture), mix(0.5, 1.0, capture), uHaloGrip);
        // Roughly critically damped at both ends: it settles instead of snapping.
        // The idle rim is a whisper; a gathered panel needs a far stiffer spring, or the
        // noise field and the drag simply hold the particles where they are.
        float spring = mix(mix(1.2, 3.2, capture), 22.0, uHaloGrip);
        float damp = mix(mix(1.8, 3.4, capture), 8.5, uHaloGrip);
        vec3 aHalo = (ht - p) * spring - v * damp;
        a = mix(a, aHalo + aNoise * mix(mix(0.9, 0.65, capture), 0.25, uHaloGrip), pull);
      }

      // Gently steer drifting particles back into the view frustum
      // (each axis eases off while something is sweeping the field along it).
      float d = -p.z;
      float hh = max(d, 0.5) * uTanHalfY;
      float hw = hh * uAspect;
      vec3 over = vec3(sign(p.x) * max(abs(p.x) - hw * 1.08, 0.0) * (1.0 - min(uDriftEnergy * 0.5, 1.0)),
                       sign(p.y) * max(abs(p.y) - hh * 1.08, 0.0) * (1.0 - min(uScrollEnergy * 0.5, 1.0)),
                       max(1.6 - d, 0.0) - max(d - 17.0, 0.0));
      a -= over * 0.8 * (1.0 - w);

      // Scroll inertia: while the page scrolls, particles are swept along with the content
      // (lighter ones respond more; perspective makes near ones travel further on screen).
      // The sweep only ever pushes, never brakes, so when scrolling stops they coast to
      // rest on their own momentum and the noise field takes over again.
      float follow = uScrollVel * mix(1.3, 0.7, fract(h.x * 7.31));
      float lagV = follow - v.y;
      if (follow * lagV > 0.0) a.y += lagV * 4.0;

      // The same inertia sideways, for a page that travels horizontally (the journey's
      // timeline tape). A different per-particle weight, so the two axes don't share a mass.
      float followX = uDriftVel * mix(1.3, 0.7, fract(h.y * 5.17));
      float lagX = followX - v.x;
      if (followX * lagX > 0.0) a.x += lagX * 4.0;

      // Drag rises with speed, like moving through water: a scroll flick glides a short
      // distance and eases into the slow drift instead of flying across the screen.
      float drag = mix(mix(0.55, 2.4, smoothstep(0.6, 2.5, length(v))), 0.15, w);
      // Gathering onto a panel needs to travel: the idle rim keeps the water-like drag.
      drag = mix(drag, 0.3, haloW * uHaloGrip);
      v += a * dt;
      v *= exp(-drag * dt);
      float maxSpeed = mix(1.0, mix(7.0, 14.0, uPod) * clamp(uPodK / 40.0, 1.0, 4.0), w) + (uScrollEnergy + uDriftEnergy) * 1.3;
      maxSpeed += haloW * uHaloGrip * 4.0; // the drift cap of 1.0 is far too slow to cross the frustum
      float speed = length(v);
      if (speed > maxSpeed) v *= maxSpeed / speed;
      p += v * dt;

      // Particles carried off the top or bottom re-enter from the other side, out of view.
      float wrapH = max(-p.z, 0.5) * uTanHalfY * 1.3;
      if (p.y > wrapH) p.y -= 2.0 * wrapH;
      else if (p.y < -wrapH) p.y += 2.0 * wrapH;
      // Sideways only while a horizontal sweep is running, so a long one carries the field
      // around instead of emptying the screen. At rest the sides behave as they always have.
      if (uDriftEnergy > 0.01) {
        float wrapW = wrapH * uAspect;
        if (p.x > wrapW) p.x -= 2.0 * wrapW;
        else if (p.x < -wrapW) p.x += 2.0 * wrapW;
      }

      // Lifespans nearly pause while held in a formation so shapes don't pop apart.
      // Lifespans nearly pause for a held panel, so it doesn't dissolve while it is read.
      float hold = mix(0.3 * pow(h.z, 6.0), 0.85, uHaloGrip);
      age += dt * (1.0 - 0.9 * w - hold * haloW);

      d = -p.z;
      hh = max(d, 0.5) * uTanHalfY;
      hw = hh * uAspect;
      bool outside = d < 1.0 || d > 24.0 || abs(p.x) > hw * 1.9 + 1.0 || abs(p.y) > hh * 1.9 + 1.0;
      bool dead = age >= life || outside;

      if (dead) {
        vec3 r  = rand3(id, uFrame, 0x9e37u);
        vec3 r2 = rand3(id, uFrame ^ 0xa511u, 0x85ebu);
        float nd = mix(1.6, 16.0, pow(r.z, 0.75));
        float nhh = nd * uTanHalfY;
        p = vec3((r.x * 2.0 - 1.0) * nhh * uAspect * 1.05, (r.y * 2.0 - 1.0) * nhh * 1.05, -nd);
        v = (r2 - 0.5) * 0.1;
        life = mix(7.0, 15.0, r2.x);
        age = uPrewarm * r2.y * life * 0.7;
      }

      // Colour: warm white, drifting toward sage with speed, toward warm grey with age,
      // brightening while part of a formation. Alpha carries brightness × lifespan envelope:
      // most particles are faint dust, a few are bright light sources (HDR, above 1).
      float lt = clamp(age / max(life, 1e-3), 0.0, 1.0);
      float envelope = smoothstep(0.0, 0.15, lt) * (1.0 - smoothstep(0.8, 1.0, lt));
      float sage = clamp(h.y * 0.14 + length(v) * 0.08 + w * 0.06, 0.0, 0.3);
      vec3 target = mix(vec3(1.0, 0.975, 0.94), vec3(0.70, 0.79, 0.60), sage);
      target = mix(target, vec3(0.86, 0.82, 0.77), smoothstep(0.55, 1.0, lt) * 0.4);
      target *= 0.85 + 0.3 * w;
      vec3 rgb = dead ? target : mix(aColor.rgb, target, 1.0 - exp(-dt * 3.0));
      float brightness = (0.05 + 3.0 * pow(h.z, 9.0)) * (1.0 + 0.5 * w) * (1.0 + mix(0.8, 2.4, uHaloGrip) * haloW * pow(h.z, 3.2));
      float kept = 1.0 - smoothstep(uDensity, uDensity + 0.1, (float(gl_VertexID) + 0.5) / uCount);

      vPosAge = vec4(p, age);
      vVelLife = vec4(v, life);
      vColor = vec4(rgb, envelope * brightness * kept);
    }
  `;

  const UPDATE_FS = `#version 300 es
    precision mediump float;
    out vec4 outColor;
    void main() { outColor = vec4(0.0); }
  `;

  // ---- 1b. traffic simulation: fine particles holding the shape of scooters and e-bikes ----
  const VEHICLE_VS = `#version 300 es
    precision highp float;
    precision highp int;

    layout(location = 0) in vec4 aPosAge;    // xyz position
    layout(location = 1) in vec4 aVelLife;   // xyz velocity, w 1 once placed
    layout(location = 2) in vec4 aColor;     // rgb colour, a opacity
    layout(location = 3) in vec4 aShape;     // xy point on the vehicle, zw wheel hub (vehicle units)
    layout(location = 4) in vec2 aShapeInfo; // x vehicle slot, y wheel radius (0 = body)

    out vec4 vPosAge;
    out vec4 vVelLife;
    out vec4 vColor;

    uniform float uTime;
    uniform float uDt;
    uniform float uAspect;
    uniform float uTanHalfY;
    uniform float uRibbonDepth;
    uniform vec4  uVehLane[6];    // x strand ridden on, y position along the road (× half-width), z direction ±1, w size (× lane scale)
    uniform vec4  uVehMotion[6];  // x position change per second, y materialise weight 0→1
    uniform float uTraffic;       // scatter weight 0→1, shared with the road's release
    uniform float uScrollVel;
    uniform float uScrollEnergy;

    ${HASH_GLSL}
    ${NOISE_GLSL}
    ${FLOW_GLSL}
    ${LANE_GLSL}

    // World position of this particle's point on figure slot i at road position u, time t.
    // The figure drives on top of one strand of the road: both wheels sit on the strand's
    // wave, so it rises, dips and tilts as the wave rolls beneath it. It faces its direction
    // of travel and its wheels roll with the distance travelled.
    vec3 vehiclePoint(int i, float u, float t) {
      const float REAR = 0.2;   // wheel centres along the figure (figure units)
      const float FRONT = 0.81;
      vec4 lane = uVehLane[i];
      float strand = lane.x;
      float dir = lane.z;
      float depth = laneDepth(strand);
      float hh = depth * uTanHalfY;
      float hw = hh * uAspect;
      float vs = laneScale(hh);
      float size = lane.w * vs;
      float x = u * hw;

      vec2 local = aShape.xy;
      if (aShapeInfo.y > 0.0) {
        float angle = -dir * x / (aShapeInfo.y * size);
        float c = cos(angle);
        float s = sin(angle);
        vec2 d = local - aShape.zw;
        local = aShape.zw + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
      }

      // Where each wheel touches the strand, then the figure's travel and up directions.
      float rearX = x + (REAR - 0.5) * dir * size;
      float frontX = x + (FRONT - 0.5) * dir * size;
      vec2 rear = vec2(rearX, laneY(strand, rearX, t, hw, vs));
      vec2 front = vec2(frontX, laneY(strand, frontX, t, hw, vs));
      vec2 along = normalize(front - rear);
      vec2 up = vec2(-along.y, along.x) * dir;

      vec2 world = rear + along * (local.x - REAR) * size + up * (local.y * size + 0.012 * vs);
      return vec3(world, -depth);
    }

    void main() {
      uint id = uint(gl_VertexID);
      vec3 h = rand3(id, 0x3c6eu, 0x9b05u);
      int slot = int(aShapeInfo.x + 0.5);
      vec4 lane = uVehLane[slot];
      vec4 motion = uVehMotion[slot];
      float dt = uDt;

      vec3 target = vehiclePoint(slot, lane.y, uTime);
      vec3 before = vehiclePoint(slot, lane.y - motion.x * dt, uTime - dt);
      vec3 targetVel = dt > 0.0 ? (target - before) / dt : vec3(0.0);

      // Staggered per particle: materialise out of a shimmer, later scatter with the road.
      float lag = h.x * 0.55;
      float formed = smoothstep(lag, lag + 0.45, motion.y);
      float releaseLag = h.y * 0.35;
      float released = smoothstep(releaseLag, releaseLag + 0.45, uTraffic);
      float hold = formed * (1.0 - released);

      vec3 p = aPosAge.xyz;
      vec3 v = aVelLife.xyz;
      float placed = aVelLife.w;

      if (placed < 0.5 || (formed <= 0.0 && released <= 0.0)) {
        // Waiting its turn: parked, invisible, in a loose cloud riding along with the vehicle.
        float vs = laneScale(laneDepth(lane.x) * uTanHalfY);
        p = target + (rand3(id, 0x51f1u, 0x0badu) - 0.5) * vec3(1.4, 1.0, 0.8) * lane.w * vs;
        v = targetVel;
        placed = 1.0;
      } else {
        vec3 aNoise = flowField(p, uTime);
        // Critically damped spring onto the moving shape, matching its velocity so it never trails.
        vec3 aHold = (target - p) * 38.0 + (targetVel - v) * 12.3;
        vec3 a = mix(aNoise, aHold + aNoise * 0.15, hold);

        float follow = uScrollVel * mix(1.3, 0.7, h.z);
        float lagV = follow - v.y;
        if (follow * lagV > 0.0) a.y += lagV * 4.0;

        float drag = mix(0.55, 2.4, smoothstep(0.6, 2.5, length(v))) * (1.0 - hold);
        v += a * dt;
        v *= exp(-drag * dt);
        float maxSpeed = mix(1.0, 12.0, hold) + uScrollEnergy * 1.3;
        float speed = length(v);
        if (speed > maxSpeed) v *= maxSpeed / speed;
        p += v * dt;
      }

      float visible = formed * (1.0 - smoothstep(releaseLag + 0.2, 1.0, uTraffic));
      float sage = clamp(h.y * 0.14 + length(v) * 0.05, 0.0, 0.3);
      vec3 rgb = mix(vec3(1.0, 0.975, 0.94), vec3(0.70, 0.79, 0.60), sage);

      vPosAge = vec4(p, 0.0);
      vVelLife = vec4(v, placed);
      // Faint and translucent: an easter egg for whoever lingers, not a headline act.
      vColor = vec4(rgb, visible * (0.26 + 0.1 * h.z));
    }
  `;

  // ---- 2. bokeh particles ----
  const PARTICLE_VS = `#version 300 es
    precision highp float;

    layout(location = 0) in vec2 aCorner;
    layout(location = 1) in vec4 iPosAge;
    layout(location = 2) in vec4 iColor;

    uniform vec2 uRes;
    uniform float uAspect;
    uniform float uTanHalfY;
    uniform float uFocus;      // focal plane distance
    uniform float uAperture;   // lens aperture scale (larger = shallower depth of field)
    uniform float uCore;       // in-focus glow radius, world units
    uniform float uMinCore;    // smallest glow radius, px
    uniform float uFloor;      // minimum intensity of large discs

    out vec2 vUv;
    out float vRadius;
    out float vCore;
    out float vDefocus;
    out vec3 vLight;

    void main() {
      vUv = vec2(0.0); vRadius = 1.0; vCore = 1.0; vDefocus = 0.0; vLight = vec3(0.0);
      float d = -iPosAge.z;
      if (d < 0.5 || iColor.a < 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

      float minDim = min(uRes.x, uRes.y);
      float halfH = d * uTanHalfY;
      vec2 ndc = iPosAge.xy / vec2(halfH * uAspect, halfH);
      float pxPerUnit = 0.5 * uRes.y / halfH;

      // Thin-lens circle of confusion: grows with distance from the focal plane.
      float core = max(uCore * pxPerUnit, uMinCore);
      float coc = uAperture * minDim * abs(d - uFocus) / (d * uFocus);
      float radius = clamp(max(core, coc), uMinCore, 0.07 * minDim);

      // Spread the same light over a larger disc (softened, with a floor so discs stay visible).
      float intensity = max(pow(core / radius, 1.7), uFloor);
      float defocus = smoothstep(2.0, 5.0, radius);
      // In focus, compress the brightness range: faint dust still sparkles, bright sources don't blow out.
      float brightness = mix(0.75 * sqrt(iColor.a), iColor.a, defocus);

      float halfSize = max(radius + 1.5, core * 3.0);
      gl_Position = vec4(ndc + aCorner * halfSize * 2.0 / uRes, 0.0, 1.0);
      vUv = aCorner * halfSize;
      vRadius = radius;
      vCore = core;
      vDefocus = defocus;
      vLight = iColor.rgb * brightness * intensity;
    }
  `;

  const PARTICLE_FS = `#version 300 es
    precision highp float;

    in vec2 vUv;
    in float vRadius;
    in float vCore;
    in float vDefocus;
    in vec3 vLight;
    out vec4 outColor;

    float sdHexagon(vec2 p, float r) {
      const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
      p = abs(p);
      p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
      p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
      return length(p) * sign(p.y);
    }

    void main() {
      float r = length(vUv);

      // In focus: a tiny soft glow instead of a hard pixel. A fully defocused disc has none of
      // it (mix() below would multiply it by exactly zero), so it is not worked out.
      float glow = vDefocus < 1.0 ? exp(-(r * r) / (vCore * vCore)) : 0.0;

      // Defocused: aperture-shaped disc (70% circle, 30% six-blade hexagon) with a brighter rim.
      // Skipped while a particle is fully in focus, where it would be weighted by zero.
      float bokeh = 0.0;
      if (vDefocus > 0.0) {
        vec2 q = mat2(0.9659, -0.2588, 0.2588, 0.9659) * vUv;
        float sd = mix(r - vRadius, sdHexagon(q, vRadius * 0.94), 0.3);
        float edge = 0.9 + vRadius * 0.06;
        // Outside the aperture a fully defocused disc adds exactly nothing: leave the pixel be
        // rather than blend a zero into it.
        if (vDefocus >= 1.0 && sd >= edge) discard;
        float disc = 1.0 - smoothstep(-edge, edge, sd);
        float rim = smoothstep(-vRadius * 0.5, 0.0, sd) * disc;
        bokeh = disc * 0.78 + rim * 0.32;
      }

      outColor = vec4(vLight * mix(glow, bokeh, vDefocus), 1.0);
    }
  `;

  // ---- 3. studio backdrop + composite ----
  const FULLSCREEN_VS = `#version 300 es
    void main() {
      vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }
  `;

  const STUDIO_FS = `#version 300 es
    precision highp float;
    precision highp int;

    uniform vec2 uRes;
    uniform vec2 uDrift;         // the lights' slow wander, worked out once a frame on the CPU
    uniform float uExposure;
    uniform float uParticleGain;
    uniform float uHouse;        // house lights over the cyclorama only: 1 = studio lit, 0 = dark stage
    uniform uint uFrame;
    uniform sampler2D uParticles;
    uniform sampler2D uDetail;   // full-resolution light from the fine traffic particles
    out vec4 outColor;

    ${HASH_GLSL}

    float sq(float x) { return x * x; }

    // Grey cyclorama: darker wall top-left, key light above the horizon, bright horizon band
    // strongest on the right, lighter floor with a light pool at the left edge.
    float studio(vec2 fragCoord) {
      float minDim = min(uRes.x, uRes.y);
      float aspect = uRes.x / uRes.y;
      vec2 c = (fragCoord - 0.5 * uRes) / minDim;
      c.y = -c.y;
      float portrait = clamp((1.0 - aspect) / 0.55, 0.0, 1.0);

      vec2 drift = uDrift;
      float horizon = mix(-0.12, -0.17, portrait) + drift.y * 0.5;
      float by = c.y - horizon;
      float leftEdge = -0.5 * max(aspect, 1.0);

      float wall = 0.635 + 0.11 * smoothstep(-0.65, 0.65, c.x) + 0.11 * smoothstep(-0.7, horizon, c.y);

      float floorV = 0.80 + 0.045 * smoothstep(0.0, 0.7, by);
      floorV -= 0.045 * exp(-(sq((c.x - leftEdge - 0.25) / 0.35) + sq((by - 0.16) / 0.08)));
      floorV += 0.11 * exp(-(sq((c.x - leftEdge) / 0.07) + sq((by - 0.42) / 0.10)));
      floorV -= 0.03 * exp(-(sq(c.x / 0.35) + sq((by - 0.62) / 0.2)));

      float v = mix(wall, floorV, smoothstep(-0.012, 0.03, by));

      vec2 hp = c - vec2(-0.14 + drift.x, horizon - 0.085);
      hp.x *= 0.75;
      float h2 = dot(hp, hp);
      v += 0.10 * exp(-h2 / 0.012) + 0.035 * exp(-h2 / 0.09);

      v += exp(-sq(by - 0.045) / 0.0035) * (0.05 + 0.13 * smoothstep(-0.35, 0.55, c.x));

      v -= 0.05 * smoothstep(0.45, 1.1, length(c * vec2(0.85, 1.0)));
      return v;
    }

    void main() {
      vec3 base = vec3(studio(gl_FragCoord.xy)) * vec3(1.0, 0.996, 0.988);
      // The house dims before the light buffer is added, so taking the lights down leaves
      // the particles at full strength: the dust becomes the only light source in the room.
      vec3 lin = pow(max(base, 0.0), vec3(2.2)) * uHouse;
      vec2 uv = gl_FragCoord.xy / uRes;
      lin += (texture(uParticles, uv).rgb + texture(uDetail, uv).rgb) * uParticleGain;
      lin *= uExposure;

      // Soft shoulder so dense light rolls off instead of clipping.
      vec3 over = max(lin - 0.8, 0.0);
      lin = min(lin, 0.8) + 0.2 * (1.0 - exp(-over / 0.2));
      vec3 col = pow(lin, vec3(1.0 / 2.2));

      // Triangular dither: keeps the soft gradients free of banding.
      vec3 n = rand3(uint(gl_FragCoord.x), uint(gl_FragCoord.y), uFrame);
      col += (n.x + n.y - 1.0) * (1.5 / 255.0);
      outColor = vec4(col, 1.0);
    }
  `;

  // ---------------------------------------------------------------- WebGL setup
  // A software-only context (no GPU acceleration, or a blocklisted driver) would draw this a
  // few frames a second and hold the whole page up doing it. Those machines get the CSS studio.
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) {
    fallback('WebGL2 unavailable or software-only');
    return;
  }
  if (perf) perf.classify(gl);

  // Shaders compile on the driver's own threads where the browser allows it: every program is
  // started at once and only checked when it is needed, so nothing stands still waiting on the
  // compiler. Without the extension, checking is what waits.
  const parallel = gl.getExtension('KHR_parallel_shader_compile');

  function createProgram(vs, fs, varyings) {
    const program = gl.createProgram();
    const shaders = [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].map(([type, source]) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      return shader;
    });
    if (varyings) gl.transformFeedbackVaryings(program, varyings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    return { program, shaders, uniforms: null };
  }

  // Whether the driver has finished with a program. Never waits.
  const programDone = (p) => !!p.uniforms || !parallel
    || !!gl.getProgramParameter(p.program, parallel.COMPLETION_STATUS_KHR);

  // Checks the link and reads the uniform table. This waits for the compiler, so it is called
  // once programDone() says so, or where waiting is the right thing to do.
  function finishProgram(p) {
    if (p.uniforms) return p;
    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(p.shaders.map((shader) => gl.getShaderInfoLog(shader))
        .concat(gl.getProgramInfoLog(p.program)).filter(Boolean).join('\n'));
    }
    const uniforms = {};
    const count = gl.getProgramParameter(p.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const { name } = gl.getActiveUniform(p.program, i);
      uniforms[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p.program, name);
    }
    p.uniforms = uniforms;
    return p;
  }

  const STRIDE = 48;       // 3 × vec4 per particle
  const SHAPE_STRIDE = 24; // vec4 + vec2 per traffic particle

  // A ping-pong pair of particle state buffers with their update and draw vertex arrays.
  // `shape` (optional) is a static per-particle buffer bound at attribute locations 3–4.
  function createPool(count, initial, quad, shape) {
    const state = [0, 1].map(() => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, initial, gl.DYNAMIC_COPY);
      return buffer;
    });

    let shapeBuffer = null;
    if (shape) {
      shapeBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, shapeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, shape, gl.STATIC_DRAW);
    }

    const updateVao = state.map((buffer) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (let i = 0; i < 3; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, 4, gl.FLOAT, false, STRIDE, i * 16);
      }
      if (shapeBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, shapeBuffer);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.FLOAT, false, SHAPE_STRIDE, 0);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 2, gl.FLOAT, false, SHAPE_STRIDE, 16);
      }
      return vao;
    });

    const drawVao = state.map((buffer) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, 32);
      gl.vertexAttribDivisor(2, 1);
      return vao;
    });

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { count, state, updateVao, drawVao, read: 0 };
  }

  // `wait`: check the programs before returning, as the engine always used to. A page that
  // opens on a lit studio needs its first frame straight away; the home page opens on a dark
  // stage and lets the compiler finish in the background instead (see gpuReady()).
  function createGPU(capacity, wait) {
    const update = createProgram(UPDATE_VS, UPDATE_FS, ['vPosAge', 'vVelLife', 'vColor']);
    const particles = createProgram(PARTICLE_VS, PARTICLE_FS);
    const studio = createProgram(FULLSCREEN_VS, STUDIO_FS);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    // Age 1 > lifespan 0: every particle is (re)born by the GPU on the first pass.
    const initial = new Float32Array(capacity * 12);
    for (let i = 0; i < capacity; i++) initial[i * 12 + 3] = 1;
    const road = createPool(capacity, initial, quad, null);

    // The riders are built later, and only where the opening will show them (prepareTraffic).
    const vehicles = null;
    const traffic = null;

    const fullscreenVao = gl.createVertexArray();
    const halfFloat = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));

    const detail = { texture: gl.createTexture(), fbo: gl.createFramebuffer(), width: 0, height: 0, halfFloat };
    sizeLightBuffer(detail, 1, 1);

    const podSize = Math.max(1, Math.ceil(Math.sqrt(capacity)));
    const podTargets = { texture: gl.createTexture(), width: podSize, height: podSize, ready: false };
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    gl.bindTexture(gl.TEXTURE_2D, podTargets.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, podSize, podSize, 0, gl.RGBA, gl.FLOAT, new Float32Array(podSize * podSize * 4));
    gl.bindTexture(gl.TEXTURE_2D, null);

    const g = {
      update, vehicles, particles, studio,
      road, traffic, fullscreenVao, quad,
      feedback: gl.createTransformFeedback(),
      light: { texture: gl.createTexture(), fbo: gl.createFramebuffer(), width: 0, height: 0, halfFloat },
      detail, // canvas-resolution light for the traffic, 1×1 while unused
      podTargets,
      prewarm: true,
      ready: false,
    };
    if (wait) {
      [update, particles, studio].forEach(finishProgram);
      g.ready = true;
    }
    return g;
  }

  // Ready to draw once every program is compiled and checked. Never waits on the compiler.
  function gpuReady(g) {
    if (g.ready) return true;
    const programs = [g.update, g.particles, g.studio];
    if (!programs.every(programDone)) return false;
    programs.forEach(finishProgram);
    g.ready = true;
    return true;
  }

  // The riders on the opening's road. Only the home page's opening shows them, from about
  // eleven seconds in and only to a reader who has not scrolled yet, so they are built a few
  // seconds ahead at an idle moment rather than with everything else at load.
  function prepareTraffic(g) {
    if (g.vehicles || !roster.length) return;
    g.vehicles = createProgram(VEHICLE_VS, UPDATE_FS, ['vPosAge', 'vVelLife', 'vColor']);
    const count = roster.length * POINTS_PER_VEHICLE;
    g.traffic = createPool(count, new Float32Array(count * 12), g.quad, buildTrafficShapes());
    // Without parallel compiling, checking is what waits, so do that here in idle time and not
    // on the frame the first rider appears.
    if (!parallel) trafficReady(g);
  }

  function trafficReady(g) {
    if (!g.traffic) return false;
    if (g.vehicles.uniforms) return true;
    if (!programDone(g.vehicles)) return false;
    try {
      finishProgram(g.vehicles);
      return true;
    } catch (err) {
      console.warn('[gridBG] riders unavailable:', err);
      g.traffic = null; // the road plays on without them
      return false;
    }
  }

  // One transform-feedback pass over a pool: reads its current buffer, writes the other.
  function simulate(g, pool, count) {
    const write = 1 - pool.read;
    gl.bindVertexArray(pool.updateVao[pool.read]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, g.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, pool.state[write]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    pool.read = write;
  }

  function sizeLightBuffer(light, width, height) {
    if (light.width === width && light.height === height) return;
    light.width = width;
    light.height = height;
    const allocate = () => {
      gl.bindTexture(gl.TEXTURE_2D, light.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, light.halfFloat ? gl.RGBA16F : gl.RGBA8, width, height, 0,
        gl.RGBA, light.halfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, light.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, light.texture, 0);
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    };
    if (!allocate() && light.halfFloat) {
      light.halfFloat = false;
      allocate();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------------------------------------------------------------- device budget
  function deviceTier() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    if (coarse && Math.min(w, h) < 600) return 'phone';
    if (coarse) return 'tablet';
    if (w * h >= 2.0e6 && cores >= 8) return 'large';
    return 'desktop';
  }
  const tier = deviceTier();

  function particleBudget() {
    const cores = navigator.hardwareConcurrency || 4;
    const n = { phone: 2000, tablet: 4000, desktop: 8000, large: 12000 }[tier];
    return tier === 'desktop' && cores <= 4 ? Math.round(n * 0.6) : n;
  }

  // ---------------------------------------------------------------- traffic
  // Side profiles in figure units: facing +x, about 1 × 1, ground at y = 0.
  // Strokes: ['line', x1, y1, x2, y2] | ['quad', x1, y1, cx, cy, x2, y2] | ['arc', cx, cy, r, deg0, deg1].
  // Wheels (tyre, hub and spokes) roll on the GPU.
  const VEHICLES = {
    // Ather-style scooty with a chibi rider: big round helmet and visor, small bean body.
    scooter: {
      height: 1.0,
      wheels: [{ c: [0.2, 0.12], r: 0.12, spokes: 5, hub: 0.025 }, { c: [0.82, 0.12], r: 0.12, spokes: 5, hub: 0.025 }],
      strokes: [
        ['quad', 0.02, 0.37, 0.12, 0.42, 0.36, 0.41],    // tail → seat
        ['quad', 0.02, 0.37, 0.1, 0.27, 0.3, 0.27],      // tail underside, over the rear wheel
        ['quad', 0.3, 0.27, 0.42, 0.27, 0.48, 0.2],
        ['line', 0.48, 0.2, 0.66, 0.2],                  // floorboard
        ['quad', 0.66, 0.2, 0.68, 0.44, 0.76, 0.58],     // leg shield
        ['quad', 0.76, 0.58, 0.95, 0.52, 0.86, 0.28],    // sweeping front apron
        ['line', 0.87, 0.5, 0.93, 0.47],                 // headlamp
        ['arc', 0.82, 0.12, 0.16, 25, 115],              // front mudguard
        ['line', 0.78, 0.36, 0.82, 0.12],                // fork
        ['line', 0.76, 0.58, 0.73, 0.64],                // handlebar
        ['arc', 0.47, 0.79, 0.17, 0, 360],               // rider: big round helmet
        ['arc', 0.47, 0.79, 0.1, -55, 55],               // visor
        ['quad', 0.38, 0.43, 0.34, 0.56, 0.42, 0.63],    // back
        ['quad', 0.5, 0.63, 0.6, 0.6, 0.72, 0.63],       // arm to the grip
        ['quad', 0.4, 0.43, 0.52, 0.47, 0.62, 0.44],     // lap
        ['quad', 0.62, 0.44, 0.66, 0.36, 0.63, 0.22],    // leg
      ],
    },
    // E-bike with a chibi delivery rider and the delivery box on their back.
    delivery: {
      height: 1.0,
      wheels: [{ c: [0.19, 0.16], r: 0.16, spokes: 6, hub: 0.035 }, { c: [0.81, 0.16], r: 0.16, spokes: 6, hub: 0.02 }],
      strokes: [
        ['line', 0.46, 0.16, 0.41, 0.42],                // seat tube
        ['line', 0.41, 0.42, 0.68, 0.44],                // top tube
        ['line', 0.46, 0.16, 0.7, 0.38],                 // down tube
        ['quad', 0.49, 0.22, 0.6, 0.35, 0.67, 0.39],     // battery pack
        ['line', 0.46, 0.16, 0.19, 0.16],                // chainstay
        ['line', 0.42, 0.38, 0.19, 0.16],                // seatstay
        ['line', 0.69, 0.47, 0.81, 0.16],                // fork
        ['line', 0.36, 0.45, 0.45, 0.46],                // saddle
        ['quad', 0.69, 0.47, 0.7, 0.54, 0.76, 0.54],     // handlebar
        ['arc', 0.6, 0.8, 0.15, 0, 360],                 // rider: big round head
        ['quad', 0.5, 0.9, 0.62, 1.0, 0.76, 0.86],       // cap
        ['line', 0.72, 0.88, 0.82, 0.85],                // cap brim
        ['quad', 0.42, 0.47, 0.44, 0.6, 0.52, 0.67],     // back
        ['quad', 0.56, 0.64, 0.66, 0.6, 0.74, 0.54],     // arm to the bar
        ['quad', 0.44, 0.47, 0.54, 0.46, 0.58, 0.38],    // thigh
        ['line', 0.58, 0.38, 0.5, 0.18],                 // shin to the pedal
        ['line', 0.2, 0.48, 0.42, 0.5],                  // delivery box
        ['line', 0.42, 0.5, 0.44, 0.76],
        ['line', 0.44, 0.76, 0.22, 0.74],
        ['line', 0.22, 0.74, 0.2, 0.48],
        ['line', 0.22, 0.74, 0.27, 0.79],                // its lid
        ['line', 0.27, 0.79, 0.48, 0.8],
        ['line', 0.48, 0.8, 0.44, 0.76],
      ],
    },
  };

  // An Activa-shaped scooty in side view, traced off the line drawing this shot is modelled
  // on: front wheel at the left, big front mudguard, the apron rising into a handlebar cowl,
  // a flat floorboard, then the long seat and the tail rounding down over the rear wheel.
  //
  // One figure unit is the height from the floor to the top of the cowl, about 1.1 m. The
  // bay between the seat and the body's underside is drawn to take a PowerPod lying on the
  // slant, base down at the left and top out to the right; DOCK.pod in the film script
  // measures against that gap, so moving a stroke here means moving it too. Note this one
  // faces -x, unlike the traffic figures above.
  const DOCK_SCOOTER = {
    height: 1.0,
    wheels: [
      { c: [0.189, 0.189], r: 0.194, spokes: 0, hub: 0.055 },
      { c: [1.235, 0.197], r: 0.189, spokes: 0, hub: 0.055 },
    ],
    strokes: [
      // The floor. Runs past both wheels the way a single-line drawing's does, but no
      // further: it is the longest stroke here and takes a share of the points to match.
      ['line', -0.20, 0, 1.85, 0],

      // Wheel rims. The drawing has three rings a side: tyre, rim and hub, and the tyre and
      // hub come from `wheels` above, so only the middle one is a stroke.
      ['arc', 0.189, 0.189, 0.125, 0, 360],
      ['arc', 1.235, 0.197, 0.122, 0, 360],

      // The big front mudguard, hugging the wheel from its front tip over the top and back
      // behind the leg shield. An arc, so it sits a constant gap off the tyre.
      ['arc', 0.189, 0.189, 0.252, 163, 38],
      ['quad', -0.052, 0.263, 0.005, 0.318, 0.058, 0.347],

      // The front body as one closed loop: apron underside, apron face, cowl, leg shield,
      // and back down to where the deck starts. Closing it is what makes it read as a body
      // rather than a handful of strokes.
      //
      // The underside takes two strokes rather than one because it has to get from the deck
      // to the front of the leg shield without crossing the wheel or the mudguard. It rises
      // steeply clear of them first, then runs forward holding a 0.018 gap over the mudguard.
      // A single curve between those two points cuts straight through both.
      ['quad', 0.439, 0.228, 0.402, 0.300, 0.395, 0.355],
      ['quad', 0.395, 0.355, 0.320, 0.445, 0.235, 0.455],
      ['quad', 0.235, 0.455, 0.255, 0.630, 0.348, 0.780],
      ['line', 0.348, 0.780, 0.455, 0.940],
      ['line', 0.455, 0.940, 0.620, 0.900],
      ['line', 0.620, 0.900, 0.560, 0.822],
      ['line', 0.560, 0.822, 0.455, 0.765],
      ['quad', 0.455, 0.765, 0.490, 0.520, 0.500, 0.295],
      ['line', 0.500, 0.295, 0.439, 0.228],

      // Headlamp, bar and mirror boss.
      ['quad', 0.360, 0.800, 0.410, 0.862, 0.470, 0.848],
      ['line', 0.560, 0.845, 0.640, 0.828],
      ['arc', 0.616, 0.832, 0.020, 0, 360],

      // The deck, running slightly downhill to the back the way the drawing has it.
      ['line', 0.439, 0.228, 0.845, 0.205],

      // The rear body, also closed: up off the deck, an arch clear over the rear wheel, the
      // tail, the seat top, and the seat's front face back down to the deck.
      ['quad', 0.845, 0.205, 0.980, 0.250, 1.060, 0.300],
      ['quad', 1.060, 0.300, 1.180, 0.460, 1.300, 0.405],
      ['quad', 1.300, 0.405, 1.420, 0.400, 1.470, 0.425],
      ['quad', 1.470, 0.425, 1.515, 0.525, 1.485, 0.606],
      ['quad', 1.485, 0.606, 1.430, 0.695, 1.318, 0.720],
      ['quad', 1.318, 0.720, 1.080, 0.716, 0.848, 0.655],
      ['quad', 0.848, 0.655, 0.790, 0.470, 0.727, 0.318],
      ['line', 0.727, 0.318, 0.800, 0.215],

      // Tail lamp and grab rail. There is no seat/body joint line: the docked pod already
      // runs across that part of the body, and a second diagonal there only crowded it.
      ['line', 1.468, 0.505, 1.508, 0.492],
      ['quad', 1.380, 0.730, 1.520, 0.690, 1.560, 0.590],

      // The running gear. Without these the wheels read as two loose circles parked beside
      // the bodywork rather than as part of one machine. There is no muffler: this is an
      // electric scooter, and the stub that used to sit here just read as a line stuck on
      // the side of the rear tyre.
      ['line', 0.350, 0.330, 0.212, 0.203],            // front fork leg
      ['line', 1.140, 0.325, 1.228, 0.208],            // rear shock
    ],
  };

  // A quiet easter egg for whoever stays: faint two-way traffic driving on top of the road's
  // particle strands (strand 4 is the top of the road, 0 the bottom). The upper strands (2–3)
  // run left → right, the lower ones (0–1) right → left; on phones only the outer lanes clear
  // the headline. u = position along the road (× half-width, ±1 ≈ screen edges), speed in the
  // same units per second, at = seconds into the intro. Everyone stays on screen until the road scatters.
  const TRAFFIC = {
    phone: [
      { type: 'scooter', strand: 3, dir: 1, u: -0.95, speed: 0.12, at: 11.5 },
      { type: 'delivery', strand: 0, dir: -1, u: 0.95, speed: 0.1, at: 12.3 },
      { type: 'scooter', strand: 0, dir: -1, u: 0.05, speed: 0.05, at: 13.5 },
    ],
    desktop: [
      { type: 'scooter', strand: 3, dir: 1, u: -0.95, speed: 0.12, at: 11.5 },
      { type: 'delivery', strand: 0, dir: -1, u: 0.95, speed: 0.08, at: 12.1 },
      { type: 'scooter', strand: 2, dir: 1, u: 0.6, speed: 0.03, at: 12.9 },
      { type: 'delivery', strand: 1, dir: -1, u: -0.55, speed: 0.035, at: 13.5 },
      { type: 'scooter', strand: 0, dir: -1, u: 0.2, speed: 0.06, at: 14.5 },
    ],
  };
  const roster = reduceMotion ? []
    : tier === 'phone' ? TRAFFIC.phone
    : TRAFFIC.desktop.slice(0, tier === 'tablet' ? 4 : 5);
  const POINTS_PER_VEHICLE = { phone: 170, tablet: 240, desktop: 300, large: 300 }[tier];
  const TRAFFIC_START = Math.min(...roster.map((vehicle) => vehicle.at)) - 0.5; // park riders just before the first appears
  const FIGURE_SIZE = 0.6 * 0.13; // figures stand 60% as tall as the gap to the next strand, in lane-scale units

  function strokeLength(stroke) {
    if (stroke[0] === 'line') return Math.hypot(stroke[3] - stroke[1], stroke[4] - stroke[2]);
    if (stroke[0] === 'arc') return (Math.abs(stroke[5] - stroke[4]) * Math.PI / 180) * stroke[3];
    let length = 0;
    let [px, py] = strokePoint(stroke, 0);
    for (let i = 1; i <= 24; i++) {
      const [x, y] = strokePoint(stroke, i / 24);
      length += Math.hypot(x - px, y - py);
      px = x;
      py = y;
    }
    return length;
  }

  function strokePoint(stroke, t) {
    if (stroke[0] === 'line') return [stroke[1] + (stroke[3] - stroke[1]) * t, stroke[2] + (stroke[4] - stroke[2]) * t];
    if (stroke[0] === 'arc') {
      const a = (stroke[4] + (stroke[5] - stroke[4]) * t) * Math.PI / 180;
      return [stroke[1] + Math.cos(a) * stroke[3], stroke[2] + Math.sin(a) * stroke[3]];
    }
    const m = 1 - t;
    return [m * m * stroke[1] + 2 * m * t * stroke[3] + t * t * stroke[5], m * m * stroke[2] + 2 * m * t * stroke[4] + t * t * stroke[6]];
  }

  // Evenly spaced points along a vehicle's strokes → [x, y, hubX, hubY, wheelRadius] (radius 0 = body).
  function sampleVehicle(def, count) {
    const parts = def.strokes.map((stroke) => ({ stroke, wheel: null }));
    for (const wheel of def.wheels) {
      const [cx, cy] = wheel.c;
      parts.push({ stroke: ['arc', cx, cy, wheel.r, 0, 360], wheel });
      parts.push({ stroke: ['arc', cx, cy, wheel.hub, 0, 360], wheel });
      for (let k = 0; k < wheel.spokes; k++) {
        const a = (k / wheel.spokes) * Math.PI * 2;
        parts.push({
          stroke: ['line', cx + Math.cos(a) * wheel.hub, cy + Math.sin(a) * wheel.hub,
            cx + Math.cos(a) * wheel.r * 0.92, cy + Math.sin(a) * wheel.r * 0.92],
          wheel,
        });
      }
    }
    // Body strokes get denser dots than wheels, so the silhouette reads first.
    const lengths = parts.map((part) => strokeLength(part.stroke) * (part.wheel ? 0.75 : 1.35));
    const spacing = lengths.reduce((a, b) => a + b, 0) / count;
    const points = [];
    let offset = spacing * 0.5;
    parts.forEach((part, i) => {
      for (let d = offset; d < lengths[i] && points.length < count; d += spacing) {
        const [x, y] = strokePoint(part.stroke, d / lengths[i]);
        points.push(part.wheel ? [x, y, part.wheel.c[0], part.wheel.c[1], part.wheel.r] : [x, y, 0, 0, 0]);
      }
      offset = ((offset - lengths[i]) % spacing + spacing) % spacing;
    });
    for (let i = 0; points.length < count; i++) points.push(points[i]);
    return points;
  }

  // Static per-particle shape data for every vehicle on the roster.
  function buildTrafficShapes() {
    const data = new Float32Array(roster.length * POINTS_PER_VEHICLE * 6);
    const sampled = {};
    roster.forEach((vehicle, slot) => {
      sampled[vehicle.type] = sampled[vehicle.type] || sampleVehicle(VEHICLES[vehicle.type], POINTS_PER_VEHICLE);
      sampled[vehicle.type].forEach(([x, y, hubX, hubY, radius], j) => {
        data.set([x, y, hubX, hubY, slot, radius], (slot * POINTS_PER_VEHICLE + j) * 6);
      });
    });
    return data;
  }

  const capacity = particleBudget();
  let activeCount = capacity;
  let quality = 1;
  let resolutionScale = 1;

  // These pages open on a lit studio (skip-intro), so their first frame is drawn as soon as
  // the shaders are in, as it always was: the three still compile side by side first.
  const waitForShaders = skipIntro || reduceMotion || !parallel;
  let gpu;
  try {
    gpu = createGPU(capacity, waitForShaders);
  } catch (err) {
    fallback(err);
    return;
  }

  // ---------------------------------------------------------------- timeline
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  const S = { exposure: 0, focus: 3.0, aperture: 0.07, sweep: 0, sweepT: 0, ribbon: 0, breath: 0, density: 1, traffic: 0, pod: 0, podK: 22, podNoise: 0.3, night: 0 };
  roster.forEach((vehicle, i) => { S[`vehicle${i}`] = 0; });
  const tweens = [];
  const events = [];
  let clock = 0;      // timeline seconds (pauses with the tab)
  let simClock = 0;   // simulation seconds (slowed for reduced motion)

  function tween(key, to, duration, delay = 0, ease = easeInOut) {
    tweens.push({ key, to, duration, ease, start: clock + delay, from: null, done: false });
  }
  function cancel(...keys) {
    for (let i = tweens.length - 1; i >= 0; i--) if (keys.includes(tweens[i].key)) tweens.splice(i, 1);
  }
  function at(delay, fn) {
    events.push({ time: clock + delay, fn });
  }

  function advanceTimeline() {
    for (let i = 0; i < tweens.length; i++) {
      const t = tweens[i];
      if (clock < t.start) continue;
      if (t.from === null) {
        t.from = S[t.key];
        // A tween that starts takes its property over from any tween already running on it.
        for (let j = tweens.length - 1; j >= 0; j--) {
          const other = tweens[j];
          if (other !== t && other.key === t.key && other.from !== null) {
            tweens.splice(j, 1);
            if (j < i) i--;
          }
        }
      }
      const k = Math.min(1, (clock - t.start) / t.duration);
      S[t.key] = t.from + (t.to - t.from) * t.ease(k);
      t.done = k >= 1;
    }
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].done) tweens.splice(i, 1);
    for (let i = events.length - 1; i >= 0; i--) {
      if (clock >= events[i].time) events.splice(i, 1)[0].fn();
    }
  }

  function playIntro() {
    if (skipIntro || reduceMotion) {
      // traffic: 1 marks the road scene as already over. The riders are never faded in on a
      // page that skips the intro, but without this the render loop would start simulating
      // them, invisibly, eleven seconds in, and keep doing so for as long as the page is open.
      Object.assign(S, { exposure: 1, focus: 6.5, aperture: 0.08, density: DRIFT_DENSITY, traffic: 1 });
      if (skipIntro && !reduceMotion) {
        requestAnimationFrame(() => requestAnimationFrame(reveal));
      } else {
        reveal();
      }
      return;
    }
    // Lights come up on a field of soft, out-of-focus particles drifting on the noise field.
    tween('exposure', 1, 1.6, 0.15, easeInOut);
    // Sweep: attractors travel an arc left → right and drag the field with them.
    tween('sweep', 1, 1.1, 1.6, smoother);
    tween('sweepT', 1.25, 2.8, 1.6, easeInOut);
    // Ribbons: the sweep hands over to travelling wave bands; focus racks onto them.
    tween('ribbon', 1, 1.5, 3.1, smoother);
    tween('sweep', 0, 1.3, 3.3, smoother);
    tween('focus', RIBBON_DEPTH, 1.7, 3.0, easeInOut);
    tween('aperture', 0.08, 1.7, 3.0, easeInOut);
    at(3.2, reveal);
    // Traffic easter egg: faint riders materialise on the road one after another and drive along it.
    roster.forEach((vehicle, i) => tween(`vehicle${i}`, 1, 1.4, vehicle.at, easeInOut));
    // Release: the road holds behind the headline for a while, then the noise field takes
    // the particles (and the traffic) back as the field thins to a minimal drift.
    tween('ribbon', RESIDUAL_PULL, 3.6, 19.5, easeInOut);
    tween('traffic', 1, 3.5, 19.3, easeInOut);
    tween('density', DRIFT_DENSITY, 4.0, 19.3, easeInOut);
    tween('focus', 7.0, 4.0, 19.3, easeInOut);
    tween('aperture', 0.085, 4.0, 19.3, easeInOut);
    tween('breath', 1, 4.0, 23.0, easeInOut);
  }

  const mix = (a, b, t) => a + (b - a) * t;
  const remap01 = (t, a, b) => Math.min(1, Math.max(0, (t - a) / Math.max(1e-6, b - a)));

  // ---------------------------------------------------------------- night
  // The end of the film: the house lights come down and the field goes out, one spark at a
  // time, until the last few are the only light left in the room.
  //
  // It is a grade read at the uniforms, never written back into S. setPod reassigns density,
  // focus and aperture on every frame of the home page's scroll, so a night that lived in S
  // would be erased before it reached the GPU.
  function nightGrade() {
    if (S.night <= 0) return { house: 1, gain: 1, density: S.density, focus: S.focus, aperture: S.aperture };
    const down = smoother(remap01(S.night, 0.0, 0.62)); // how far the house has come down
    const out = smoother(remap01(S.night, 0.18, 0.96)); // how much of the field has gone out
    return {
      // Not to black: the horizon band and the light pool at the left edge survive as the
      // faintest structure, so it reads as a room at night rather than an empty buffer.
      house: mix(1, 0.1, down),
      gain: mix(1, 1.45, down),      // the survivors read as light sources, not grey dust
      density: S.density * (1 - out),
      // Rack past them as they go: the last ones bloom into big, soft discs.
      focus: S.focus + 3.2 * down,
      aperture: S.aperture * mix(1, 2.1, down),
    };
  }

  function setNight(progress) {
    S.night = Math.min(1, Math.max(0, progress));
  }

  let scrollDrive = false;
  let densityFrom = DRIFT_DENSITY;
  let ribbonFrom = 0;
  let focusFrom = 7.0;
  let apertureFrom = 0.085;
  let podTargetData = null;

  function takeScroll() {
    if (scrollDrive) return;
    scrollDrive = true;
    const keys = ['sweep', 'sweepT', 'ribbon', 'traffic', 'density', 'focus', 'aperture', 'breath'];
    roster.forEach((_, i) => keys.push(`vehicle${i}`));
    cancel(...keys);
    densityFrom = S.density;
    ribbonFrom = S.ribbon;
    focusFrom = S.focus;
    apertureFrom = S.aperture;
    S.sweep = 0;
    S.traffic = 1;
  }

  function setPod(progress) {
    const p = Math.min(1, Math.max(0, progress));
    if (reduceMotion) {
      S.pod = 0;
      return;
    }
    if (p <= 0 && !scrollDrive) return;
    takeScroll();
    // The first quarter-screen of scroll still sweeps the particles the way it always did;
    // only after that do they gather into the pod's silhouette.
    // The first quarter-screen of scroll lets go of the road and sweeps the loose particles
    // the way scrolling always did; only after that do they gather into the pod's silhouette.
    const loosen = smoother(remap01(p, 0.0, 0.2));
    const assemble = smoother(remap01(p, 0.22, 0.55));
    const release = smoother(remap01(p, 0.62, 0.95));
    const densUp = smoother(remap01(p, 0.22, 0.45));
    S.pod = assemble * (1 - release);
    S.density = mix(mix(densityFrom, 1, densUp), DRIFT_DENSITY, release);
    S.ribbon = mix(ribbonFrom, 0, Math.max(loosen, assemble)) + RESIDUAL_PULL * release;
    S.focus = mix(mix(focusFrom, RIBBON_DEPTH, assemble), 7.0, release);
    S.aperture = mix(mix(apertureFrom, 0.08, assemble), 0.085, release);
  }

  function uploadPodTargets(xyz) {
    if (!gpu || !gpu.podTargets || !xyz) return;
    const { texture, width, height } = gpu.podTargets;
    const data = new Float32Array(width * height * 4);
    const n = Math.min(capacity, Math.floor(xyz.length / 3));
    for (let i = 0; i < n; i++) {
      data[i * 4] = xyz[i * 3];
      data[i * 4 + 1] = xyz[i * 3 + 1];
      data[i * 4 + 2] = xyz[i * 3 + 2];
      data[i * 4 + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gpu.podTargets.ready = true;
  }

  function setPodTargets(xyz) {
    podTargetData = xyz;
    uploadPodTargets(xyz);
  }

  // ---------------------------------------------------------------- form
  // A drawing the field gathers into and holds, on a page that is not scroll driven: the Gen2
  // order page draws a profile on its details screen and a rupee on its payment screen. It
  // borrows the pod's targets and the pod's force, so the shaders cannot tell the difference,
  // but unlike setPod it never takes the scroll. It moves the same S keys through the timeline
  // and hands them back to wherever the drift had them when it lets go.
  //
  // spec: { key, points, rect, density }, or null to let go. `points` are x, y pairs in a unit
  // box (y up), ideally `capacity` of them, ordered so any prefix reads as the whole drawing:
  // the field only draws its first particles, and fewer of them on a struggling device.
  // `rect` is the DOM rect to fit the box into, `density` the share of the field to bring in.
  const FORM_IN = 1.6;         // s, the gather
  const FORM_LOOSEN = 0.7;     // s, letting go of one drawing before the next is gathered
  const FORM_OUT = 1.4;        // s, back to the drift
  const FORM_APERTURE = 0.06;  // stopped down a touch, so the drawing reads crisp against the bokeh
  // Between two drawings the lens racks off them and opens up, so the old one goes soft, the
  // particles cross over as bokeh, and the new one resolves as focus comes back: a camera
  // move rather than a swarm of sparks trading places.
  const FORM_RACK = 2.4;       // world units past the drawing
  const FORM_RACK_APERTURE = 0.11;
  // A still drawing held firmly, with little of the drift left in it, so a straight stroke
  // reads as straight. The defaults (22 and 0.3) are the loose, hand-drawn hold.
  const FORM_K = 64;
  const FORM_NOISE = 0.08;
  let form = null;             // { key, xyz } of the drawing held, or on its way in
  let formRest = null;         // the drift's own focus, aperture and density, to go back to
  let formUploaded = '';       // the key whose targets are in the texture
  let formSeq = 0;             // so a superseded swap never uploads

  function formTargets(spec) {
    const proj = projection();
    const hh = proj.depth * proj.tanHalfY;
    const r = spec.rect;
    const pts = spec.points;
    const n = Math.max(1, Math.floor(pts.length / 2));
    const xyz = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i++) {
      const j = (i % n) * 2;
      const sx = r.left + (pts[j] * 0.5 + 0.5) * r.width;
      const sy = r.top + (0.5 - pts[j + 1] * 0.5) * r.height;
      xyz[i * 3] = ((sx / cssW) * 2 - 1) * hh * proj.aspect;
      xyz[i * 3 + 1] = (1 - (sy / cssH) * 2) * hh;
      // Flat, on purpose. The drawing usually sits well off the axis (high in a phone's stage),
      // where any depth spread shows up through the perspective as a sideways scatter, and one
      // keyed to the point order turns a straight stroke into a saw tooth.
      xyz[i * 3 + 2] = -proj.depth;
    }
    return xyz;
  }

  function setForm(spec) {
    if (reduceMotion) return;

    if (!spec || !spec.points || !spec.rect) {
      if (!form) return;
      formSeq++; // a swap still waiting to upload is void now
      form = null;
      cancel('pod', 'density', 'focus', 'aperture', 'podK', 'podNoise');
      tween('pod', 0, FORM_OUT * 0.7, 0, easeInOut);
      tween('podK', 22, FORM_OUT, 0, easeInOut);
      tween('podNoise', 0.3, FORM_OUT, 0, easeInOut);
      if (formRest) {
        tween('density', formRest.density, FORM_OUT, 0, easeInOut);
        tween('focus', formRest.focus, FORM_OUT, 0, easeInOut);
        tween('aperture', formRest.aperture, FORM_OUT, 0, easeInOut);
      }
      formRest = null;
      return;
    }

    const xyz = formTargets(spec);
    // The same drawing again is a new place for it (a resize), not a new gather.
    if (form && form.key === spec.key) {
      form.xyz = xyz;
      if (formUploaded === spec.key) setPodTargets(xyz);
      return;
    }

    // Counted only here and on release, never for a same-drawing refresh above: that one has
    // to leave a pending swap alone, or the field would gather back into the old drawing.
    const seq = ++formSeq;
    if (!formRest) formRest = { focus: S.focus, aperture: S.aperture, density: S.density };
    form = { key: spec.key, xyz };
    cancel('pod', 'density', 'focus', 'aperture', 'podK', 'podNoise');

    // The hold firms up as the drawing arrives: loose enough on the way in that it gathers
    // softly, firm once it is there.
    const gather = (delay) => {
      tween('pod', 1, FORM_IN, delay, easeInOut);
      tween('podK', FORM_K, FORM_IN * 1.4, delay, easeInOut);
      tween('podNoise', FORM_NOISE, FORM_IN * 1.4, delay, easeInOut);
      tween('density', Math.min(1, Math.max(DRIFT_DENSITY, spec.density || 0.2)), FORM_IN * 0.8, delay, easeInOut);
      tween('focus', RIBBON_DEPTH, FORM_IN, delay, easeInOut);
      tween('aperture', FORM_APERTURE, FORM_IN, delay, easeInOut);
    };

    // Still holding a different drawing: loosen it first and swap the targets while the field
    // is loose, so it re-forms rather than flying straight across from one shape to the next.
    if (formUploaded && formUploaded !== spec.key && S.pod > 0.05) {
      tween('pod', 0, FORM_LOOSEN, 0, easeInOut);
      tween('podK', 22, FORM_LOOSEN, 0, easeInOut);
      tween('podNoise', 0.3, FORM_LOOSEN, 0, easeInOut);
      tween('focus', RIBBON_DEPTH + FORM_RACK, FORM_LOOSEN, 0, easeInOut);
      tween('aperture', FORM_RACK_APERTURE, FORM_LOOSEN, 0, easeInOut);
      at(FORM_LOOSEN, () => {
        if (seq !== formSeq || !form) return;
        setPodTargets(form.xyz);
        formUploaded = form.key;
      });
      gather(FORM_LOOSEN);
      return;
    }

    setPodTargets(xyz);
    formUploaded = spec.key;
    gather(0);
  }

  const halo = {
    weight: 0,
    cx: 0,
    cy: 0,
    hx: 1,
    hy: 1,
    radius: 0.2,
    depth: RIBBON_DEPTH,
    fill: 0,
    grip: 0,
  };

  // A DOM rect becomes a rounded rect in world space. `depth` brings it forward
  // (SHEET_DEPTH sits in front of the drift plane), `fill` turns the outline into a
  // panel, and `grip` decides how firmly the field is gathered onto it.
  function setHalo(spec) {
    if (!spec || reduceMotion || !(spec.weight > 0) || !spec.rect) {
      halo.weight = 0;
      return;
    }
    const proj = projection();
    const depth = spec.depth > 0.5 ? spec.depth : proj.depth;
    const hh = depth * proj.tanHalfY;
    const r = spec.rect;
    const cx = r.left + r.width * 0.5;
    const cy = r.top + r.height * 0.5;
    halo.cx = ((cx / cssW) * 2 - 1) * hh * proj.aspect;
    halo.cy = (1 - (cy / cssH) * 2) * hh;
    halo.hx = Math.max(1e-4, (r.width / cssW) * hh * proj.aspect);
    halo.hy = Math.max(1e-4, (r.height / cssH) * hh);
    halo.radius = Math.max(0, ((spec.radius || 0) / cssH) * 2 * hh);
    halo.depth = depth;
    halo.fill = Math.min(1, Math.max(0, spec.fill || 0));
    halo.grip = Math.min(1, Math.max(0, spec.grip || 0));
    halo.weight = Math.min(1, spec.weight);
  }

  function projection() {
    if (!cssW) measureCanvas();
    const aspect = (canvas.width && canvas.height) ? canvas.width / canvas.height : cssW / cssH;
    const tanHalfY = TAN_HALF_FOV / Math.min(aspect, 1);
    return { aspect, tanHalfY, depth: RIBBON_DEPTH, sheetDepth: SHEET_DEPTH };
  }

  // Attractor positions along a cubic Bézier arc through the frustum at SWEEP_DEPTH.
  const attractors = new Float32Array(12);
  function placeAttractors(aspect, tanHalfY) {
    const hh = SWEEP_DEPTH * tanHalfY;
    const hw = hh * aspect;
    for (let i = 0; i < 3; i++) {
      const s = Math.min(Math.max(S.sweepT - i * 0.11, 0), 1);
      const m = 1 - s;
      const b0 = m * m * m, b1 = 3 * m * m * s, b2 = 3 * m * s * s, b3 = s * s * s;
      attractors[i * 4] = hw * (-1.35 * b0 - 0.35 * b1 + 0.45 * b2 + 1.35 * b3);
      attractors[i * 4 + 1] = hh * (-0.55 * b0 + 0.95 * b1 - 0.85 * b2 + 0.05 * b3);
      attractors[i * 4 + 2] = -(SWEEP_DEPTH + (i - 1) * 1.2);
      attractors[i * 4 + 3] = ATTRACTOR_MASS[i];
    }
  }

  // Each vehicle's lane, position along it, direction and size, plus its speed and materialise weight.
  const vehicleLane = new Float32Array(24);
  const vehicleMotion = new Float32Array(24);
  function placeTraffic() {
    roster.forEach((vehicle, i) => {
      const riding = Math.max(0, clock - vehicle.at);
      const o = i * 4;
      const height = VEHICLES[vehicle.type].height;
      vehicleLane[o] = vehicle.strand;
      vehicleLane[o + 1] = vehicle.u + vehicle.dir * vehicle.speed * riding;
      vehicleLane[o + 2] = vehicle.dir;
      vehicleLane[o + 3] = FIGURE_SIZE / height;
      vehicleMotion[o] = riding > 0 ? vehicle.dir * vehicle.speed : 0;
      vehicleMotion[o + 1] = S[`vehicle${i}`];
    });
  }

  // ---------------------------------------------------------------- sizing & quality
  let sizeDirty = true;

  // The canvas's CSS size, read once per resize rather than once per frame: reading it inside
  // a frame forces the browser to bring style and layout up to date first, every frame.
  let cssW = 0;
  let cssH = 0;
  function measureCanvas() {
    cssW = Math.max(1, canvas.clientWidth);
    cssH = Math.max(1, canvas.clientHeight);
  }

  // The composite is drawn at CSS resolution. Everything in it is soft: the particle light
  // buffer below was already at CSS resolution, the cyclorama's finest feature spans about
  // fifteen CSS pixels, and the dither is under one level of 8-bit. At the device's full
  // density the same picture cost four times the fill on a 2x screen (nine on 3x, before the
  // cap), for pixels the compositor would have interpolated to the same values. The one thing
  // that needs device pixels is the road's riders, whose points are a pixel wide: while they
  // are on screen (`dense`) the canvas goes up to full density, as it always was.
  let dense = false;

  function applySize() {
    sizeDirty = false;
    measureCanvas();
    const area = cssW * cssH;
    const dpr = window.devicePixelRatio || 1;
    const canvasCap = Math.sqrt(MAX_CANVAS_PIXELS / area);

    const base = Math.min(Math.min(dpr, 1) * resolutionScale, canvasCap);
    const ratio = dense ? Math.min(Math.min(dpr, 2) * resolutionScale, canvasCap) : base;
    const width = Math.max(1, Math.round(cssW * ratio));
    const height = Math.max(1, Math.round(cssH * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // Bokeh is soft, so the light buffer stays near CSS resolution: most of the fill cost saved.
    const lightRatio = Math.min(base, resolutionScale, Math.sqrt(MAX_PARTICLE_PIXELS / area));
    sizeLightBuffer(gpu.light, Math.max(1, Math.round(cssW * lightRatio)), Math.max(1, Math.round(cssH * lightRatio)));
  }

  let perfTime = 0, perfFrames = 0, slowWindows = 0, fastWindows = 0;

  function setQuality(q) {
    quality = Math.min(1, Math.max(MIN_QUALITY, q));
    activeCount = Math.max(1, Math.round(capacity * quality));
    const scale = 0.55 + 0.45 * quality;
    if (Math.abs(scale - resolutionScale) > 0.01) {
      resolutionScale = scale;
      sizeDirty = true;
    }
  }

  // perf.js owns the frame-rate ladder for every canvas on the page; particle shedding is its
  // last step, applied here.
  if (perf) {
    perf.on((p) => {
      const q = Math.pow(0.85, p.shed);
      if (Math.abs(Math.max(MIN_QUALITY, q) - quality) > 1e-3) setQuality(q);
    });
  }

  // Frame-time governor, for a page without perf.js: sheds particles and resolution on
  // struggling devices, restores slowly.
  function governor(rawDt) {
    if (rawDt <= 0 || rawDt > 0.25) return;
    perfTime += rawDt;
    perfFrames++;
    if (perfTime < 1) return;
    const avgMs = (perfTime / perfFrames) * 1000;
    perfTime = 0;
    perfFrames = 0;
    if (clock < 2.5) return; // ignore start-up hitches (fonts, shader warm-up)
    if (avgMs > 21) {
      fastWindows = 0;
      if (++slowWindows >= 2 && quality > MIN_QUALITY) {
        setQuality(quality * 0.85);
        slowWindows = 0;
      }
    } else if (avgMs < 17.8) {
      slowWindows = 0;
      if (++fastWindows >= 10 && quality < 1) {
        setQuality(quality * 1.08);
        fastWindows = 0;
      }
    } else {
      slowWindows = 0;
      fastWindows = 0;
    }
  }

  // ---------------------------------------------------------------- scroll input
  // Real page scroll drives the particle sweep. While the page is too short to scroll,
  // wheel and touch-drag gestures stand in for it.
  let scrollPx = 0;        // CSS px scrolled since the last frame (+ = down)
  let scrollVelocity = 0;  // smoothed, CSS px/s
  let scrollEnergy = 0;
  let lastScrollY = window.scrollY;
  let touchY = null;
  // Whether the page scrolls, kept rather than measured on every wheel and touch event.
  let scrollsKnown = false;
  let scrolls = true;
  const pageScrolls = () => {
    if (!scrollsKnown) {
      scrolls = document.documentElement.scrollHeight > window.innerHeight + 1;
      scrollsKnown = true;
    }
    return scrolls;
  };
  if ('ResizeObserver' in window) new ResizeObserver(() => { scrollsKnown = false; }).observe(document.documentElement);
  window.addEventListener('resize', () => { scrollsKnown = false; });

  window.addEventListener('scroll', () => {
    scrollPx += window.scrollY - lastScrollY;
    lastScrollY = window.scrollY;
  }, { passive: true });
  window.addEventListener('wheel', (event) => {
    if (pageScrolls()) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    scrollPx += event.deltaY * unit;
  }, { passive: true });
  window.addEventListener('touchstart', (event) => { touchY = event.touches[0].clientY; }, { passive: true });
  window.addEventListener('touchmove', (event) => {
    const y = event.touches[0].clientY;
    if (touchY !== null && !pageScrolls()) scrollPx += touchY - y;
    touchY = y;
  }, { passive: true });
  window.addEventListener('touchend', () => { touchY = null; }, { passive: true });

  // Horizontal travel has no native event to listen to, so a page that moves something
  // sideways reports it through sweepX(). Same units and sign convention as scroll: CSS px
  // the content moved this frame, + = to the right.
  let driftPx = 0;
  let driftVelocity = 0;
  let driftEnergy = 0;

  // ---------------------------------------------------------------- render loop
  let frameIndex = 0;

  function render(dt) {
    const g = gpu;
    const aspect = canvas.width / canvas.height;
    const tanHalfY = TAN_HALF_FOV / Math.min(aspect, 1);
    const simDt = dt * (reduceMotion ? 0.3 : 1);
    simClock += simDt;
    frameIndex = (frameIndex + 1) >>> 0;
    const N = nightGrade();
    // Particles past the density cut are fully faded, so they needn't be simulated or drawn.
    const count = Math.max(1, Math.min(activeCount, Math.ceil(capacity * Math.min(1, N.density + 0.1))));

    // Scroll → the world-space velocity particles are swept toward, measured at the ribbon depth.
    const rawScrollVelocity = dt > 0 ? scrollPx / dt : 0;
    scrollPx = 0;
    scrollVelocity += (rawScrollVelocity - scrollVelocity) * (1 - Math.exp(-dt / 0.06));
    const pxToWorld = (2 * RIBBON_DEPTH * tanHalfY) / cssH;
    // Scrolling sweeps the particles as it always did. The only time it eases off is while
    // they are locked into the pod's silhouette, so the formation can hold its shape.
    const followScale = (reduceMotion ? 0.3 : 1) * (1 - 0.85 * S.pod);
    const scrollFollow = Math.max(-10, Math.min(10,
      scrollVelocity * pxToWorld * SCROLL_FOLLOW * followScale));
    scrollEnergy = Math.max(Math.abs(scrollFollow), scrollEnergy * Math.exp(-dt / 2));

    // The sideways twin. Screen x and world x share a sign, so no flip here (scroll needs none
    // either: its +px is content moving up, which the shader already reads as +y).
    const rawDriftVelocity = dt > 0 ? driftPx / dt : 0;
    driftPx = 0;
    driftVelocity += (rawDriftVelocity - driftVelocity) * (1 - Math.exp(-dt / 0.06));
    const driftFollow = Math.max(-10, Math.min(10,
      driftVelocity * pxToWorld * SCROLL_FOLLOW * followScale));
    driftEnergy = Math.max(Math.abs(driftFollow), driftEnergy * Math.exp(-dt / 2));

    placeAttractors(aspect, tanHalfY);

    // 1. Simulation: one transform-feedback pass, no readback.
    let u = g.update.uniforms;
    gl.useProgram(g.update.program);
    gl.uniform1f(u.uTime, simClock);
    gl.uniform1f(u.uDt, simDt);
    gl.uniform1ui(u.uFrame, frameIndex);
    gl.uniform1f(u.uAspect, aspect);
    gl.uniform1f(u.uTanHalfY, tanHalfY);
    gl.uniform1f(u.uSweep, S.sweep);
    gl.uniform1f(u.uRibbon, S.ribbon);
    gl.uniform1f(u.uRibbonDepth, RIBBON_DEPTH);
    gl.uniform1f(u.uPrewarm, g.prewarm ? 1 : 0);
    gl.uniform4fv(u.uAttr, attractors);
    gl.uniform1f(u.uDensity, N.density);
    gl.uniform1f(u.uCount, capacity);
    gl.uniform1f(u.uScrollVel, scrollFollow);
    gl.uniform1f(u.uScrollEnergy, scrollEnergy);
    gl.uniform1f(u.uDriftVel, driftFollow);
    gl.uniform1f(u.uDriftEnergy, driftEnergy);
    gl.uniform1f(u.uPod, g.podTargets.ready ? S.pod : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.podTargets.texture);
    gl.uniform1i(u.uPodTargets, 0);
    gl.uniform2f(u.uPodTexSize, g.podTargets.width, g.podTargets.height);
    gl.uniform1f(u.uPodK, S.podK);
    gl.uniform1f(u.uPodNoise, S.podNoise);
    gl.uniform1f(u.uHalo, halo.weight);
    gl.uniform4f(u.uHaloRect, halo.cx, halo.cy, halo.hx, halo.hy);
    gl.uniform1f(u.uHaloRadius, halo.radius);
    gl.uniform1f(u.uHaloDepth, halo.depth);
    gl.uniform1f(u.uHaloFill, halo.fill);
    gl.uniform1f(u.uHaloGrip, halo.grip);
    g.prewarm = false;
    simulate(g, g.road, count);

    // 1b. Traffic: only while the road scene is on (parked just before, gone once scattered).
    const trafficOn = trafficWindow() && trafficReady(g);
    if (trafficOn) {
      placeTraffic();
      u = g.vehicles.uniforms;
      gl.useProgram(g.vehicles.program);
      gl.uniform1f(u.uTime, simClock);
      gl.uniform1f(u.uDt, simDt);
      gl.uniform1f(u.uAspect, aspect);
      gl.uniform1f(u.uTanHalfY, tanHalfY);
      gl.uniform1f(u.uRibbonDepth, RIBBON_DEPTH);
      gl.uniform4fv(u.uVehLane, vehicleLane);
      gl.uniform4fv(u.uVehMotion, vehicleMotion);
      gl.uniform1f(u.uTraffic, S.traffic);
      gl.uniform1f(u.uScrollVel, scrollFollow);
      gl.uniform1f(u.uScrollEnergy, scrollEnergy);
      simulate(g, g.traffic, g.traffic.count);
    }

    // 2. Bokeh particles → light buffer (additive).
    const pull = Math.min(1, S.sweep + S.ribbon + S.pod);
    const focus = N.focus + 0.45 * S.breath * (1 - pull) * Math.sin(clock * 0.09);

    gl.bindFramebuffer(gl.FRAMEBUFFER, g.light.fbo);
    gl.viewport(0, 0, g.light.width, g.light.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    u = g.particles.uniforms;
    gl.useProgram(g.particles.program);
    gl.uniform2f(u.uRes, g.light.width, g.light.height);
    gl.uniform1f(u.uAspect, aspect);
    gl.uniform1f(u.uTanHalfY, tanHalfY);
    gl.uniform1f(u.uFocus, focus);
    gl.uniform1f(u.uAperture, N.aperture);
    gl.uniform1f(u.uCore, 0.012);
    gl.uniform1f(u.uMinCore, 1.1);
    gl.uniform1f(u.uFloor, 0.012);
    gl.bindVertexArray(g.road.drawVao[g.road.read]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

    // 2b. Traffic: the same bokeh particles, finer, drawn at full canvas resolution so the tiny
    // riders stay crisp on high-density screens.
    if (trafficOn) {
      sizeLightBuffer(g.detail, canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.detail.fbo);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const pixelRatio = canvas.width / cssW;
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform1f(u.uCore, 0.006);
      gl.uniform1f(u.uMinCore, 0.85 * pixelRatio);
      gl.bindVertexArray(g.traffic.drawVao[g.traffic.read]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.traffic.count);
    } else if (g.detail.width > 1) {
      sizeLightBuffer(g.detail, 1, 1); // scene over: release the memory
    }
    gl.disable(gl.BLEND);

    // 3. Studio backdrop + composite.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    u = g.studio.uniforms;
    gl.useProgram(g.studio.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.light.texture);
    gl.uniform1i(u.uParticles, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.detail.texture);
    gl.uniform1i(u.uDetail, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform2f(u.uDrift,
      0.012 * (Math.sin(simClock * 0.071) + 0.5 * Math.sin(simClock * 0.13 + 1.7)),
      0.012 * (Math.cos(simClock * 0.053) + 0.5 * Math.sin(simClock * 0.097 + 0.4)));
    gl.uniform1f(u.uExposure, S.exposure);
    gl.uniform1f(u.uParticleGain, N.gain);
    gl.uniform1f(u.uHouse, N.house);
    gl.uniform1ui(u.uFrame, frameIndex);
    gl.bindVertexArray(g.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  let rafId = 0;
  let lastNow = 0;
  let live = false;
  let trafficQueued = false;

  // The road scene's window, the riders' and the full-density canvas's: from just before the
  // first one is due until the road lets go (or the reader scrolls, which ends it at once).
  const trafficWindow = () => roster.length > 0 && !skipIntro && clock > TRAFFIC_START && S.traffic < 1;

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (!gpu) return;
    // Asked every frame, drawn or not, so the governor sees the page's real frame rate.
    const due = perf ? perf.frame(now) : true;
    // Still compiling: the timeline waits with it (only the home page's dark opening gets here).
    let ready = false;
    try {
      ready = gpuReady(gpu);
    } catch (err) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      gpu = null;
      fallback(err);
      return;
    }
    if (!ready) {
      lastNow = now;
      return;
    }
    if (!due) return;
    // Under reduced motion the field moves at a third of its speed, which thirty frames a
    // second draw exactly as well as sixty.
    if (reduceMotion && now - lastNow < 30) return;
    const rawDt = (now - lastNow) / 1000;
    lastNow = now;
    const dt = Math.min(Math.max(rawDt, 0), 1 / 20);
    clock += dt;
    if (!perf) governor(rawDt);
    advanceTimeline();

    // Build the riders a few seconds before they are due, while the opening is calm.
    if (!trafficQueued && roster.length && !skipIntro && !scrollDrive && clock > TRAFFIC_START - 6) {
      trafficQueued = true;
      const idle = perf ? perf.idle : (fn) => setTimeout(fn, 0);
      idle(() => {
        if (gpu && !scrollDrive && S.traffic < 1) prepareTraffic(gpu);
      }, 2000);
    }
    const wantDense = trafficWindow() && !!gpu.traffic;
    if (wantDense !== dense) {
      dense = wantDense;
      sizeDirty = true;
    }

    if (sizeDirty) applySize();
    render(dt);

    if (!live) {
      // The canvas now covers the CSS studio behind it, so the root can stop painting it.
      live = true;
      root.classList.add('gl-live');
    }
    if (perf && perf.hudOn && frameIndex % 30 === 0) {
      perf.report('field', `${canvas.width}x${canvas.height} light ${gpu.light.width}x${gpu.light.height}`
        + ` particles ${capacity} q ${quality.toFixed(2)}${dense ? ' dense' : ''}`);
    }
  }

  function start() {
    lastNow = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- lifecycle
  const resized = () => {
    sizeDirty = true;
    cssW = 0; // measured again where it is next needed
  };
  if ('ResizeObserver' in window) new ResizeObserver(resized).observe(canvas);
  window.addEventListener('resize', resized);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (gpu && !rafId) {
      start();
    }
  });

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    cancelAnimationFrame(rafId);
    rafId = 0;
    gpu = null;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      gpu = createGPU(capacity, true);
      trafficQueued = false;
      sizeDirty = true;
      if (podTargetData) uploadPodTargets(podTargetData);
      if (!document.hidden) start();
    } catch (err) {
      fallback(err);
    }
  });

  // Hook for later sections (scroll triggers, page transitions) to reuse the attractors.
  window.gridBG = {
    transition(name) {
      if (reduceMotion) return;
      if (name === 'sweep') {
        cancel('sweep', 'sweepT');
        S.sweepT = 0;
        tween('sweep', 1, 1.0, 0, smoother);
        tween('sweepT', 1.25, 2.8, 0, easeInOut);
        tween('sweep', 0, 1.2, 2.0, smoother);
      } else if (name === 'ribbons') {
        cancel('ribbon', 'focus', 'aperture');
        tween('ribbon', 1, 1.5, 0, smoother);
        tween('focus', RIBBON_DEPTH, 1.7, 0, easeInOut);
        tween('aperture', 0.08, 1.7, 0, easeInOut);
      } else if (name === 'sheet') {
        // A dialog opens: the lens racks forward onto the panel plane and stops down,
        // so the bokeh discs collapse into crisp points, and the field thickens.
        cancel('focus', 'aperture', 'density');
        tween('focus', SHEET_DEPTH, 0.55, 0, easeInOut);
        tween('aperture', 0.018, 0.55, 0, easeInOut);
        tween('density', SHEET_DENSITY, 0.5, 0, easeInOut);
      } else if (name === 'sheet-release') {
        cancel('focus', 'aperture', 'density');
        tween('focus', 6.5, 0.8, 0, easeInOut);
        tween('aperture', 0.08, 0.8, 0, easeInOut);
        tween('density', DRIFT_DENSITY, 0.8, 0, easeInOut);
      } else if (name === 'release') {
        cancel('sweep', 'ribbon', 'focus', 'aperture');
        tween('sweep', 0, 1.2, 0, smoother);
        tween('ribbon', RESIDUAL_PULL, 3.6, 0, easeInOut);
        tween('focus', 7.0, 4.0, 0, easeInOut);
        tween('aperture', 0.085, 4.0, 0, easeInOut);
      } else {
        console.warn(`[gridBG] unknown transition "${name}"`);
      }
    },
    setPod,
    setPodTargets,
    setForm,
    setHalo,
    setNight,
    // CSS px something on the page travelled sideways this frame (+ = right). The field is
    // swept along with it the way scrolling sweeps it vertically.
    sweepX(px) {
      if (Number.isFinite(px)) driftPx += px;
    },
    projection,
    // The home page's dock shot samples this profile into pod targets. Exported rather
    // than duplicated so the stroke table has exactly one home.
    dockScooter: DOCK_SCOOTER,
    sampleVehicle,
    get capacity() { return capacity; },
    get quality() { return quality; },
  };

  playIntro();
  start();
})();
