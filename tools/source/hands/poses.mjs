// The hands for the app beat's demos (index.html, "Tap to experience"), as capsules.
//
// One hand, the same one the film draws on the grip ("Made to be lifted."): its bones, lengths
// and radii are gripHand's REACH rig in index.html, in millimetres. Here it is posed for a phone
// instead of the bar, and handed to hands.html as round cones to ray-march.
//
// World frame, in millimetres: the phone's face, seen straight on, as the film shows it. Its
// centre is the origin, x to the right, y up, z out of the glass toward the viewer. The phone
// (iPhone 17 Pro Max, 78 x 163.4 x 8.25) fills x in [-39, 39], y in [-81.7, 81.7], with its glass
// at z = 0 and its back at z = -8.25. The page lays it out at 471 x 987 points, so a millimetre is
// 987 / 163.4 points.
//
// Hand frame, for a right hand: the wrist's centre is the origin, +y runs to the knuckles, +x
// toward the little finger, +z out of the back of the hand. A finger flexes toward -z, its
// palm. A left hand is the right one mirrored in x.

export const PHONE = { w: 78, h: 163.4, depth: 8.25, pts: 987 / 163.4 };

const rad = (d) => (d * Math.PI) / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scale(a, 1 / len(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Rodrigues: v turned by angle about the unit axis k.
function turn(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const kv = cross(k, v);
  const d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [v[0] * c + kv[0] * s + k[0] * d * (1 - c), v[1] * c + kv[1] * s + k[1] * d * (1 - c), v[2] * c + kv[2] * s + k[2] * d * (1 - c)];
}

// gripHand's REACH rig (index.html), index to little. `x` is the knuckle's place across the
// palm (gripHand's q, its sign turned so +x runs toward the little finger), `y` its place along
// it, below the middle knuckle's line by `drop`; three bones and the radius at the knuckle, the
// two joints and the tip.
const FINGERS = [
  { x: -24.5, drop: 1.0, len: [40, 23, 19], r: [9.3, 8.6, 7.6, 6.7] },
  { x: -7.8, drop: 0.0, len: [44, 27, 20], r: [9.5, 8.8, 7.8, 6.8] },
  { x: 8.6, drop: 1.0, len: [41, 26, 19], r: [9.1, 8.4, 7.4, 6.5] },
  { x: 24.0, drop: 3.5, len: [33, 19, 17], r: [8.2, 7.5, 6.6, 5.8] },
];
const KNUCKLE = 1.12;
const PALM = { len: 66, narrow: 0.36, rKnuckle: 10.0, rWrist: 13.5 };
// The thumb: its base at the heel of the hand, its metacarpal and two bones, and four radii.
const THUMB = { base: [-19, 12, -7], meta: 44, len: [31, 24], r: [13.0, 12.0, 10.4, 8.6] };
const ARM = { r: [25, 31], len: 210 };

/**
 * A hand in its own frame, posed.
 *   spread   each finger's splay from the palm's line, degrees, + toward the little finger
 *   flex     each finger's three flexions, degrees
 *   thumb    { dir: its metacarpal's direction, flex: [mcp, ip] degrees, roll: degrees about
 *            the metacarpal, which turns which way the thumb bends }
 *   wrist    { flex, dev } the hand bent at the wrist against the forearm: flex toward the palm,
 *            dev toward the little finger, degrees
 */
function handLocal(pose) {
  const cones = [];
  const add3 = (a, b, ra, rb, group) => cones.push({ a, b, ra, rb, group });

  // The knuckles arch: the middle sits furthest out, the little lowest.
  const knuckles = FINGERS.map((f) => [f.x, PALM.len - f.drop, 0]);

  // Fingers: groups 2 to 5.
  FINGERS.forEach((f, i) => {
    const spread = rad(pose.spread[i]);
    const u = [Math.sin(spread), Math.cos(spread), 0];
    const axis = unit(cross([0, 0, 1], u)); // flexing turns u toward -z about this
    let p = knuckles[i];
    let angle = 0;
    // A knuckle's bump, a little proud of the finger.
    add3(p, p, f.r[0] * KNUCKLE, f.r[0] * KNUCKLE, 2 + i);
    for (let j = 0; j < 3; j++) {
      angle += rad(pose.flex[i][j]);
      const d = turn(u, axis, angle);
      const q = add(p, scale(d, f.len[j]));
      add3(p, q, f.r[j], f.r[j + 1], 2 + i);
      p = q;
    }
  });

  // The palm: a metacarpal from the wrist to each knuckle, drawn together toward the wrist,
  // and a flat block filling between them. Group 0.
  knuckles.forEach((k, i) => {
    add3([k[0] * PALM.narrow, 6, -2], k, PALM.rWrist, PALM.rKnuckle, 0);
  });
  add3([-14, 22, -3], [14, 22, -3], 13.5, 13.5, 0);
  add3([-17, 42, -2], [17, 42, -2], 12, 12, 0);
  // The heel of the thumb.
  add3([-14, 14, -8], add(THUMB.base, [-2, 14, 0]), 14, 12.5, 0);

  // The thumb: group 6.
  {
    const t0 = unit(pose.thumb.dir);
    // It bends toward the palm, about an axis across its metacarpal, rolled as the pose says.
    let axis = unit(cross(t0, [0, 0, -1]));
    axis = turn(axis, t0, rad(pose.thumb.roll || 0));
    let p = THUMB.base;
    const mcp = add(p, scale(t0, THUMB.meta));
    add3(p, mcp, THUMB.r[0], THUMB.r[1], 6);
    p = mcp;
    let angle = 0;
    for (let j = 0; j < 2; j++) {
      angle += rad(pose.thumb.flex[j]);
      const d = turn(t0, axis, angle);
      const q = add(p, scale(d, THUMB.len[j]));
      add3(p, q, THUMB.r[j + 1], THUMB.r[j + 2], 6);
      p = q;
    }
  }

  // The wrist bends the hand against the forearm: everything above is turned about the wrist,
  // and the forearm is laid on afterwards along -y. Group 1.
  const wf = rad(pose.wrist?.flex || 0), wd = rad(pose.wrist?.dev || 0);
  const bend = (v) => turn(turn(v, [1, 0, 0], -wf), [0, 0, 1], -wd);
  for (const c of cones) { c.a = bend(c.a); c.b = bend(c.b); }
  add3([0, 0, -2], [0, -ARM.len, -2], ARM.r[0], ARM.r[1], 1);
  return cones;
}

// Lay a hand into the world: optionally mirrored to a left hand, turned by the rotations in
// order (each [axis, degrees], about world axes), then moved.
function place(cones, { left = false, rotations = [], at = [0, 0, 0] }) {
  const m = (v) => (left ? [-v[0], v[1], v[2]] : v);
  const r = (v) => rotations.reduce((acc, [axis, deg]) => turn(acc, unit(axis), rad(deg)), v);
  const t = (v) => add(r(m(v)), at);
  return cones.map((c) => ({ ...c, a: t(c.a), b: t(c.b) }));
}

// Where a cone's tip is: the end of the index finger's last bone, its pad's centre.
const indexTip = (cones) => cones.filter((c) => c.group === 2).at(-1);

// ---------------------------------------------------------------- the poses

// The right hand pointing: index out and nearly straight, the others curled into the palm, the
// thumb laid along the curled middle finger.
const POINT = {
  spread: [-4, 2, 6, 10],
  flex: [[6, 10, 6], [78, 98, 58], [84, 100, 56], [88, 98, 52]],
  thumb: { dir: [0.06, 0.8, -0.6], flex: [18, 22], roll: -90 },
  wrist: { flex: -8, dev: 0 },
};
// Pressing: the fingertip gives, so the last two joints bend a little more.
const PRESS = {
  ...POINT,
  flex: [[9, 18, 16], ...POINT.flex.slice(1)],
};

// The right hand comes up from below-right with the back of the hand to the camera, pitched so
// the index points down into the glass, its pad touching at the world origin.
function rightHand(pose) {
  const local = handLocal(pose);
  const placed = place(local, {
    rotations: [
      [[1, 0, 0], -38],  // pitch: the fingers dive toward the glass
      [[0, 0, 1], 38],   // in the screen's plane: reaching up and to the left
    ],
  });
  // Move it so the index pad's underside touches the glass at the origin.
  const tip = indexTip(placed);
  const shift = [-tip.b[0], -tip.b[1], -tip.b[2] + tip.rb];
  return place(placed, { at: shift });
}

export const SCENES = {
  'hand-right-hover': () => ({ cones: rightHand(POINT), kind: 'right' }),
  'hand-right-press': () => ({ cones: rightHand(PRESS), kind: 'right' }),
};
