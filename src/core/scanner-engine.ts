import DecoderWorker from "./decoder.worker.ts?worker&inline";
import {
  applyTorch,
  closeCamera,
  describeCameraCapabilities,
  openCamera,
  setFocusContinuous,
  setFocusManual,
  setPointOfInterest,
  setZoom,
  streamHasTorch,
  type CameraCapabilitiesInfo,
  type CameraStream,
  type OpenCameraOptions,
} from "./camera";
import {
  RETAIL_FORMATS,
  type BarcodeFormat,
  type DecodeQuality,
  type FrameStats,
  type ScanResult,
  type WorkerFrameMetrics,
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

const MAX_CAPTURE_WIDTH = 960;

export interface ScannerEngineOptions {
  video: HTMLVideoElement;
  formats?: readonly BarcodeFormat[];
  roi?: RegionOfInterest;
  cooldownMs?: number;
  stableFrames?: number;
  quality?: DecodeQuality;
  camera?: OpenCameraOptions;
  onDetect: (result: ScanResult) => void;
  onError?: (err: Error) => void;
  onFrameStats?: (stats: FrameStats) => void;
}

function supportsRVFC(
  video: HTMLVideoElement,
): video is HTMLVideoElement & {
  requestVideoFrameCallback: NonNullable<HTMLVideoElement["requestVideoFrameCallback"]>;
  cancelVideoFrameCallback: NonNullable<HTMLVideoElement["cancelVideoFrameCallback"]>;
} {
  return typeof video.requestVideoFrameCallback === "function";
}

interface RequiredOptions {
  video: HTMLVideoElement;
  formats: readonly BarcodeFormat[];
  roi: RegionOfInterest;
  cooldownMs: number;
  stableFrames: number;
  quality: DecodeQuality;
  onDetect: (result: ScanResult) => void;
  camera?: OpenCameraOptions;
  onError?: (err: Error) => void;
  onFrameStats?: (stats: FrameStats) => void;
}

export class ScannerEngine {
  private readonly options: RequiredOptions;

  private worker: Worker | null = null;
  private camera: CameraStream | null = null;

  private rvfcHandle: number | null = null;
  private intervalHandle: number | null = null;

  private inFlight = false;
  private requestId = 0;

  private lastCode: string | null = null;
  private streak = 0;
  private lastFireAt = 0;

  private framesInWindow = 0;
  private windowStart = 0;
  private currentFps = 0;

  private state: "idle" | "starting" | "running" | "stopping" = "idle";

  constructor(options: ScannerEngineOptions) {
    this.options = {
      video: options.video,
      formats: options.formats ?? RETAIL_FORMATS,
      roi: options.roi ?? DEFAULT_ROI,
      cooldownMs: options.cooldownMs ?? 1500,
      stableFrames: options.stableFrames ?? 2,
      quality: options.quality ?? "balanced",
      camera: options.camera,
      onDetect: options.onDetect,
      onError: options.onError,
      onFrameStats: options.onFrameStats,
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

      this.windowStart = performance.now();
      this.framesInWindow = 0;
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
    this.currentFps = 0;
    this.framesInWindow = 0;

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

  getCameraInfo(): CameraCapabilitiesInfo | null {
    return this.camera ? describeCameraCapabilities(this.camera) : null;
  }

  async setZoom(zoom: number): Promise<void> {
    if (!this.camera) throw new Error("camera not running");
    await setZoom(this.camera, zoom);
  }

  async tapToFocus(xRatio: number, yRatio: number): Promise<void> {
    if (!this.camera) throw new Error("camera not running");
    await setPointOfInterest(this.camera, xRatio, yRatio);
  }

  async setFocus(mode: "continuous" | "manual", distance?: number): Promise<void> {
    if (!this.camera) throw new Error("camera not running");
    if (mode === "continuous") {
      await setFocusContinuous(this.camera);
    } else {
      if (typeof distance !== "number") {
        throw new Error("manual focus requires a distance");
      }
      await setFocusManual(this.camera, distance);
    }
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
    this.emitStats(msg.metrics);
    const scan = msg.scan;
    if (scan) {
      this.evaluateDetection(scan);
    } else {
      this.lastCode = null;
      this.streak = 0;
    }
  }

  private emitStats(metrics: WorkerFrameMetrics): void {
    const cb = this.options.onFrameStats;
    if (!cb) return;
    cb({
      fps: this.currentFps,
      decodeMs: metrics.decodeMs,
      localizeMs: metrics.localizeMs,
      meanLuma: metrics.meanLuma,
      saturatedRatio: metrics.saturatedRatio,
      bboxFrac: metrics.bboxFrac,
      recoveryActive: metrics.recoveryActive,
    });
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

    this.framesInWindow += 1;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      this.currentFps = (this.framesInWindow * 1000) / elapsed;
      this.framesInWindow = 0;
      this.windowStart = now;
    }

    if (!this.inFlight) {
      void this.captureAndDecode().catch((err) => {
        this.inFlight = false;
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }

    if (this.rvfcHandle !== null) {
      const video = this.options.video;
      if (supportsRVFC(video)) {
        this.rvfcHandle = video.requestVideoFrameCallback(() => this.tick());
      }
    }
  }

  private async captureAndDecode(): Promise<void> {
    const video = this.options.video;
    const worker = this.worker;
    if (!worker || !video.videoWidth || !video.videoHeight) return;

    const roi = this.options.roi;
    const sx = Math.max(0, Math.floor(video.videoWidth * roi.x));
    const sy = Math.max(0, Math.floor(video.videoHeight * roi.y));
    const sw = Math.max(1, Math.floor(video.videoWidth * roi.width));
    const sh = Math.max(1, Math.floor(video.videoHeight * roi.height));

    const scale = sw > MAX_CAPTURE_WIDTH ? MAX_CAPTURE_WIDTH / sw : 1;
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    this.inFlight = true;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(video, sx, sy, sw, sh, {
        resizeWidth: dw,
        resizeHeight: dh,
        resizeQuality: "medium",
      });
    } catch {
      this.inFlight = false;
      return;
    }

    const id = ++this.requestId;
    const msg: WorkerInMessage = {
      type: "decode",
      id,
      bitmap,
      width: dw,
      height: dh,
      formats: this.options.formats,
      quality: this.options.quality,
    };
    try {
      worker.postMessage(msg, [bitmap]);
    } catch (err) {
      this.inFlight = false;
      bitmap.close();
      throw err;
    }
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
