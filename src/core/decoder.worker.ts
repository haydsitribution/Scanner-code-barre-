/// <reference lib="webworker" />

import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type {
  BarcodeFormat,
  ScanResult,
  WorkerInMessage,
  WorkerOutMessage,
} from "./types";

declare const self: DedicatedWorkerGlobalScope;

let modulePromise: Promise<unknown> | null = null;

function ensureModule(): Promise<unknown> {
  if (!modulePromise) {
    modulePromise = prepareZXingModule({ fireImmediately: true });
  }
  return modulePromise;
}

function send(message: WorkerOutMessage): void {
  self.postMessage(message);
}

async function decode(
  imageData: ImageData,
  formats: readonly BarcodeFormat[],
): Promise<ScanResult | null> {
  await ensureModule();
  const results = await readBarcodes(imageData, {
    formats: formats as BarcodeFormat[],
    tryHarder: true,
    tryRotate: true,
    tryInvert: false,
    tryDownscale: true,
    maxNumberOfSymbols: 1,
  });
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
    decode(msg.imageData, msg.formats)
      .then((scan) => send({ type: "result", id: msg.id, scan }))
      .catch((err) =>
        send({
          type: "error",
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  }
});
