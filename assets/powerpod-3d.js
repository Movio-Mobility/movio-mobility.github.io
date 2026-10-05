/*
 * PowerPod 3D: the product scene, on its own.
 *
 * Scene construction only: studio environment, mesh, materials, decals, connector, display
 * and lights. No scroll listener, no render loop, no knowledge of the particle field. The
 * page owns the camera choreography and the rAF; this module just builds the pod and places
 * a camera on request.
 *
 * NOTE: the home page carries its own inline copy of this scene (index.html, the gridPod
 * IIFE). The two are kept deliberately in sync by hand: a change to materials, lighting or
 * geometry here must be made there too. Home was left on its inline copy so that adding a
 * product page could not regress the film on the front door.
 *
 * Requires THREE and the GEO/LOGO globals from powerpod-data.js to already be loaded.
 */
(() => {
  'use strict';

  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const remap01 = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a), 0, 1);
  const mix = (a, b, t) => a + (b - a) * t;

  // Interpolate a list of `{ at, ... }` beats at position t. Lifted from the home page film.
  function shotAt(beats, t) {
    let i = 0;
    while (i < beats.length - 1 && t > beats[i + 1].at) i++;
    const a = beats[i];
    const b = beats[Math.min(beats.length - 1, i + 1)];
    const k = b === a ? 0 : smoother(remap01(t, a.at, b.at));
    return {
      az: mix(a.az, b.az, k),
      el: mix(a.el, b.el, k),
      frame: mix(a.frame, b.frame, k),
      target: mix(a.target, b.target, k),
    };
  }

  function mount(opts) {
    const o = opts || {};
    const canvas = o.canvas;
    if (!canvas || !window.THREE || typeof GEO === 'undefined') return null;

    try {
      const THREE = window.THREE;
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const phone = o.phone !== undefined
        ? o.phone
        : (coarse && Math.min(innerWidth, innerHeight) < 600);
      const fov = o.fov || 28;
      const fogColor = o.fogColor !== undefined ? o.fogColor : 0xcbcbc9;

      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: o.antialias !== undefined ? o.antialias : !phone,
        alpha: true,
        powerPreference: phone ? 'low-power' : 'high-performance',
        premultipliedAlpha: true,
      });
      // A starting value only. applySize() sets the real one before the first frame, which is
      // this capped by buffer area as well (see podPixelRatio).
      renderer.setPixelRatio(o.pixelRatio || Math.min(window.devicePixelRatio || 1, phone ? 1.5 : 2));
      renderer.setClearColor(0x000000, 0);
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = o.exposure || 1.02;

      const scene = new THREE.Scene();
      scene.background = null;
      // A whisper of haze in the backdrop's own grey, so the pod's far side melts into the
      // page instead of cutting out against it. Range follows the shot (see place()).
      scene.fog = new THREE.Fog(fogColor, 900, 3000);
      const camera = new THREE.PerspectiveCamera(fov, 1, 5, 6000);

      // The page's backdrop puts its key hotspot upper-left just above the horizon, a bright
      // band strongest on the right, and a bright floor below. The pod reads its blacks almost
      // entirely from this environment, so it mirrors that room exactly.
      function studio() {
        const s = new THREE.Scene();
        const g = new THREE.BoxGeometry(1, 1, 1);
        const P = (w, h, d, x, y, z, c, i) => {
          const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c }));
          m.scale.set(w, h, d);
          m.position.set(x, y, z);
          m.material.color.multiplyScalar(i);
          s.add(m);
        };
        s.add(new THREE.Mesh(
          new THREE.BoxGeometry(5000, 5000, 5000),
          new THREE.MeshBasicMaterial({ color: 0xcdcdcb, side: THREE.BackSide }),
        ));
        P(940, 640, 900, -820, 430, 600, 0xffffff, 5.0);   // key hotspot, upper left front
        P(1500, 20, 1200, 0, 780, 120, 0xffffff, 2.1);     // soft ceiling
        P(20, 520, 1400, 980, 60, 120, 0xf7f3ec, 3.0);     // horizon band, brightest on the right
        P(1500, 20, 1300, 0, -640, 0, 0xffffff, 2.4);      // the backdrop's bright floor
        P(1300, 700, 20, 0, 120, -820, 0xffffff, 1.2);     // back wall
        return s;
      }
      const pm = new THREE.PMREMGenerator(renderer);
      pm.compileEquirectangularShader();
      const envRT = pm.fromScene(studio(), 0.035);
      scene.environment = envRT.texture;

      function grain(size, amt) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        const d = g.createImageData(size, size);
        for (let i = 0; i < size * size; i++) {
          const v = 200 + (Math.random() - 0.5) * amt;
          d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v;
          d.data[i * 4 + 3] = 255;
        }
        g.putImageData(d, 0, 0);
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(26, 26);
        return t;
      }
      const GRAIN = grain(256, 86);

      function decode(src) {
        const vb = atob(src.v);
        const pos = new Float32Array(src.nv * 3);
        for (let i = 0; i < src.nv * 3; i++) {
          const k = i * 2;
          const q = vb.charCodeAt(k) | (vb.charCodeAt(k + 1) << 8);
          pos[i] = src.lo[i % 3] + q * src.sc[i % 3];
        }
        const nb = atob(src.n);
        const nor = new Float32Array(src.nv * 3);
        for (let i = 0; i < src.nv * 3; i++) {
          let c = nb.charCodeAt(i);
          if (c > 127) c -= 256;
          nor[i] = c / 127;
        }
        const fb = atob(src.f);
        const idx = new Uint16Array(src.nf * 3);
        for (let i = 0; i < src.nf * 3; i++) {
          const k = i * 2;
          idx[i] = fb.charCodeAt(k) | (fb.charCodeAt(k + 1) << 8);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        const uv = new Float32Array(src.nv * 2);
        for (let i = 0; i < src.nv; i++) {
          uv[i * 2] = pos[i * 3] * 0.01;
          uv[i * 2 + 1] = pos[i * 3 + 1] * 0.01;
        }
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.addGroup(0, src.split * 3, 0);
        g.addGroup(src.split * 3, (src.nf - src.split) * 3, 1);
        g.computeBoundingBox();
        return g;
      }

      // The caps: moulded black with a soft satin coat, not a lacquer.
      const pc = new THREE.MeshPhysicalMaterial({
        color: 0x060607, metalness: 0.0, roughness: 0.64, roughnessMap: GRAIN,
        clearcoat: 0.30, clearcoatRoughness: 0.38, reflectivity: 0.26, envMapIntensity: 0.42,
      });
      // The grip bar is moulded into the top cap, so it gets its own textured finish by height
      // rather than a separate mesh. The cap's rim tops out at 177.8; everything above it is the
      // bar, which fades to a dry matte by 181 so its feet, where it sweeps down into the
      // corners, stop catching the key hotspot as a white streak. Roughness alone only spreads
      // that streak out, so the grip's reflections are also cut to about a third.
      pc.onBeforeCompile = (sh) => {
        sh.vertexShader = 'varying float vGrip;\n' + sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvGrip = smoothstep( 177.9, 181.0, position.x );',
        );
        sh.fragmentShader = 'varying float vGrip;\n' + sh.fragmentShader.replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
          material.specularRoughness = mix( material.specularRoughness, 0.84, vGrip );
          #ifdef CLEARCOAT
            material.clearcoat *= 1.0 - vGrip;
          #endif`,
        ).replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.directSpecular *= 1.0 - 0.65 * vGrip;
          reflectedLight.indirectSpecular *= 1.0 - 0.65 * vGrip;`,
        );
      };
      const alu = new THREE.MeshPhysicalMaterial({
        color: 0x0d0f11, metalness: 0.90, roughness: 0.34, envMapIntensity: 1.05,
      });

      const pod = new THREE.Group();
      scene.add(pod);
      const mesh = new THREE.Mesh(decode(GEO), [pc, alu]);
      pod.add(mesh);
      pod.rotation.z = Math.PI / 2; // local +X becomes world +Y: the pod stands up
      const bb = mesh.geometry.boundingBox;
      const HALF = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) / 2;
      const BASE = bb.min.x; // the connector end, which lands at the bottom once rotated

      if (typeof LOGO !== 'undefined') {
        new THREE.TextureLoader().load(LOGO, (t) => {
          t.encoding = THREE.sRGBEncoding;
          t.anisotropy = 8;
          const LEN = 258, WID = LEN / 8, FACE = 66.11, LIFT = 0.4, SHIFT = -20, ALONG = -4;
          [1, -1].forEach((s) => {
            const ez = new THREE.Vector3(0, 0, s);
            const ex = new THREE.Vector3(1, 0, 0);
            const ey = new THREE.Vector3().crossVectors(ez, ex);
            const m = new THREE.Mesh(
              new THREE.PlaneGeometry(LEN, WID),
              new THREE.MeshPhysicalMaterial({
                map: t, transparent: true,
                metalness: 0.0, roughness: 0.34, clearcoat: 0.9, clearcoatRoughness: 0.10,
                envMapIntensity: 0.45, depthWrite: false,
                polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
              }),
            );
            m.applyMatrix4(new THREE.Matrix4().makeBasis(ex, ey, ez));
            m.position.copy(ez).multiplyScalar(FACE + LIFT)
              .addScaledVector(ey, SHIFT).addScaledVector(ex, ALONG);
            pod.add(m);
          });
        });
      }

      (function connector() {
        const brass = new THREE.MeshPhysicalMaterial({
          color: 0xB07A2A, metalness: 1.0, roughness: 0.28, envMapIntensity: 1.1,
        });
        const brassDark = new THREE.MeshPhysicalMaterial({
          color: 0x6E4A17, metalness: 1.0, roughness: 0.45, envMapIntensity: 0.8,
        });
        const plate = new THREE.MeshPhysicalMaterial({
          color: 0x8E9298, metalness: 0.85, roughness: 0.42, envMapIntensity: 0.9,
        });
        const steel = new THREE.MeshPhysicalMaterial({
          color: 0xA9AEB4, metalness: 1.0, roughness: 0.35, envMapIntensity: 0.9,
        });
        const g = new THREE.Group();
        pod.add(g);
        const F = BASE + 1.2;
        function rr(w, h, r) {
          const s = new THREE.Shape();
          s.moveTo(-w / 2 + r, -h / 2);
          s.lineTo(w / 2 - r, -h / 2);
          s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
          s.lineTo(w / 2, h / 2 - r);
          s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
          s.lineTo(-w / 2 + r, h / 2);
          s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
          s.lineTo(-w / 2, -h / 2 + r);
          s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
          return s;
        }
        const outer = new THREE.Mesh(new THREE.ExtrudeGeometry(rr(73, 73, 9), { depth: 1.4, bevelEnabled: false }), plate);
        outer.rotation.y = Math.PI / 2;
        outer.position.x = F + 1.4;
        g.add(outer);
        const inner = new THREE.Mesh(new THREE.ExtrudeGeometry(rr(41, 41, 9), { depth: 2.2, bevelEnabled: false }), plate);
        inner.rotation.y = Math.PI / 2;
        inner.position.x = F + 2.4;
        g.add(inner);
        function pin(y, z, dia, len, mat) {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2, dia / 2, len, 28), mat);
          p.rotation.z = Math.PI / 2;
          p.position.set(F + len / 2 - 0.2, y, z);
          g.add(p);
          const cup = new THREE.Mesh(new THREE.CircleGeometry(dia / 2 * 0.62, 24), brassDark);
          cup.rotation.y = -Math.PI / 2;
          cup.position.set(F - 0.25, y, z);
          g.add(cup);
        }
        [[0, 32.9], [0, -32.9], [32.9, 0], [-32.9, 0]].forEach(([y, z]) => pin(y, z, 6.6, 2.0, brass));
        [[12.6, 12.6], [12.6, -12.6], [-12.6, 12.6], [-12.6, -12.6]].forEach(([y, z]) => pin(y, z, 5.4, 3.0, brass));
        pin(0, 0, 9.5, 3.4, brass);
        [[28, 28], [28, -28], [-28, 28], [-28, -28]].forEach(([y, z]) => {
          const s = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 1.0, 22), steel);
          s.rotation.z = Math.PI / 2;
          s.position.set(F + 0.3, y, z);
          g.add(s);
        });
      }());

      (function display() {
        const cv = document.createElement('canvas');
        cv.width = 512;
        cv.height = 150;
        const g = cv.getContext('2d');
        const w = cv.width, h = cv.height, r = h / 2 - 4;
        g.fillStyle = '#040405';
        g.beginPath();
        g.moveTo(r + 4, 4);
        g.lineTo(w - r - 4, 4);
        g.arc(w - r - 4, h / 2, r, -Math.PI / 2, Math.PI / 2);
        g.lineTo(r + 4, h - 4);
        g.arc(r + 4, h / 2, r, Math.PI / 2, -Math.PI / 2);
        g.closePath();
        g.fill();
        g.font = '500 54px -apple-system,Segoe UI,Roboto,sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.shadowColor = '#4CFF6B';
        g.shadowBlur = 14;
        g.fillStyle = '#5CFF78';
        g.fillText('75%', w / 2, h / 2 + 2);
        const tex = new THREE.CanvasTexture(cv);
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = 8;
        const PW = 34, PH = PW * 150 / 512;
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(PW, PH),
          new THREE.MeshBasicMaterial({
            map: tex, transparent: true, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
          }),
        );
        const DIR = 135 * Math.PI / 180;
        const ez = new THREE.Vector3(1, 0, 0);
        const ex = new THREE.Vector3(0, Math.cos(DIR), Math.sin(DIR)).normalize();
        const ey = new THREE.Vector3().crossVectors(ez, ex);
        m.applyMatrix4(new THREE.Matrix4().makeBasis(ex, ey, ez));
        m.position.set(195.95, 0.83, -1.30);
        pod.add(m);
      }());

      // Lights aimed to agree with the backdrop: key from the upper left, the horizon band
      // filling from the right, a cool low front fill, and a bounce off the bright floor.
      const key = new THREE.DirectionalLight(0xffffff, 1.9);
      key.position.set(-430, 600, 520);
      scene.add(key);
      const band = new THREE.DirectionalLight(0xfff2e6, 0.85);
      band.position.set(720, 90, 160);
      scene.add(band);
      const fill = new THREE.DirectionalLight(0xe8f0ff, 0.5);
      fill.position.set(-260, -60, 620);
      scene.add(fill);
      const bounce = new THREE.DirectionalLight(0xffffff, 0.34);
      bounce.position.set(60, -560, 220);
      scene.add(bounce);
      scene.add(new THREE.AmbientLight(0xffffff, 0.40));

      // ---------------------------------------------------------------- placement
      const TAN_HALF = Math.tan((Math.PI * fov) / 360);

      // Distance at which the pod's height fills `fraction` of the canvas, never so close
      // that its width spills past 80% of the frame (which is what binds on wide boxes).
      function frameDist(fraction) {
        const byHeight = (HALF / Math.max(0.05, fraction)) / TAN_HALF;
        const byWidth = ((HALF * 0.48) / 0.8) / (TAN_HALF * Math.max(0.2, camera.aspect));
        return Math.max(byHeight, byWidth);
      }

      function place(shot, driftAz, driftEl, offset) {
        const el = clamp(shot.el + (driftEl || 0), -1.3, 1.3);
        const az = shot.az + (driftAz || 0);
        const dist = frameDist(shot.frame);
        camera.position.set(
          dist * Math.cos(el) * Math.sin(az),
          shot.target + dist * Math.sin(el),
          dist * Math.cos(el) * Math.cos(az),
        );
        camera.lookAt(0, shot.target, 0);

        // Lens shift in fractions of the canvas box. Positive y lifts the subject in frame,
        // negative drops it. Pages use it to keep the pod clear of overlaid chrome.
        const w = Math.max(1, canvas.clientWidth);
        const h = Math.max(1, canvas.clientHeight);
        if (offset && (offset.x || offset.y)) {
          camera.setViewOffset(w, h, w * offset.x, h * offset.y, w, h);
        } else if (camera.view && camera.view.enabled) {
          camera.clearViewOffset();
        }

        scene.fog.near = dist * 0.85;
        scene.fog.far = dist * 2.7;
      }

      // Resizing is deferred to the next render, so a CSS height transition on the host box
      // cannot call setSize several times in one frame.
      let sizeDirty = true;
      let lost = false;

      // The buffer is capped by area as well as by device pixel ratio. Without it a large window
      // put this canvas at fourteen million pixels, redrawn every frame. The cap is set high
      // enough that every ordinary laptop size still renders at the full device pixel ratio and
      // only a genuinely large window gives anything up.
      const MAX_POD_PIXELS = 8.0e6;
      // The page can step the ratio down itself when the two GL contexts on the device start
      // competing (see watchQuality in powerpod-gen2.js). applySize runs on every resize, so
      // without somewhere to record that the next resize would quietly undo it.
      let ratioOverride = 0;
      const podPixelRatio = (w, h) => Math.min(
        ratioOverride || o.pixelRatio || Math.min(window.devicePixelRatio || 1, phone ? 1.5 : 2),
        Math.sqrt(MAX_POD_PIXELS / Math.max(1, w * h)),
      );

      function applySize() {
        sizeDirty = false;
        const w = Math.max(1, canvas.clientWidth);
        const h = Math.max(1, canvas.clientHeight);
        camera.aspect = w / h;
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(podPixelRatio(w, h));
        renderer.setSize(w, h, false);
        // A fresh buffer has nothing left on it, so the next frame has to be drawn whatever the
        // change test below would have said.
        drawnAt = null;
      }

      // ---------------------------------------------------------------- drawing on demand
      // Held on a shot, the only thing still moving is the caller's handheld drift, and that
      // shifts the image by a fraction of a pixel per frame. Redrawing millions of pixels for
      // that is what keeps the GPU warm with nothing happening on screen, so a frame is drawn
      // when it would actually differ from the one already on the canvas. Nothing else writes
      // here, so skipping leaves the last frame standing. A moving shot still draws every frame.
      //
      // The test asks where the pod lands on screen: four fixed points of it projected through
      // the live camera into device pixels, which catches orbit, dolly, roll and the lens shift
      // together without having to reason about any of them separately.
      const EPS_PX = 0.1;    // movement that counts as a new frame while the shot is moving
      const REST_PX = 0.002; // and the point below which it has stopped moving altogether
      const PROBES = [];
      const probeV = new THREE.Vector3();
      let probeNow = null;
      let probePrev = null;
      let drawnAt = null;

      (function buildProbes() {
        pod.updateMatrixWorld(true);
        mesh.geometry.computeBoundingSphere();
        const s = mesh.geometry.boundingSphere;
        const c = s.center.clone().applyMatrix4(pod.matrixWorld);
        PROBES.push(c.clone());
        for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
          PROBES.push(c.clone().addScaledVector(new THREE.Vector3(...axis), s.radius));
        }
        probeNow = new Float64Array(PROBES.length * 2);
      }());

      function maxDelta(a, b) {
        let m = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          if (d > m) m = d;
        }
        return m;
      }

      function wouldDiffer() {
        // place() writes camera.position and quaternion but leaves the matrices to the renderer,
        // and the renderer is exactly what we are deciding whether to call.
        camera.updateMatrixWorld();
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        const w = canvas.width;
        const h = canvas.height;
        for (let i = 0; i < PROBES.length; i++) {
          probeV.copy(PROBES[i]).project(camera);
          probeNow[i * 2] = (probeV.x * 0.5 + 0.5) * w;
          probeNow[i * 2 + 1] = (probeV.y * 0.5 + 0.5) * h;
        }
        if (!drawnAt) return true;
        const behind = maxDelta(probeNow, drawnAt);
        if (behind > EPS_PX) return true;
        // The shot has stopped within the tolerance rather than crossing it. Draw that last frame
        // exactly, so what is left standing is the composed shot and not something a fraction of
        // a pixel short of it.
        return behind > 0 && probePrev !== null && maxDelta(probeNow, probePrev) < REST_PX;
      }

      function drawIfChanged() {
        const differs = wouldDiffer();
        if (!probePrev) probePrev = new Float64Array(probeNow.length);
        probePrev.set(probeNow);
        if (!differs) return;
        renderer.render(scene, camera);
        if (!drawnAt) drawnAt = new Float64Array(probeNow.length);
        drawnAt.set(probeNow);
      }

      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        lost = true;
        if (typeof o.onContextLost === 'function') o.onContextLost();
      });

      const handle = {
        canvas, renderer, scene, camera, pod, mesh, HALF, BASE, ready: true,
        frameDist,
        place,
        // The explicit draw-now call, so it always draws: a caller reaching for this has changed
        // something the change test cannot see.
        render() {
          if (lost) return;
          if (sizeDirty) applySize();
          renderer.render(scene, camera);
          if (!drawnAt) drawnAt = new Float64Array(probeNow.length);
          wouldDiffer();
          drawnAt.set(probeNow);
        },
        setShot(shot, driftAz, driftEl, offset) {
          if (lost) return;
          if (sizeDirty) applySize();
          place(shot, driftAz, driftEl, offset);
          drawIfChanged();
        },
        resize() { sizeDirty = true; },
        // Pin the device pixel ratio below the default, and have it stay pinned across resizes.
        // Pass 0 to hand it back to the automatic choice.
        setPixelRatio(r) {
          ratioOverride = r > 0 ? r : 0;
          sizeDirty = true;
        },
        setOpacity(v) { canvas.style.opacity = String(v); },
        dispose() {
          handle.stop();
          mesh.geometry.dispose();
          scene.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
            for (const m of mats) {
              for (const k of ['map', 'roughnessMap']) if (m[k]) m[k].dispose();
              m.dispose();
            }
          });
          GRAIN.dispose();
          envRT.dispose();
          pm.dispose();
          renderer.dispose();
          if (renderer.forceContextLoss) renderer.forceContextLoss();
          handle.ready = false;
        },
        start() {
          if (!o.autoLoop || handle._raf) return;
          const tick = (now) => {
            handle._raf = requestAnimationFrame(tick);
            if (typeof o.onFrame === 'function') o.onFrame(now);
          };
          handle._raf = requestAnimationFrame(tick);
        },
        stop() {
          if (handle._raf) cancelAnimationFrame(handle._raf);
          handle._raf = 0;
        },
        _raf: 0,
      };

      applySize();

      // The first real render is where the driver builds a pipeline state for every material in
      // here and where three.js pushes the mesh and its textures to the GPU: about 35ms, and left
      // alone it lands on whichever frame first shows the pod. Do it at the first idle moment
      // instead, into a one pixel scissor, so none of it pays for a screenful of fill, and clear
      // afterwards so the canvas is left exactly as untouched as it was found. The pipeline
      // states do not depend on where the camera is, so no particular shot is needed.
      const warm = () => {
        if (lost) return;
        try {
          renderer.compile(scene, camera);
          renderer.setScissorTest(true);
          renderer.setScissor(0, 0, 1, 1);
          renderer.render(scene, camera);
          renderer.setScissorTest(false);
          renderer.clear();
          drawnAt = null;   // that was a one pixel stub, not a frame of the film
        } catch (err) {
          console.warn('[powerpod-3d] warm-up skipped:', err);
        }
      };
      if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 2000 });
      else setTimeout(warm, 600);

      return handle;
    } catch (err) {
      console.warn('[gridPod] 3D unavailable:', err);
      return null;
    }
  }

  window.gridPod = { mount, shotAt, smoother, clamp, remap01, mix };
})();
