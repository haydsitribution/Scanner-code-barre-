export interface LocalizeBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalizeResult {
  bbox: LocalizeBbox;
  angle: number;
  coherence: number;
  patchCount: number;
}

const PATCH = 16;
const COHERENCE_THRESH = 0.55;
const PATCH_ENERGY_THRESH = 60_000;
const N_BINS = 8;
const MIN_PATCH_COUNT = 4;
const MIN_BBOX_AREA_FRAC = 0.04;

export function localize1D(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): LocalizeResult | null {
  const patchW = Math.floor(width / PATCH);
  const patchH = Math.floor(height / PATCH);
  if (patchW < 2 || patchH < 2) return null;

  const total = patchW * patchH;
  const sxxArr = new Float32Array(total);
  const syyArr = new Float32Array(total);
  const sxyArr = new Float32Array(total);

  for (let py = 0; py < patchH; py++) {
    const y0 = py * PATCH;
    for (let px = 0; px < patchW; px++) {
      const x0 = px * PATCH;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let yy = 1; yy < PATCH - 1; yy++) {
        const row = (y0 + yy) * width;
        for (let xx = 1; xx < PATCH - 1; xx++) {
          const i = row + x0 + xx;
          const gx = (gray[i + 1] as number) - (gray[i - 1] as number);
          const gy = (gray[i + width] as number) - (gray[i - width] as number);
          sxx += gx * gx;
          syy += gy * gy;
          sxy += gx * gy;
        }
      }
      const idx = py * patchW + px;
      sxxArr[idx] = sxx;
      syyArr[idx] = syy;
      sxyArr[idx] = sxy;
    }
  }

  const angles = new Float32Array(total);
  const coherences = new Float32Array(total);
  const binCounts = new Int32Array(N_BINS);
  const binIndices: number[][] = Array.from({ length: N_BINS }, () => []);
  let oriented = 0;

  for (let i = 0; i < total; i++) {
    const sxx = sxxArr[i] as number;
    const syy = syyArr[i] as number;
    const sxy = sxyArr[i] as number;
    const trace = sxx + syy;
    if (trace < PATCH_ENERGY_THRESH) continue;
    const diff = sxx - syy;
    const det = Math.sqrt(diff * diff + 4 * sxy * sxy);
    const lam1 = (trace + det) / 2;
    const lam2 = (trace - det) / 2;
    const denom = lam1 + lam2;
    if (denom <= 0) continue;
    const coh = (lam1 - lam2) / denom;
    if (coh < COHERENCE_THRESH) continue;

    const angle = 0.5 * Math.atan2(2 * sxy, diff);
    angles[i] = angle;
    coherences[i] = coh;
    oriented++;

    let a = angle;
    if (a < 0) a += Math.PI;
    let bin = Math.floor((a / Math.PI) * N_BINS);
    if (bin >= N_BINS) bin = N_BINS - 1;
    binCounts[bin]!++;
    binIndices[bin]!.push(i);
  }

  if (oriented < MIN_PATCH_COUNT) return null;

  let best = -1;
  let bestCount = 0;
  for (let b = 0; b < N_BINS; b++) {
    const c = binCounts[b] as number;
    if (c > bestCount) {
      bestCount = c;
      best = b;
    }
  }
  if (best < 0 || bestCount < MIN_PATCH_COUNT) return null;

  const candidates: number[] = [];
  for (let db = -1; db <= 1; db++) {
    const b = ((best + db) % N_BINS + N_BINS) % N_BINS;
    candidates.push(...binIndices[b]!);
  }
  if (candidates.length < MIN_PATCH_COUNT) return null;

  let minPx = patchW;
  let maxPx = -1;
  let minPy = patchH;
  let maxPy = -1;
  let sumCos = 0;
  let sumSin = 0;
  let sumCoh = 0;

  for (const idx of candidates) {
    const px = idx % patchW;
    const py = (idx - px) / patchW;
    if (px < minPx) minPx = px;
    if (px > maxPx) maxPx = px;
    if (py < minPy) minPy = py;
    if (py > maxPy) maxPy = py;
    const a = angles[idx] as number;
    sumCos += Math.cos(2 * a);
    sumSin += Math.sin(2 * a);
    sumCoh += coherences[idx] as number;
  }

  const meanAngle = 0.5 * Math.atan2(sumSin, sumCos);
  const meanCoh = sumCoh / candidates.length;

  minPx = Math.max(0, minPx - 1);
  maxPx = Math.min(patchW - 1, maxPx + 1);
  minPy = Math.max(0, minPy - 1);
  maxPy = Math.min(patchH - 1, maxPy + 1);

  const bx = minPx * PATCH;
  const by = minPy * PATCH;
  const bw = (maxPx - minPx + 1) * PATCH;
  const bh = (maxPy - minPy + 1) * PATCH;

  if (bw * bh < MIN_BBOX_AREA_FRAC * width * height) return null;

  return {
    bbox: { x: bx, y: by, width: bw, height: bh },
    angle: meanAngle,
    coherence: meanCoh,
    patchCount: candidates.length,
  };
}
