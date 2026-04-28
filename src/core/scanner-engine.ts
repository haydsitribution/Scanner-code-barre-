import DecoderWorker from "./decoder.worker.ts?worker&inline";
import {
  applyTorch,
  closeCamera,
  openCamera,
  streamHasTorch,
  type CameraStream,
  type OpenCameraOptions,
} from "./camera";
import {
  RETAIL_FORMATS,
  type BarcodeFormat,
  type ScanResult,
  type WorkerInMessage,
  type WorkerOutMessage,
} from "./types";

export interface RegionOfInterest {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_ROI: RegionOfInterest = {
  x: 0.2,
  y: 0.35,
  width: 0.6,
  height: 0.3,
};

export interface ScannerEngineOptions {
  video: HTMLVideoElement;
  formats?: readonly BarcodeFormat[];
  roi?: RegionOfInterest;
  cooldownMs?: number;
  stableFrames?: number;
  camera?: OpenCameraOptions;
  onDetect: (result: ScanResult) => void;
  onError?: (err: Error) => void;
}

function supportsRVFC(
  video: HTMLVideoElement,
): video is HTMLVideoElement & {
  requestVideoFrameCallback: NonNullable<HTMLVideoElement["requestVideoFrameCallback"]>;
  cancelVideoFrameCallback: NonNullable<HTMLVideoElement["cancelVideoFrameCallback"]>;
} {
  return typeof video.requestVideoFrameCallback === "function";
}

export class ScannerEngine {
  private readonly options: Required<
    Omit<ScannerEngineOptions, "camera" | "onError">
  > & { camera?: OpenCameraOptions; onError?: (err: Error) => void };

  private worker: Worker | null = null;
  private camera: CameraStream | null = null;

  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  private rvfcHandle: number | null = null;
  private intervalHandle: number | null = null;

  private inFlight = false;
  private requestId = 0;

  private lastCode: string | null = null;
  private streak = 0;
  private lastFireAt = 0;

  private state: "idle" | "starting" | "running" | "stopping" = "idle";

  constructor(options: ScannerEngineOptions) {
    this.options = {
      video: options.video,
      formats: options.formats ?? RETAIL_FORMATS,
      roi: options.roi ?? DEFAULT_ROI,
      cooldownMs: options.cooldownMs ?? 1500,
      stableFrames: options.stableFrames ?? 2,
      camera: options.camera,
      onDetect: options.onDetect,
      onError: options.onError,
    };
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "starting";

    try {
      this.worker = this.spawnWorker();
      this.camera = await openCamera(this.options.camera);

      const video = this.options.video;
      video.srcObject = this.camera.stream;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "true");
      await video.play();

      this.state = "running";
      this.scheduleFrame();
    } catch (err) {
      this.cleanupAfterFailure();
      this.state = "idle";
      throw err;
    }
  }

  stop(): void {
    if (this.state === "idle" || this.state === "stopping") return;
    this.state = "stopping";

    this.cancelFrame();

    closeCamera(this.camera);
    this.camera = null;

    const video = this.options.video;
    if (video.srcObject) {
      video.srcObject = null;
    }

    this.lastCode = null;
    this.streak = 0;
    this.inFlight = false;

    this.state = "idle";
  }

  destroy(): void {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  hasTorch(): boolean {
    return this.camera ? streamHasTorch(this.camera) : false;
  }

  async toggleTorch(on: boolean): Promise<void> {
    if (!this.camera) throw new Error("camera not running");
    await applyTorch(this.camera, on);
  }

  private spawnWorker(): Worker {
    const worker = new DecoderWorker();
    worker.addEventListener("message", (event: MessageEvent<WorkerOutMessage>) => {
      this.handleWorkerMessage(event.data);
    });
    worker.addEventListener("error", (event) => {
      this.options.onError?.(new Error(event.message || "worker error"));
    });
    const init: WorkerInMessage = { type: "ready" };
    worker.postMessage(init);
    return worker;
  }

  private handleWorkerMessage(msg: WorkerOutMessage): void {
    if (msg.type === "ready") return;
    if (msg.type === "error") {
      this.inFlight = false;
      this.options.onError?.(new Error(msg.message));
      return;
    }
    this.inFlight = false;
    const scan = msg.scan;
    if (scan) {
      this.evaluateDetection(scan);
    } else {
      this.lastCode = null;
      this.streak = 0;
    }
  }

  private evaluateDetection(scan: ScanResult): void {
    const now = performance.now();
    if (scan.code === this.lastCode) {
      this.streak += 1;
    } else {
      this.lastCode = scan.code;
      this.streak = 1;
    }

    const cooldownElapsed = now - this.lastFireAt >= this.options.cooldownMs;
    if (this.streak >= this.options.stableFrames && cooldownElapsed) {
      this.lastFireAt = now;
      this.streak = 0;
      this.options.onDetect(scan);
    }
  }

  private scheduleFrame(): void {
    if (this.state !== "running") return;
    const video = this.options.video;
    if (supportsRVFC(video)) {
      this.rvfcHandle = video.requestVideoFrameCallback(() => this.tick());
    } else {
      this.intervalHandle = window.setInterval(() => this.tick(), 50);
    }
  }

  private cancelFrame(): void {
    const video = this.options.video;
    if (this.rvfcHandle !== null && supportsRVFC(video)) {
      video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.intervalHandle !== null) {
      window.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private tick(): void {
    if (this.state !== "running") return;

    if (!this.inFlight) {
      this.captureAndDecode();
    }

    if (this.rvfcHandle !== null) {
      const video = this.options.video;
      if (supportsRVFC(video)) {
        this.rvfcHandle = video.requestVideoFrameCallback(() => this.tick());
      }
    }
  }

  private captureAndDecode(): void {
    const video = this.options.video;
    const worker = this.worker;
    if (!worker || !video.videoWidth || !video.videoHeight) return;

    const roi = this.options.roi;
    const sx = Math.max(0, Math.floor(video.videoWidth * roi.x));
    const sy = Math.max(0, Math.floor(video.videoHeight * roi.y));
    const sw = Math.max(1, Math.floor(video.videoWidth * roi.width));
    const sh = Math.max(1, Math.floor(video.videoHeight * roi.height));

    const ctx = this.ensureContext(sw, sh);
    if (!ctx) return;

    try {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    } catch {
      return;
    }

    const imageData = ctx.getImageData(0, 0, sw, sh);
    const id = ++this.requestId;
    const msg: WorkerInMessage = {
      type: "decode",
      id,
      imageData,
      formats: this.options.formats,
    };
    this.inFlight = true;
    worker.postMessage(msg);
  }

  private ensureContext(
    width: number,
    height: number,
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
    if (!this.canvas) {
      if (typeof OffscreenCanvas !== "undefined") {
        this.canvas = new OffscreenCanvas(width, height);
      } else {
        this.canvas = document.createElement("canvas");
      }
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.ctx = null;
    }
    if (!this.ctx) {
      const ctx = this.canvas.getContext("2d", {
        willReadFrequently: true,
      } as CanvasRenderingContext2DSettings);
      this.ctx = ctx as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
    }
    return this.ctx;
  }

  private cleanupAfterFailure(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    closeCamera(this.camera);
    this.camera = null;
  }
}
