const HIST_BINS = 256;

export function median3(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  c: Uint8ClampedArray,
  out: Uint8ClampedArray,
): void {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const va = a[i] as number;
    const vb = b[i] as number;
    const vc = c[i] as number;
    const mn = va < vb ? (va < vc ? va : vc) : vb < vc ? vb : vc;
    const mx = va > vb ? (va > vc ? va : vc) : vb > vc ? vb : vc;
    out[i] = va + vb + vc - mn - mx;
  }
}

export function cropGray(
  src: Uint8ClampedArray,
  srcWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  for (let yy = 0; yy < h; yy++) {
    const srcRow = (y + yy) * srcWidth + x;
    const dstRow = yy * w;
    for (let xx = 0; xx < w; xx++) {
      out[dstRow + xx] = src[srcRow + xx] as number;
    }
  }
  return out;
}

export function grayToRgbaImageData(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] as number;
    const o = i << 2;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

export interface ClaheOptions {
  gridX?: number;
  gridY?: number;
  clipLimit?: number;
}

export function clahe(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  options: ClaheOptions = {},
): Uint8ClampedArray {
  const gridX = options.gridX ?? 8;
  const gridY = options.gridY ?? 4;
  const clipLimit = options.clipLimit ?? 3.0;

  const tileW = Math.max(1, Math.ceil(width / gridX));
  const tileH = Math.max(1, Math.ceil(height / gridY));
  const cdfs = new Uint8Array(gridX * gridY * HIST_BINS);
  const hist = new Uint32Array(HIST_BINS);

  for (let ty = 0; ty < gridY; ty++) {
    for (let tx = 0; tx < gridX; tx++) {
      hist.fill(0);
      const x0 = tx * tileW;
      const y0 = ty * tileH;
      const x1 = Math.min(width, x0 + tileW);
      const y1 = Math.min(height, y0 + tileH);
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx++) {
          hist[gray[row + xx] as number]!++;
          count++;
        }
      }
      const cap = Math.max(1, Math.floor((clipLimit * count) / HIST_BINS));
      let excess = 0;
      for (let b = 0; b < HIST_BINS; b++) {
        const v = hist[b] as number;
        if (v > cap) {
          excess += v - cap;
          hist[b] = cap;
        }
      }
      const inc = Math.floor(excess / HIST_BINS);
      let remainder = excess - inc * HIST_BINS;
      for (let b = 0; b < HIST_BINS; b++) {
        hist[b]! += inc;
      }
      let b = 0;
      while (remainder > 0) {
        hist[b]!++;
        remainder--;
        b = (b + 1) % HIST_BINS;
      }
      let acc = 0;
      const base = (ty * gridX + tx) * HIST_BINS;
      const norm = count > 0 ? 255 / count : 0;
      for (let bb = 0; bb < HIST_BINS; bb++) {
        acc += hist[bb] as number;
        cdfs[base + bb] = Math.min(255, Math.round(acc * norm));
      }
    }
  }

  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < height; y++) {
    const tyf = (y + 0.5) / tileH - 0.5;
    const ty0 = Math.max(0, Math.floor(tyf));
    const ty1 = Math.min(gridY - 1, ty0 + 1);
    const fy = Math.max(0, Math.min(1, tyf - ty0));

    for (let x = 0; x < width; x++) {
      const txf = (x + 0.5) / tileW - 0.5;
      const tx0 = Math.max(0, Math.floor(txf));
      const tx1 = Math.min(gridX - 1, tx0 + 1);
      const fx = Math.max(0, Math.min(1, txf - tx0));

      const v = gray[y * width + x] as number;
      const v00 = cdfs[(ty0 * gridX + tx0) * HIST_BINS + v] as number;
      const v01 = cdfs[(ty0 * gridX + tx1) * HIST_BINS + v] as number;
      const v10 = cdfs[(ty1 * gridX + tx0) * HIST_BINS + v] as number;
      const v11 = cdfs[(ty1 * gridX + tx1) * HIST_BINS + v] as number;

      const v0 = v00 * (1 - fx) + v01 * fx;
      const v1 = v10 * (1 - fx) + v11 * fx;
      out[y * width + x] = Math.round(v0 * (1 - fy) + v1 * fy);
    }
  }

  return out;
}
