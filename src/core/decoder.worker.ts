/// <reference lib="webworker" />

import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
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

  const decodeStart = performance.now();
  const results = await readBarcodes(rgbaImage, {
    formats: formats as BarcodeFormat[],
    tryHarder: preset.tryHarder,
    tryRotate: preset.tryRotate,
    tryInvert: false,
    tryDownscale: preset.tryDownscale,
    tryDenoise: preset.tryDenoise,
    binarizer: preset.binarizer,
    minLineCount: preset.minLineCount,
    maxNumberOfSymbols: 1,
  });
  const decodeMs = performance.now() - decodeStart;

  let scan: ScanResult | null = null;
  for (const r of results) {
    if (r.isValid && r.text) {
      scan = {
        code: r.text,
        format: r.format as BarcodeFormat,
        rawBytes: r.bytes,
      };
      break;
    }
  }

  return {
    scan,
    metrics: {
      decodeMs,
      localizeMs: 0,
      meanLuma,
      saturatedRatio,
      bboxFrac: 0,
      recoveryActive: false,
    },
  };
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
