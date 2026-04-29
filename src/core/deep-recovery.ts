import { cropGray, grayToRgbaImageData } from "./preprocess";

export interface RecoveryBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StackFrame {
  gray: Uint8ClampedArray;
  width: number;
  height: number;
}

const MIN_MISS_STREAK = 8;
const MIN_STACK = 4;
const MAX_STACK = 6;
const SEARCH_RADIUS = 4;
const STABLE_TOLERANCE = 12;

export class DeepRecovery {
  private missStreak = 0;
  private lastBbox: RecoveryBbox | null = null;
  private stack: StackFrame[] = [];

  reset(): void {
    this.missStreak = 0;
    this.lastBbox = null;
    this.stack = [];
  }

  noteDetect(): void {
    this.reset();
  }

  noteMiss(bbox: RecoveryBbox | null): void {
    if (!bbox) {
      this.reset();
      return;
    }
    if (this.lastBbox && bboxStable(this.lastBbox, bbox)) {
      this.missStreak += 1;
    } else {
      this.missStreak = 1;
      this.stack = [];
    }
    this.lastBbox = bbox;
  }

  shouldAttempt(): boolean {
    return this.missStreak >= MIN_MISS_STREAK && this.lastBbox !== null;
  }

  submit(
    gray: Uint8ClampedArray,
    width: number,
    height: number,
  ): ImageData | null {
    const bbox = this.lastBbox;
    if (!bbox) return null;
    if (this.missStreak < MIN_MISS_STREAK) return null;

    const crop = cropGray(gray, width, bbox.x, bbox.y, bbox.width, bbox.height);
    if (this.stack.length === 0) {
      this.stack.push({ gray: crop, width: bbox.width, height: bbox.height });
      return null;
    }

    const reference = this.stack[0]!;
    if (
      reference.width !== bbox.width ||
      reference.height !== bbox.height
    ) {
      this.stack = [{ gray: crop, width: bbox.width, height: bbox.height }];
      return null;
    }

    this.stack.push({ gray: crop, width: bbox.width, height: bbox.height });
    if (this.stack.length > MAX_STACK) {
      this.stack.shift();
    }
    if (this.stack.length < MIN_STACK) return null;

    const stacked = stackAlign(this.stack);
    const upscaled = bicubicUpscale2(stacked, reference.width, reference.height);
    const out = grayToRgbaImageData(
      upscaled,
      reference.width * 2,
      reference.height * 2,
    );

    this.stack = [];
    this.missStreak = 0;
    return out;
  }
}

function bboxStable(a: RecoveryBbox, b: RecoveryBbox): boolean {
  return (
    Math.abs(a.x - b.x) <= STABLE_TOLERANCE &&
    Math.abs(a.y - b.y) <= STABLE_TOLERANCE &&
    Math.abs(a.width - b.width) <= STABLE_TOLERANCE * 2 &&
    Math.abs(a.height - b.height) <= STABLE_TOLERANCE * 2
  );
}

function stackAlign(stack: StackFrame[]): Float32Array {
  const ref = stack[0]!;
  const w = ref.width;
  const h = ref.height;
  const acc = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) acc[i] = ref.gray[i] as number;
  let count = 1;

  for (let s = 1; s < stack.length; s++) {
    const frame = stack[s]!;
    const shift = subPixelShift(ref.gray, frame.gray, w, h);
    const sampled = warpBilinear(frame.gray, w, h, shift.dx, shift.dy);
    for (let i = 0; i < w * h; i++) {
      acc[i] = (acc[i] as number) + (sampled[i] as number);
    }
    count++;
  }

  for (let i = 0; i < acc.length; i++) {
    acc[i] = (acc[i] as number) / count;
  }
  return acc;
}

function subPixelShift(
  ref: Uint8ClampedArray,
  cur: Uint8ClampedArray,
  width: number,
  height: number,
): { dx: number; dy: number } {
  const x0 = Math.max(SEARCH_RADIUS, Math.floor(width * 0.1));
  const y0 = Math.max(SEARCH_RADIUS, Math.floor(height * 0.1));
  const x1 = Math.min(width - SEARCH_RADIUS, Math.ceil(width * 0.9));
  const y1 = Math.min(height - SEARCH_RADIUS, Math.ceil(height * 0.9));

  let bestSsd = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  const span = 2 * SEARCH_RADIUS + 1;
  const grid = new Float32Array(span * span);

  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      let ssd = 0;
      for (let y = y0; y < y1; y += 2) {
        const refRow = y * width;
        const curRow = (y + dy) * width;
        for (let x = x0; x < x1; x += 2) {
          const a = ref[refRow + x] as number;
          const b = cur[curRow + x + dx] as number;
          const d = a - b;
          ssd += d * d;
        }
      }
      grid[(dy + SEARCH_RADIUS) * span + (dx + SEARCH_RADIUS)] = ssd;
      if (ssd < bestSsd) {
        bestSsd = ssd;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  let subDx = bestDx;
  let subDy = bestDy;
  if (
    bestDx > -SEARCH_RADIUS && bestDx < SEARCH_RADIUS &&
    bestDy > -SEARCH_RADIUS && bestDy < SEARCH_RADIUS
  ) {
    const cx = bestDx + SEARCH_RADIUS;
    const cy = bestDy + SEARCH_RADIUS;
    const xm = grid[cy * span + (cx - 1)] as number;
    const x0 = grid[cy * span + cx] as number;
    const xp = grid[cy * span + (cx + 1)] as number;
    const ym = grid[(cy - 1) * span + cx] as number;
    const yp = grid[(cy + 1) * span + cx] as number;

    const denomX = xm - 2 * x0 + xp;
    if (denomX !== 0) {
      const offX = 0.5 * (xm - xp) / denomX;
      if (Math.abs(offX) <= 1) subDx = bestDx + offX;
    }
    const denomY = ym - 2 * x0 + yp;
    if (denomY !== 0) {
      const offY = 0.5 * (ym - yp) / denomY;
      if (Math.abs(offY) <= 1) subDy = bestDy + offY;
    }
  }
  return { dx: subDx, dy: subDy };
}

function warpBilinear(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = y + dy;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = x + dx;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const i00 = sample(src, width, height, x0, y0);
      const i10 = sample(src, width, height, x0 + 1, y0);
      const i01 = sample(src, width, height, x0, y0 + 1);
      const i11 = sample(src, width, height, x0 + 1, y0 + 1);
      const top = i00 * (1 - fx) + i10 * fx;
      const bot = i01 * (1 - fx) + i11 * fx;
      out[y * width + x] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

function sample(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0) x = 0;
  else if (x >= width) x = width - 1;
  if (y < 0) y = 0;
  else if (y >= height) y = height - 1;
  return src[y * width + x] as number;
}

function cubicWeight(t: number): number {
  const a = -0.5;
  const at = Math.abs(t);
  const at2 = at * at;
  const at3 = at2 * at;
  if (at < 1) return (a + 2) * at3 - (a + 3) * at2 + 1;
  if (at < 2) return a * at3 - 5 * a * at2 + 8 * a * at - 4 * a;
  return 0;
}

function bicubicUpscale2(
  src: Float32Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const ow = width * 2;
  const oh = height * 2;
  const out = new Uint8ClampedArray(ow * oh);
  for (let y = 0; y < oh; y++) {
    const sy = (y + 0.5) / 2 - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const wy0 = cubicWeight(1 + fy);
    const wy1 = cubicWeight(fy);
    const wy2 = cubicWeight(1 - fy);
    const wy3 = cubicWeight(2 - fy);
    for (let x = 0; x < ow; x++) {
      const sx = (x + 0.5) / 2 - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const wx0 = cubicWeight(1 + fx);
      const wx1 = cubicWeight(fx);
      const wx2 = cubicWeight(1 - fx);
      const wx3 = cubicWeight(2 - fx);

      let acc = 0;
      acc += rowConv(src, width, height, x0, y0 - 1, wx0, wx1, wx2, wx3) * wy0;
      acc += rowConv(src, width, height, x0, y0, wx0, wx1, wx2, wx3) * wy1;
      acc += rowConv(src, width, height, x0, y0 + 1, wx0, wx1, wx2, wx3) * wy2;
      acc += rowConv(src, width, height, x0, y0 + 2, wx0, wx1, wx2, wx3) * wy3;

      const total = (wx0 + wx1 + wx2 + wx3) * (wy0 + wy1 + wy2 + wy3);
      const v = total !== 0 ? acc / total : acc;
      out[y * ow + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

function rowConv(
  src: Float32Array,
  width: number,
  height: number,
  x0: number,
  y: number,
  wx0: number,
  wx1: number,
  wx2: number,
  wx3: number,
): number {
  const yy = y < 0 ? 0 : y >= height ? height - 1 : y;
  const row = yy * width;
  const s0 = sampleF(src, width, x0 - 1, row);
  const s1 = sampleF(src, width, x0, row);
  const s2 = sampleF(src, width, x0 + 1, row);
  const s3 = sampleF(src, width, x0 + 2, row);
  return s0 * wx0 + s1 * wx1 + s2 * wx2 + s3 * wx3;
}

function sampleF(
  src: Float32Array,
  width: number,
  x: number,
  rowBase: number,
): number {
  if (x < 0) x = 0;
  else if (x >= width) x = width - 1;
  return src[rowBase + x] as number;
}
