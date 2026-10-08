/*
 * GridX PowerPod assets
 * ---------------------
 * Everything the 3D PowerPod needs, fetched without holding the page up: three.js as an async
 * script, the mesh as a gzipped binary (assets/powerpod.bin.gz, see tools/build-model.mjs) and
 * the wordmark as an ordinary PNG. They download in parallel at low priority, while the
 * opening plays, instead of as 1.7 MB of script the parser has to stop for.
 *
 *   GridPodAssets.load()                 → Promise<{ THREE, model, logoUrl }>
 *   GridPodAssets.geometry(THREE, model) → the pod's BufferGeometry, exactly as decode() built
 *                                          it from the old base64 globals
 *
 * Used by the home page's film (index.html) and the Gen 2 page (assets/powerpod-3d.js).
 *
 * Opened straight from disk (file://), a browser will not fetch() a local file and will not let
 * WebGL read a local image, though it still runs a local script. There the model and the logo
 * come from assets/powerpod-model.js instead (the same bytes, base64), as does any page whose
 * fetch fails.
 */
(() => {
  'use strict';
  if (window.GridPodAssets) return;

  // Page-relative, like every other asset path on the site (all pages sit at the root).
  const THREE_URL = 'assets/three.min.js';
  const MODEL_URL = 'assets/powerpod.bin.gz';
  const MODEL_RAW_URL = 'assets/powerpod.bin';
  const LOGO_URL = 'assets/powerpod-logo.png';
  const SCRIPT_URL = 'assets/powerpod-model.js';
  const FROM_DISK = location.protocol === 'file:';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  const inflate = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();

  // The script copy: the gzipped model as base64, and the logo as a data URL.
  async function fromScript() {
    if (!window.GridPodModel) await loadScript(SCRIPT_URL);
    const { gz, logo } = window.GridPodModel;
    const text = atob(gz);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return { buffer: await inflate(bytes), logo };
  }

  let threeLoading = null;
  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (!threeLoading) {
      threeLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = THREE_URL;
        s.async = true;
        if ('fetchPriority' in s) s.fetchPriority = 'low';
        s.onload = () => (window.THREE ? resolve(window.THREE) : reject(new Error('three.js loaded without THREE')));
        s.onerror = () => reject(new Error(`could not load ${THREE_URL}`));
        document.head.appendChild(s);
      });
    }
    return threeLoading;
  }

  // GitHub Pages serves .gz as an opaque file and never compresses unknown types itself, so
  // the page inflates the model. A server that does decode it on the way (Content-Encoding)
  // hands over the raw bytes instead, which the magic number tells apart.
  async function fetchModel() {
    if (typeof DecompressionStream !== 'function') {
      const raw = await fetch(MODEL_RAW_URL, { priority: 'low' });
      if (!raw.ok) throw new Error(`could not load ${MODEL_RAW_URL}`);
      return { buffer: await raw.arrayBuffer(), logo: LOGO_URL };
    }
    if (FROM_DISK) return fromScript();
    try {
      const res = await fetch(MODEL_URL, { priority: 'low' });
      if (!res.ok) throw new Error(`could not load ${MODEL_URL}`);
      const buf = await res.arrayBuffer();
      const head = new Uint8Array(buf, 0, 2);
      if (head[0] !== 0x1f || head[1] !== 0x8b) return { buffer: buf, logo: LOGO_URL };
      return { buffer: await inflate(buf), logo: LOGO_URL };
    } catch (err) {
      // A host or a proxy that will not hand the file over: the script copy still gets through.
      return fromScript();
    }
  }

  // The header carries the quantisation and where each array starts; the arrays are views
  // straight onto the downloaded bytes.
  function parseModel(buffer) {
    const length = new DataView(buffer).getUint32(0, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
    return {
      lo: h.lo, sc: h.sc, nv: h.nv, nf: h.nf, split: h.split,
      pos: new Uint16Array(buffer, h.pos, h.nv * 3),
      nor: new Int8Array(buffer, h.nor, h.nv * 3),
      idx: new Uint16Array(buffer, h.idx, h.nf * 3),
    };
  }

  // The same arithmetic, in the same order, as the decode() the pod used to run on the base64:
  // positions dequantised per axis, normals from signed bytes, UVs from position, two groups
  // (the moulded caps, then the aluminium body).
  function geometry(THREE, m) {
    const n = m.nv * 3;
    const pos = new Float32Array(n);
    for (let i = 0; i < n; i++) pos[i] = m.lo[i % 3] + m.pos[i] * m.sc[i % 3];
    const nor = new Float32Array(n);
    for (let i = 0; i < n; i++) nor[i] = m.nor[i] / 127;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    const uv = new Float32Array(m.nv * 2);
    for (let i = 0; i < m.nv; i++) {
      uv[i * 2] = pos[i * 3] * 0.01;
      uv[i * 2 + 1] = pos[i * 3 + 1] * 0.01;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(m.idx), 1));
    g.addGroup(0, m.split * 3, 0);
    g.addGroup(m.split * 3, (m.nf - m.split) * 3, 1);
    g.computeBoundingBox();
    return g;
  }

  let loading = null;
  function load() {
    if (!loading) {
      // The logo starts too, so its texture is a cache hit by the time the pod asks for it.
      if (!FROM_DISK) {
        const logo = new Image();
        logo.decoding = 'async';
        logo.src = LOGO_URL;
      }
      loading = Promise.all([loadThree(), fetchModel()])
        .then(([THREE, m]) => ({ THREE, model: parseModel(m.buffer), logoUrl: m.logo }));
    }
    return loading;
  }

  window.GridPodAssets = { load, geometry, logoUrl: LOGO_URL };
})();
