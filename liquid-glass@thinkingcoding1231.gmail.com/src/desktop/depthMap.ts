// The map the glass clock hides behind: for every point of the monitor, how
// near the wallpaper is there (red) and whether its subject is there (green).
// Plain arrays only, so the worker, the shell and the tests share it.

/** The picture-options the map can be made for; "wallpaper" tiles and "none" shows no picture. */
export type PictureStyle = 'zoom' | 'scaled' | 'stretched' | 'centered' | 'spanned';

export interface DepthMap {
  width: number;
  height: number;
  // RGBA: nearness, subject, 0, 255.
  pixels: Uint8Array;
}

/** What the clock hides behind, for where it is. */
export interface Occlusion {
  // The clock is behind everything nearer than this (0 to 1); above 1 for nothing.
  threshold: number;
  // The clock is behind the wallpaper's subject.
  subject: boolean;
}

export const NO_OCCLUSION: Occlusion = { threshold: 2, subject: false };

const MAGIC = [0x4c, 0x47, 0x44, 0x4d];
const HEADER = 8;

/** The map's long side, px. */
export const MAP_SIZE = 1280;

export function encodeDepthMap(map: DepthMap): Uint8Array {
  const out = new Uint8Array(HEADER + map.pixels.length);
  out.set(MAGIC);
  out[4] = map.width & 0xff;
  out[5] = map.width >> 8;
  out[6] = map.height & 0xff;
  out[7] = map.height >> 8;
  out.set(map.pixels, HEADER);
  return out;
}

/** The map in a cache file's bytes, or null when they are something else. */
export function decodeDepthMap(bytes: Uint8Array): DepthMap | null {
  if (bytes.length < HEADER || MAGIC.some((v, i) => bytes[i] !== v)) return null;
  const width = bytes[4] | (bytes[5] << 8), height = bytes[6] | (bytes[7] << 8);
  if (bytes.length !== HEADER + width * height * 4) return null;
  return { width, height, pixels: bytes.subarray(HEADER) };
}

/** The map's size for a monitor of w x h. */
export function mapSize(w: number, h: number): [number, number] {
  const scale = MAP_SIZE / Math.max(w, h);
  return [Math.max(Math.round(w * scale), 1), Math.max(Math.round(h * scale), 1)];
}

/**
 * Where a picture of iw x ih lands on a monitor of w x h, as the shell places
 * it: [x, y, width, height]. `centered` shows the picture at its own size.
 */
export function pictureRect(style: PictureStyle, iw: number, ih: number, w: number, h: number): [number, number, number, number] {
  if (style === 'stretched' || style === 'spanned') return [0, 0, w, h];
  if (style === 'centered') return [(w - iw) / 2, (h - ih) / 2, iw, ih];
  const sx = w / iw, sy = h / ih;
  const scale = style === 'zoom' ? Math.max(sx, sy) : Math.min(sx, sy);
  return [(w - iw * scale) / 2, (h - ih * scale) / 2, iw * scale, ih * scale];
}

/** The size a depth model with patches of `patch` px takes for a view of w x h: `long` px on the longer side. */
export function modelSize(w: number, h: number, long: number, patch: number): [number, number] {
  const short = Math.max(Math.round(long * Math.min(w, h) / Math.max(w, h) / patch), 1) * patch;
  return w >= h ? [long, short] : [short, long];
}

/** `values` stretched to 0..1. */
export function normalized(values: Float32Array): Float32Array {
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  return values.map(v => (v - min) / range);
}

/** A plane of w x h resized to tw x th, bilinear. */
export function resizePlane(src: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const fy = Math.min(Math.max((y + 0.5) * h / th - 0.5, 0), h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, h - 1), wy = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = Math.min(Math.max((x + 0.5) * w / tw - 0.5, 0), w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, w - 1), wx = fx - x0;
      const top = src[y0 * w + x0] * (1 - wx) + src[y0 * w + x1] * wx;
      const bottom = src[y1 * w + x0] * (1 - wx) + src[y1 * w + x1] * wx;
      out[y * tw + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

// The mean over the (2r + 1)-wide square round every pixel, cut off at the borders.
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const rows = new Float32Array(w * h);
  const sums = new Float64Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) sums[x + 1] = sums[x] + src[y * w + x];
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(x - r, 0), x1 = Math.min(x + r + 1, w);
      rows[y * w + x] = (sums[x1] - sums[x0]) / (x1 - x0);
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) sums[y + 1] = sums[y] + rows[y * w + x];
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(y - r, 0), y1 = Math.min(y + r + 1, h);
      out[y * w + x] = (sums[y1] - sums[y0]) / (y1 - y0);
    }
  }
  return out;
}

/**
 * `plane` with its edges moved onto the edges of `guide` (both w x h, 0..1):
 * the guided filter. A plane that came from a much smaller one has its edges
 * a few pixels off and soft; the picture knows where they are.
 */
export function guidedFilter(plane: Float32Array, guide: Float32Array, w: number, h: number, radius: number, epsilon: number): Float32Array {
  const n = w * h;
  const product = new Float32Array(n), square = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    product[i] = guide[i] * plane[i];
    square[i] = guide[i] * guide[i];
  }
  const meanGuide = boxMean(guide, w, h, radius), meanPlane = boxMean(plane, w, h, radius);
  const meanProduct = boxMean(product, w, h, radius), meanSquare = boxMean(square, w, h, radius);
  // Round each pixel the plane is taken as a * guide + b.
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (meanProduct[i] - meanGuide[i] * meanPlane[i]) / (meanSquare[i] - meanGuide[i] * meanGuide[i] + epsilon);
    b[i] = meanPlane[i] - a[i] * meanGuide[i];
  }
  const meanA = boxMean(a, w, h, radius), meanB = boxMean(b, w, h, radius);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(Math.max(meanA[i] * guide[i] + meanB[i], 0), 1);
  return out;
}

/** The map of the two planes (0..1, w x h). `subject` may be missing. */
export function packDepthMap(depth: Float32Array, subject: Float32Array | null, w: number, h: number): DepthMap {
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = Math.round(depth[i] * 255);
    pixels[i * 4 + 1] = subject ? Math.round(subject[i] * 255) : 0;
    pixels[i * 4 + 3] = 255;
  }
  return { width: w, height: h, pixels };
}

// A subject counts where the map's green is above this.
const SUBJECT_LEVEL = 128;
// The subject model found something when what it marked is this much of the picture,
const SUBJECT_AREA: [number, number] = [0.01, 0.55];
// and when at least this much of what it marked at all is marked firmly.
const SUBJECT_FIRM = 0.6;
// The clock hides behind the subject when it covers this much of the clock.
const SUBJECT_COVER: [number, number] = [0.03, 0.65];
// The part of the clock in front of the nearer side has to be this much of it,
const NEAR_SHARE: [number, number] = [0.04, 0.75];
// and this much of the line between the two sides has to be a step in depth this high (of 255),
const EDGE_SHARE = 0.7;
const EDGE_STEP = 13;
// within this many samples; the map's edges are a few px wide.
const EDGE_REACH = 2;
// looked at every this many px of a map 518 px wide, the depth model's own size.
const MODEL_WIDTH = 518;
const LEVELS = 47;
const MAX_SAMPLES = 20000;
// The depth the subject's back is at: this share of it is farther.
const SUBJECT_BACK = 0.15;
// What is nearer than the subject's back hides the clock too when at most this much of the line round it has
// neither a step in depth nor the subject's outline under it.
const LOOSE_SHARE = 0.3;
// Half the width of the shader's soft edge round the threshold.
const EDGE_SOFTNESS = 0.012;
// and when the subject and what is nearer together hide at most this much of the clock's surroundings.
const HIDDEN_SHARE = 0.85;

/** Whether the map's subject plane holds a subject, rather than the model's guesses at a picture without one. */
export function hasSubject(map: DepthMap): boolean {
  let marked = 0, firm = 0, any = 0;
  const p = map.pixels;
  for (let i = 1; i < p.length; i += 16) {
    if (p[i] > SUBJECT_LEVEL) marked++;
    if (p[i] > 25) any++;
    if (p[i] > 200) firm++;
  }
  const share = marked / (p.length / 16);
  return share >= SUBJECT_AREA[0] && share <= SUBJECT_AREA[1] && firm >= any * SUBJECT_FIRM;
}

// The clock's surroundings, sampled: the depth, whether the subject is there or close by, and how much the depth
// changes round each sample.
interface Samples {
  columns: number;
  rows: number;
  depth: Uint8Array;
  subject: Uint8Array;
  nearSubject: Uint8Array;
  jump: Uint8Array;
}

function sample(map: DepthMap, rect: [number, number, number, number]): Samples | null {
  // Coarser for a large clock, so working it out while the clock is dragged stays cheap.
  const step = Math.max(Math.round(map.width / MODEL_WIDTH), Math.ceil(Math.sqrt(rect[2] * rect[3] / MAX_SAMPLES)), 1);
  const x0 = Math.max(Math.floor(rect[0]), 0), y0 = Math.max(Math.floor(rect[1]), 0);
  const columns = Math.floor((Math.min(Math.ceil(rect[0] + rect[2]), map.width) - x0) / step);
  const rows = Math.floor((Math.min(Math.ceil(rect[1] + rect[3]), map.height) - y0) / step);
  if (columns < 4 || rows < 4) return null;
  const n = columns * rows;
  const depth = new Uint8Array(n), subject = new Uint8Array(n), nearSubject = new Uint8Array(n), jump = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const at = ((y0 + r * step) * map.width + x0 + c * step) * 4;
      depth[r * columns + c] = map.pixels[at];
      subject[r * columns + c] = Number(map.pixels[at + 1] > SUBJECT_LEVEL);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      let min = 255, max = 0, near = 0;
      for (let y = Math.max(r - EDGE_REACH, 0); y <= Math.min(r + EDGE_REACH, rows - 1); y++) {
        for (let x = Math.max(c - EDGE_REACH, 0); x <= Math.min(c + EDGE_REACH, columns - 1); x++) {
          const v = depth[y * columns + x];
          if (v < min) min = v;
          if (v > max) max = v;
          near |= subject[y * columns + x];
        }
      }
      jump[r * columns + c] = max - min;
      nearSubject[r * columns + c] = near;
    }
  }
  return { columns, rows, depth, subject, nearSubject, jump };
}

// The line between what is nearer than `t` and the rest: how many samples are nearer, how many lie on the line,
// how many of those on a step in depth, and how many on neither a step nor the subject's outline.
function contour(s: Samples, t: number): { near: number, line: number, steps: number, loose: number } {
  const { columns, rows, depth, jump, nearSubject } = s;
  let near = 0, line = 0, steps = 0, loose = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      const isNear = depth[i] > t;
      if (isNear) near++;
      if ((c > 0 && isNear !== depth[i - 1] > t) || (r > 0 && isNear !== depth[i - columns] > t)) {
        line++;
        if (jump[i] > EDGE_STEP) steps++;
        else if (!nearSubject[i]) loose++;
      }
    }
  }
  return { near, line, steps, loose };
}

/**
 * What a clock over `rect` ([x, y, width, height] in map px) hides behind.
 *
 * The subject, when there is one and it covers a part of the clock; nothing
 * when it covers most of it, so the clock stays readable. A clock behind the
 * subject is also behind what is nearer than the subject, the ground a
 * mountain stands on, unless that would cut the clock along a line with no
 * edge under it, as across the road a car stands on.
 *
 * Away from the subject, whatever is nearer than a depth that splits the
 * clock's surroundings in two along a real edge: a ridge against the sky, not
 * a slope that only comes nearer little by little. Nothing when neither is
 * there.
 */
export function chooseOcclusion(map: DepthMap, rect: [number, number, number, number], subject: boolean): Occlusion {
  const samples = sample(map, rect);
  if (!samples) return NO_OCCLUSION;
  const { depth } = samples;
  const n = depth.length;
  const covered = samples.subject.reduce((sum, v) => sum + v, 0);
  if (subject && covered >= n * SUBJECT_COVER[0]) {
    if (covered > n * SUBJECT_COVER[1]) return NO_OCCLUSION;
    const onSubject = depth.filter((_v, i) => samples.subject[i] === 1).sort();
    const back = onSubject[Math.floor(SUBJECT_BACK * (onSubject.length - 1))];
    const { line, loose } = contour(samples, back);
    let hidden = 0;
    for (let i = 0; i < n; i++) hidden += Number(samples.subject[i] === 1 || depth[i] >= back);
    const withNearer = line >= 8 && loose <= line * LOOSE_SHARE && hidden <= n * HIDDEN_SHARE;
    return { threshold: withNearer ? Math.max(back / 255 - EDGE_SOFTNESS, 0) : 2, subject: true };
  }

  const sorted = depth.slice().sort();
  let best = 0, threshold = -1;
  let last = -1;
  for (let level = 0; level < LEVELS; level++) {
    const t = sorted[Math.floor((0.04 + 0.92 * level / (LEVELS - 1)) * (n - 1))];
    if (t === last) continue;
    last = t;
    const { near, line, steps } = contour(samples, t);
    if (near < n * NEAR_SHARE[0] || near > n * NEAR_SHARE[1] || line < 8) continue;
    if (steps / line > best) {
      best = steps / line;
      threshold = t;
    }
  }
  if (best < EDGE_SHARE) return NO_OCCLUSION;
  // Halfway up the step between most of the far side and most of the near
  // one, so neither is caught in the shader's soft edge.
  let far = 0;
  while (far < n && sorted[far] <= threshold) far++;
  const farTop = sorted[Math.floor(0.9 * (far - 1))];
  const nearBottom = sorted[far + Math.floor(0.1 * (n - far - 1))];
  return { threshold: (farTop + nearBottom) / 510, subject: false };
}
