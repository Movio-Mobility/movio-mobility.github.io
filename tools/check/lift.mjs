#!/usr/bin/env node
/*
 * The lift scene's particle drawing, outside the browser: how long it takes to build, whether
 * two versions of index.html build exactly the same points, and whether her outline holds
 * together.
 *
 *   node tools/check/lift.mjs                         time and check the working copy
 *   node tools/check/lift.mjs <old index.html>        also compare against an older copy
 *
 * liftFilm in index.html is self-contained, so it is cut out of the page and run as is. The
 * states fed to it follow liftState() in the page: a sweep along the cut as a reader scrolls,
 * then a stretch parked on the ride with only the motes moving, which is what used to rebuild
 * the whole drawing every frame.
 *
 * Her outline, through the walk: the seat runs on into the back of the near thigh as one line
 * (the two meet at the same point and heading), and her back, from the shoulder blade down to
 * the seat, never thins below a strength that reads as a line, under her hair or anywhere else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

function loadLiftFilm(file) {
  const html = fs.readFileSync(file, 'utf8');
  const start = html.indexOf('const liftFilm = (() => {');
  if (start < 0) throw new Error(`no liftFilm in ${file}`);
  const end = html.indexOf('\n    })();', start);
  const src = html.slice(start, end + '\n    })();'.length);
  return new Function(`${src}\nreturn liftFilm;`)();
}

// liftState() and its cut, as in index.html.
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const remap01 = (t, a, b) => Math.min(1, Math.max(0, (t - a) / Math.max(1e-6, b - a)));
const LIFTCUT = {
  transfer: [5.45, 5.90], gather: [5.70, 5.95], count: [5.95, 6.28], ding: [6.26, 6.40], open: [6.30, 6.55],
  walk: [6.55, 6.95], close: [6.95, 7.10], ride: [7.18, 7.50], rise: [7.45, 7.72], release: [7.68, 7.92],
};
const inCut = (t, r) => remap01(t, r[0], r[1]);
const rideSpeed = (t) => smoother(inCut(t, LIFTCUT.ride)) * (1 - smoother(inCut(t, LIFTCUT.release)));
function liftState(t, rideClock) {
  const countDown = ['3', '2', '1', 'G'];
  const countUp = ['G', '1', '2', '3', '4', '5'];
  let digit = '3';
  let arrow = 'down';
  if (t >= LIFTCUT.count[0]) digit = countDown[Math.min(3, Math.floor(inCut(t, LIFTCUT.count) * 4))];
  if (t >= LIFTCUT.ding[0]) arrow = null;
  if (t >= LIFTCUT.ride[0]) {
    arrow = 'up';
    digit = countUp[Math.min(5, Math.floor(Math.pow(inCut(t, LIFTCUT.ride), 0.62) * 6))];
  }
  const motesIn = smoother(remap01(t, LIFTCUT.ride[0] - 0.02, LIFTCUT.ride[0] + 0.08));
  return {
    walk: inCut(t, LIFTCUT.walk),
    doors: smoother(inCut(t, LIFTCUT.open)) * (1 - smoother(inCut(t, LIFTCUT.close))),
    light: smoother(remap01(t, LIFTCUT.open[0], LIFTCUT.open[0] + 0.2)),
    ding: Math.sin(Math.PI * inCut(t, LIFTCUT.ding)),
    arrow,
    digit,
    motes: { clock: rideClock, speed: rideSpeed(t), vis: motesIn * (1 - smoother(inCut(t, LIFTCUT.release))) },
    rise: 2.1 * Math.pow(inCut(t, LIFTCUT.rise), 2.2),
  };
}

// A reader scrolling through the cut (one frame per step), then parked on the ride.
function states() {
  const out = [];
  let clock = 0;
  for (let t = LIFTCUT.gather[0]; t < LIFTCUT.release[1] + 0.3; t += 0.0025) {
    clock += (1 / 60) * (0.12 + 1.5 * rideSpeed(t));
    out.push(liftState(t, clock));
  }
  for (let i = 0; i < 240; i++) {
    clock += (1 / 60) * (0.12 + 1.5 * rideSpeed(7.4));
    out.push(liftState(7.4, clock));
  }
  return out;
}

// Older pages return an array of [x, y, visibility, depth] arrays; newer ones a flat buffer
// that is reused from call to call, so it is copied out here (outside the timing).
function flatten(r) {
  if (!Array.isArray(r.points)) return Float64Array.from(r.points.subarray(0, r.count * 4));
  const a = new Float64Array(r.points.length * 4);
  r.points.forEach((p, i) => a.set(p, i * 4));
  return a;
}

function run(film, count, list) {
  const alloc = film.allocation(count);
  const results = [];
  let ms = 0;
  for (const st of list) {
    const t0 = performance.now();
    const r = film.points(st, alloc);
    ms += performance.now() - t0;
    results.push(flatten(r));
  }
  return { ms, results };
}

const list = states();
const scrollFrames = list.length - 240;
const current = loadLiftFilm(path.join(REPO, 'index.html'));
const old = process.argv[2] ? loadLiftFilm(path.resolve(process.argv[2])) : null;

for (const count of [2000, 8000, 12000]) {
  // Warm both up first, so the JIT is not part of either number.
  run(current, count, list.slice(0, 50));
  if (old) run(old, count, list.slice(0, 50));
  const a = run(current, count, list);
  let line = `capacity ${count}: new ${(a.ms / list.length).toFixed(3)} ms/frame`;
  if (old) {
    const b = run(old, count, list);
    line += `, old ${(b.ms / list.length).toFixed(3)} ms/frame`;
    let mismatches = 0;
    let first = -1;
    for (let i = 0; i < list.length; i++) {
      const x = a.results[i];
      const y = b.results[i];
      let same = x.length === y.length;
      for (let k = 0; same && k < x.length; k++) if (!Object.is(x[k], y[k])) same = false;
      if (!same) {
        mismatches++;
        if (first < 0) first = i;
      }
    }
    line += mismatches ? `, MISMATCH on ${mismatches} of ${list.length} frames (first at frame ${first})` : `, identical on all ${list.length} frames`;
    if (mismatches) process.exitCode = 1;
  }
  console.log(line);
}
console.log(`(${scrollFrames} frames scrolling through the cut, then 240 parked on the ride)`);

// ---------------------------------------------------------------- her outline
const report = (label, ok, detail) => {
  if (!ok) process.exitCode = 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
};
if (current.her) {
  const WALKS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.85, 1];
  // The lines that make her back: her torso's, either arm's and either leg's. Her hair is
  // drawn over it, and is left out: the question is whether her body's own line holds.
  const BODY = /^(torsoBack|armBack|farArmBack|nearBack|farBack)$/;
  let gap = 0;
  let turn = 0;
  let weakest = Infinity;
  let weakAt = '';
  for (const w of WALKS) {
    const strokes = current.her(w, 2000);
    const line = (name) => strokes.find((s) => s[0] === name)[1];
    // Where the seat hands over to the thigh: the same point, the same heading.
    const seat = line('torsoBack');
    const thigh = line('nearBack');
    const end = seat[seat.length - 1];
    const before = seat[seat.length - 3];
    gap = Math.max(gap, Math.hypot(end[0] - thigh[0][0], end[1] - thigh[0][1]) * 1000);
    let d = Math.abs(Math.atan2(end[1] - before[1], end[0] - before[0]) - Math.atan2(thigh[2][1] - thigh[0][1], thigh[2][0] - thigh[0][0]));
    if (d > Math.PI) d = 2 * Math.PI - d;
    turn = Math.max(turn, (d * 180) / Math.PI);
    // Her back's line, a centimetre at a time from the seat to the shoulder blade: the
    // brightest point within 2.5 cm of the rearmost one at that height.
    const hip = current.pose(w).hip;
    const rows = new Map();
    for (const [name, , pts] of strokes) {
      if (!BODY.test(name)) continue;
      for (let i = 0; i < pts.length; i += 4) {
        const y = pts[i + 1] - hip[1];
        if (y < -0.03 || y > 0.55) continue;
        const k = Math.round(y / 0.01);
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k).push([pts[i], pts[i + 2]]);
      }
    }
    for (const [k, row] of rows) {
      const back = Math.min(...row.map((p) => p[0]));
      const strongest = Math.max(...row.filter((p) => p[0] < back + 0.025).map((p) => p[1]));
      if (strongest < weakest) {
        weakest = strongest;
        weakAt = `walk ${w}, ${(k / 100).toFixed(2)} m above the hip`;
      }
    }
  }
  report('her seat runs on into her thigh', gap < 0.5 && turn < 5, `apart by ${gap.toFixed(2)} mm, headings ${turn.toFixed(1)} degrees`);
  report('her back is one line', weakest >= 0.45, `weakest ${weakest.toFixed(2)} (${weakAt})`);
}
