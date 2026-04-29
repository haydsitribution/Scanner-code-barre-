/// <reference lib="webworker" />

import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { localize1D } from "./localizer";
import {
  clahe,
  cropGray,
  grayToRgbaImageData,
  median3,
} from "./preprocess";
import type {
  BarcodeFormat,
  DecodeQuality,
  ScanResult,
  WorkerDecodeRequest,
  WorkerFrameMetrics,
  WorkerInMessage,
  WorkerOutMessage,
} from "./types";

declare const self: DedicatedWorkerGlobalScope;

interface ReaderPreset {
  tryHarder: boolean;
  tryRotate: boolean;
  tryDownscale: boolean;
  tryDenoise: boolean;
  binarizer: "LocalAverage" | "GlobalHistogram" | "FixedThreshold" | "BoolCast";
  minLineCount: number;
}

const PRESETS: Record<DecodeQuality, ReaderPreset> = {
  fast: {
    tryHarder: false,
    tryRotate: false,
    tryDownscale: true,
    tryDenoise: false,
    binarizer: "LocalAverage",
    minLineCount: 2,
  },
  balanced: {
    tryHarder: true,
    tryRotate: true,
    tryDownscale: true,
    tryDenoise: false,
    binarizer: "LocalAverage",
    minLineCount: 2,
  },
  robust: {
    tryHarder: true,
    tryRotate: true,
    tryDownscale: true,
    tryDenoise: true,
    binarizer: "LocalAverage",
    minLineCount: 1,
  },
};

const RING_CAPACITY = 3;

interface RingFrame {
  width: number;
  height: number;
  gray: Uint8ClampedArray;
}

const grayRing: RingFrame[] = [];
let ringCursor = 0;

function pushGray(frame: RingFrame): void {
  const head = grayRing[0];
  if (head && (head.width !== frame.width || head.height !== frame.height)) {
    grayRing.length = 0;
    ringCursor = 0;
  }
  if (grayRing.length < RING_CAPACITY) {
    grayRing.push(frame);
  } else {
    grayRing[ringCursor] = frame;
    ringCursor = (ringCursor + 1) % RING_CAPACITY;
  }
}

let modulePromise: Promise<unknown> | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function ensureModule(): Promise<unknown> {
  if (!modulePromise) {
    modulePromise = prepareZXingModule({ fireImmediately: true });
  }
  return modulePromise;
}

function ensureCanvas(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    ctx = null;
  }
  if (!ctx) {
    ctx = canvas.getContext("2d", {
      willReadFrequently: true,
    } as CanvasRenderingContext2DSettings) as OffscreenCanvasRenderingContext2D | null;
  }
  return ctx;
}

function rgbaToGray(
  rgba: Uint8ClampedArray,
  out: Uint8ClampedArray,
): { meanLuma: number; saturated: number } {
  const n = out.length;
  let sum = 0;
  let saturated = 0;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    const r = rgba[o] ?? 0;
    const g = rgba[o + 1] ?? 0;
    const b = rgba[o + 2] ?? 0;
    const y = (77 * r + 150 * g + 29 * b) >> 8;
    out[i] = y;
    sum += y;
    if (y >= 250) saturated++;
  }
  return { meanLuma: sum / n, saturated };
}

function send(message: WorkerOutMessage, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

async function decode(req: WorkerDecodeRequest): Promise<{
  scan: ScanResult | null;
  metrics: WorkerFrameMetrics;
}> {
  await ensureModule();

  const { bitmap, width, height, formats, quality } = req;
  const preset = PRESETS[quality] ?? PRESETS.balanced;

  const c = ensureCanvas(width, height);
  if (!c) {
    bitmap.close();
    throw new Error("OffscreenCanvas 2D context unavailable");
  }

  c.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const rgbaImage = c.getImageData(0, 0, width, height);
  const gray = new Uint8ClampedArray(width * height);
  const stats = rgbaToGray(rgbaImage.data, gray);
  const meanLuma = stats.meanLuma;
  const saturatedRatio = stats.saturated / (width * height);
  pushGray({ width, height, gray });

  const localizeStart = performance.now();
  const localized = localize1D(gray, width, height);
  const localizeMs = performance.now() - localizeStart;

  let decodeImage: ImageData = rgbaImage;
  let bboxFrac = 1;
  if (localized) {
    const pad = 12;
    const x0 = Math.max(0, localized.bbox.x - pad);
    const y0 = Math.max(0, localized.bbox.y - pad);
    const x1 = Math.min(width, localized.bbox.x + localized.bbox.width + pad);
    const y1 = Math.min(height, localized.bbox.y + localized.bbox.height + pad);
    const cw = x1 - x0;
    const ch = y1 - y0;
    const frac = (cw * ch) / (width * height);
    if (frac < 0.92 && cw >= 64 && ch >= 32) {
      decodeImage = c.getImageData(x0, y0, cw, ch);
      bboxFrac = frac;
    }
  }

  const readerOptions = {
    formats: formats as BarcodeFormat[],
    tryHarder: preset.tryHarder,
    tryRotate: preset.tryRotate,
    tryInvert: false,
    tryDownscale: preset.tryDownscale,
    tryDenoise: preset.tryDenoise,
    binarizer: preset.binarizer,
    minLineCount: preset.minLineCount,
    maxNumberOfSymbols: 1,
  } as const;

  const decodeStart = performance.now();
  let results = await readBarcodes(decodeImage, readerOptions);
  let scan = pickValid(results);
  let recoveryActive = false;

  if (!scan && shouldRecover(saturatedRatio, meanLuma)) {
    const enhanced = buildRecoveryImage(width, height, localized);
    if (enhanced) {
      recoveryActive = true;
      results = await readBarcodes(enhanced, readerOptions);
      scan = pickValid(results);
    }
  }

  const decodeMs = performance.now() - decodeStart;

  return {
    scan,
    metrics: {
      decodeMs,
      localizeMs,
      meanLuma,
      saturatedRatio,
      bboxFrac,
      recoveryActive,
    },
  };
}

function pickValid(
  results: Awaited<ReturnType<typeof readBarcodes>>,
): ScanResult | null {
  for (const r of results) {
    if (r.isValid && r.text) {
      return {
        code: r.text,
        format: r.format as BarcodeFormat,
        rawBytes: r.bytes,
      };
    }
  }
  return null;
}

function shouldRecover(saturatedRatio: number, meanLuma: number): boolean {
  if (grayRing.length < RING_CAPACITY) return false;
  if (saturatedRatio > 0.005) return true;
  if (meanLuma < 60 || meanLuma > 210) return true;
  return false;
}

function buildRecoveryImage(
  width: number,
  height: number,
  localized: ReturnType<typeof localize1D>,
): ImageData | null {
  const f0 = grayRing[0];
  const f1 = grayRing[1];
  const f2 = grayRing[2];
  if (!f0 || !f1 || !f2) return null;
  if (f0.width !== width || f0.height !== height) return null;

  const fullMedian = new Uint8ClampedArray(width * height);
  median3(f0.gray, f1.gray, f2.gray, fullMedian);

  let mw = width;
  let mh = height;
  let medianGray: Uint8ClampedArray = fullMedian;
  if (localized) {
    const pad = 12;
    const x0 = Math.max(0, localized.bbox.x - pad);
    const y0 = Math.max(0, localized.bbox.y - pad);
    const x1 = Math.min(width, localized.bbox.x + localized.bbox.width + pad);
    const y1 = Math.min(height, localized.bbox.y + localized.bbox.height + pad);
    if (x1 - x0 >= 64 && y1 - y0 >= 32) {
      mw = x1 - x0;
      mh = y1 - y0;
      medianGray = cropGray(fullMedian, width, x0, y0, mw, mh) as Uint8ClampedArray;
    }
  }

  const enhanced = clahe(medianGray, mw, mh, {
    gridX: mw >= 256 ? 8 : 4,
    gridY: mh >= 128 ? 4 : 2,
    clipLimit: 3,
  });
  return grayToRgbaImageData(enhanced, mw, mh);
}

self.addEventListener("message", (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type === "ready") {
    ensureModule()
      .then(() => send({ type: "ready" }))
      .catch((err) =>
        send({
          type: "error",
          id: null,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    return;
  }
  if (msg.type === "decode") {
    decode(msg)
      .then(({ scan, metrics }) =>
        send({ type: "result", id: msg.id, scan, metrics }),
      )
      .catch((err) =>
        send({
          type: "error",
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  }
});
