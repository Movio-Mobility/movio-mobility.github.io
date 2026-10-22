#!/usr/bin/env node
/*
 * assets/three.min.js: three.js r128, with one change, so the PowerPod's shaders can compile
 * without stalling the page.
 *
 *   node tools/source/three.mjs          (npm run three)
 *
 * WHY. three.js r128 checks every program the instant it links (getProgramInfoLog, then
 * LINK_STATUS) and reads its uniform table straight after. Both are synchronous questions
 * the browser can only answer once the driver has finished compiling, so the page's main
 * thread, and the GPU process with it, stand still for as long as that takes: twenty to a
 * hundred milliseconds a material on a Mac with nothing cached, several times that on
 * Windows. The pod has eight programs, and on a first visit every one of those waits landed
 * in the home page's opening as a dropped frame or four (tools/perf/opening.mjs --cold).
 *
 * WHAT. The same thing three.js itself did in r159 (mrdoob/three.js #26913 and #26945):
 *   - WebGLProgram checks the link, and lets its shaders go, the first time the program is
 *     used (getUniforms / getAttributes) instead of in its constructor, and gains isReady(),
 *     which asks the driver whether it has finished (KHR_parallel_shader_compile) and never
 *     waits for it. Without the extension isReady() is true at once and everything behaves
 *     exactly as it did.
 *   - WebGLRenderer reads a material's uniform table the first time the material is drawn,
 *     not when its program is made, so renderer.compile() starts every link and waits for
 *     none. compile() returns the materials it touched, and the new compileAsync() resolves
 *     once all of their programs are ready, polling between pauses the caller provides.
 * Nothing else changes: the shaders, the uniform tables and the draws are byte for byte what
 * r128 produced; only when the questions are asked moves.
 *
 * HOW. The pristine r128 build (build/three.js from npm, pinned by its hash) is fetched into
 * tools/source/.three-cache/ the first time, patched by the exact-text replacements below
 * (each must match exactly once, so a different three.js fails loudly rather than silently
 * shipping unpatched), minified with esbuild and written to assets/three.min.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.three-cache');
const VERSION = '0.128.0';
const SOURCE_URL = `https://cdn.jsdelivr.net/npm/three@${VERSION}/build/three.js`;
const SOURCE_SHA256 = 'ffb3e7d06010b75b3ab9ee862085e75073f028986116e454615fdfe69dd66084';
const OUT = path.join(REPO, 'assets/three.min.js');

async function pristine() {
  fs.mkdirSync(CACHE, { recursive: true });
  const local = path.join(CACHE, `three-${VERSION}.js`);
  if (!fs.existsSync(local)) {
    console.log(`fetching ${SOURCE_URL}`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`could not fetch three.js ${VERSION}: HTTP ${res.status}`);
    fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  }
  const code = fs.readFileSync(local, 'utf8');
  const sha = crypto.createHash('sha256').update(code).digest('hex');
  if (sha !== SOURCE_SHA256) throw new Error(`${local} is not the expected three.js ${VERSION} build (sha256 ${sha})`);
  return code;
}

/** Replaces `from` with `to` in code, insisting it occurs exactly once. */
function replaceOnce(code, name, from, to) {
  const first = code.indexOf(from);
  if (first < 0) throw new Error(`patch "${name}": text not found`);
  if (code.indexOf(from, first + 1) >= 0) throw new Error(`patch "${name}": text found more than once`);
  return code.slice(0, first) + to + code.slice(first + from.length);
}

export function patch(code) {
  let out = code;

  // 1. WebGLProgram: the link check and the shader clean-up move out of the constructor into
  //    onFirstUse(); isReady() asks the driver without waiting.
  out = replaceOnce(out, 'WebGLProgram: link',
`		gl.linkProgram(program); // check for link errors

		if (renderer.debug.checkShaderErrors) {
			const programLog = gl.getProgramInfoLog(program).trim();
			const vertexLog = gl.getShaderInfoLog(glVertexShader).trim();
			const fragmentLog = gl.getShaderInfoLog(glFragmentShader).trim();
			let runnable = true;
			let haveDiagnostics = true;

			if (gl.getProgramParameter(program, gl.LINK_STATUS) === false) {
				runnable = false;
				const vertexErrors = getShaderErrors(gl, glVertexShader, 'vertex');
				const fragmentErrors = getShaderErrors(gl, glFragmentShader, 'fragment');
				console.error('THREE.WebGLProgram: shader error: ', gl.getError(), 'gl.VALIDATE_STATUS', gl.getProgramParameter(program, gl.VALIDATE_STATUS), 'gl.getProgramInfoLog', programLog, vertexErrors, fragmentErrors);
			} else if (programLog !== '') {
				console.warn('THREE.WebGLProgram: gl.getProgramInfoLog()', programLog);
			} else if (vertexLog === '' || fragmentLog === '') {
				haveDiagnostics = false;
			}

			if (haveDiagnostics) {
				this.diagnostics = {
					runnable: runnable,
					programLog: programLog,
					vertexShader: {
						log: vertexLog,
						prefix: prefixVertex
					},
					fragmentShader: {
						log: fragmentLog,
						prefix: prefixFragment
					}
				};
			}
		} // Clean up
		// Crashes in iOS9 and iOS10. #18402
		// gl.detachShader( program, glVertexShader );
		// gl.detachShader( program, glFragmentShader );


		gl.deleteShader(glVertexShader);
		gl.deleteShader(glFragmentShader); // set up caching for uniform locations

		let cachedUniforms;
`,
`		gl.linkProgram(program);

		// GridX (tools/source/three.mjs): the link is checked, and the shaders let go, the first
		// time the program is used rather than here, so starting a link never waits on the
		// driver. isReady() says when it has finished (KHR_parallel_shader_compile); without the
		// extension it is true at once and the first use waits, as the constructor used to.
		const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
		let programReady = parallelCompile === null;
		let firstUseDone = false;

		function onFirstUse(self) {
			if (firstUseDone) return;
			firstUseDone = true;

			if (renderer.debug.checkShaderErrors) {
				const programLog = gl.getProgramInfoLog(program).trim();
				const vertexLog = gl.getShaderInfoLog(glVertexShader).trim();
				const fragmentLog = gl.getShaderInfoLog(glFragmentShader).trim();
				let runnable = true;
				let haveDiagnostics = true;

				if (gl.getProgramParameter(program, gl.LINK_STATUS) === false) {
					runnable = false;
					const vertexErrors = getShaderErrors(gl, glVertexShader, 'vertex');
					const fragmentErrors = getShaderErrors(gl, glFragmentShader, 'fragment');
					console.error('THREE.WebGLProgram: shader error: ', gl.getError(), 'gl.VALIDATE_STATUS', gl.getProgramParameter(program, gl.VALIDATE_STATUS), 'gl.getProgramInfoLog', programLog, vertexErrors, fragmentErrors);
				} else if (programLog !== '') {
					console.warn('THREE.WebGLProgram: gl.getProgramInfoLog()', programLog);
				} else if (vertexLog === '' || fragmentLog === '') {
					haveDiagnostics = false;
				}

				if (haveDiagnostics) {
					self.diagnostics = {
						runnable: runnable,
						programLog: programLog,
						vertexShader: {
							log: vertexLog,
							prefix: prefixVertex
						},
						fragmentShader: {
							log: fragmentLog,
							prefix: prefixFragment
						}
					};
				}
			} // Clean up
			// Crashes in iOS9 and iOS10. #18402
			// gl.detachShader( program, glVertexShader );
			// gl.detachShader( program, glFragmentShader );


			gl.deleteShader(glVertexShader);
			gl.deleteShader(glFragmentShader);
		}

		this.isReady = function () {
			if (programReady === false) {
				programReady = gl.getProgramParameter(program, parallelCompile.COMPLETION_STATUS_KHR);
			}

			return programReady;
		}; // set up caching for uniform locations


		let cachedUniforms;
`);

  // 2. The uniform and attribute tables are read at first use, after the link is checked.
  out = replaceOnce(out, 'WebGLProgram: getUniforms',
`		this.getUniforms = function () {
			if (cachedUniforms === undefined) {
				cachedUniforms = new WebGLUniforms(gl, program);
			}
`,
`		this.getUniforms = function () {
			if (cachedUniforms === undefined) {
				onFirstUse(this);
				cachedUniforms = new WebGLUniforms(gl, program);
			}
`);
  out = replaceOnce(out, 'WebGLProgram: getAttributes',
`		this.getAttributes = function () {
			if (cachedAttributes === undefined) {
				cachedAttributes = fetchAttributeLocations(gl, program);
			}
`,
`		this.getAttributes = function () {
			if (cachedAttributes === undefined) {
				onFirstUse(this);
				cachedAttributes = fetchAttributeLocations(gl, program);
			}
`);
  // A program destroyed before it was ever used still has its shaders attached: let them go.
  out = replaceOnce(out, 'WebGLProgram: destroy',
`		this.destroy = function () {
			bindingStates.releaseStatesOfProgram(this);
			gl.deleteProgram(program);
			this.program = undefined;
		};`,
`		this.destroy = function () {
			bindingStates.releaseStatesOfProgram(this);
			gl.deleteProgram(program);
			if (firstUseDone === false) {
				gl.deleteShader(glVertexShader);
				gl.deleteShader(glFragmentShader);
			}
			this.program = undefined;
		};`);

  // 3. WebGLRenderer: the material's uniform list is built the first time it is drawn.
  out = replaceOnce(out, 'WebGLRenderer: getProgram',
`			const progUniforms = program.getUniforms();
			const uniformsList = WebGLUniforms.seqWithValue(progUniforms.seq, uniforms);
			materialProperties.currentProgram = program;
			materialProperties.uniformsList = uniformsList;
			return program;
		}
`,
`			materialProperties.currentProgram = program;
			materialProperties.uniformsList = null;
			return program;
		} // GridX (tools/source/three.mjs): the uniform table is read the first time the material
		// is drawn, by when its program has linked, rather than the moment the program is made.


		function getUniformList(materialProperties) {
			if (materialProperties.uniformsList === null) {
				const progUniforms = materialProperties.currentProgram.getUniforms();
				materialProperties.uniformsList = WebGLUniforms.seqWithValue(progUniforms.seq, materialProperties.uniforms);
			}

			return materialProperties.uniformsList;
		}
`);
  out = replaceOnce(out, 'WebGLRenderer: setProgram upload',
`				materials.refreshMaterialUniforms(m_uniforms, material, _pixelRatio, _height);
				WebGLUniforms.upload(_gl, materialProperties.uniformsList, m_uniforms, textures);
			}

			if (material.isShaderMaterial && material.uniformsNeedUpdate === true) {
				WebGLUniforms.upload(_gl, materialProperties.uniformsList, m_uniforms, textures);
				material.uniformsNeedUpdate = false;
			}`,
`				materials.refreshMaterialUniforms(m_uniforms, material, _pixelRatio, _height);
				WebGLUniforms.upload(_gl, getUniformList(materialProperties), m_uniforms, textures);
			}

			if (material.isShaderMaterial && material.uniformsNeedUpdate === true) {
				WebGLUniforms.upload(_gl, getUniformList(materialProperties), m_uniforms, textures);
				material.uniformsNeedUpdate = false;
			}`);

  // 4. compile() returns the materials it touched; compileAsync() waits for their programs.
  out = replaceOnce(out, 'WebGLRenderer: compile',
`		this.compile = function (scene, camera) {
			currentRenderState = renderStates.get(scene);
			currentRenderState.init();
			scene.traverseVisible(function (object) {
				if (object.isLight && object.layers.test(camera.layers)) {
					currentRenderState.pushLight(object);

					if (object.castShadow) {
						currentRenderState.pushShadow(object);
					}
				}
			});
			currentRenderState.setupLights();
			scene.traverse(function (object) {
				const material = object.material;

				if (material) {
					if (Array.isArray(material)) {
						for (let i = 0; i < material.length; i++) {
							const material2 = material[i];
							getProgram(material2, scene, object);
						}
					} else {
						getProgram(material, scene, object);
					}
				}
			});
		}; // Animation Loop`,
`		this.compile = function (scene, camera) {
			const materials = new Set(); // GridX (tools/source/three.mjs): returned, for compileAsync()

			currentRenderState = renderStates.get(scene);
			currentRenderState.init();
			scene.traverseVisible(function (object) {
				if (object.isLight && object.layers.test(camera.layers)) {
					currentRenderState.pushLight(object);

					if (object.castShadow) {
						currentRenderState.pushShadow(object);
					}
				}
			});
			currentRenderState.setupLights();
			scene.traverse(function (object) {
				const material = object.material;

				if (material) {
					if (Array.isArray(material)) {
						for (let i = 0; i < material.length; i++) {
							const material2 = material[i];
							getProgram(material2, scene, object);
							materials.add(material2);
						}
					} else {
						getProgram(material, scene, object);
						materials.add(material);
					}
				}
			});
			return materials;
		}; // GridX (tools/source/three.mjs): compile() without waiting. Starts every link the scene
		// needs and resolves once the driver has finished them all, asking between pauses rather
		// than waiting: wait() returns a promise for the next pause (a short timer by default).
		// Any error a program has is reported the first time it is drawn, as a late link would be.


		this.compileAsync = function (scene, camera, wait) {
			const materials = this.compile(scene, camera);
			const pause = wait || function () {
				return new Promise(function (resolve) {
					setTimeout(resolve, 10);
				});
			};
			return new Promise(function (resolve) {
				function check() {
					materials.forEach(function (material) {
						const program = properties.get(material).currentProgram;

						if (program === undefined || program.isReady()) {
							materials.delete(material);
						}
					});

					if (materials.size === 0) {
						resolve(scene);
						return;
					}

					pause().then(check);
				}

				check();
			});
		}; // Animation Loop`);

  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = patch(await pristine());
  const min = esbuild.transformSync(code, { loader: 'js', minify: true, legalComments: 'none', charset: 'utf8', sourcefile: 'three.js' }).code;
  // three.js's own licence block, as its build carries it, then a line saying what this copy is.
  const licence = code.slice(0, code.indexOf('*/') + 2);
  if (!licence.includes('@license')) throw new Error('three.js licence block not found');
  const banner = `${licence}\n// three.js r${VERSION.split('.')[1]}, patched to compile shaders without waiting on them: tools/source/three.mjs\n`;
  fs.writeFileSync(OUT, banner + min);
  console.log(`${path.relative(REPO, OUT)}: ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
}
