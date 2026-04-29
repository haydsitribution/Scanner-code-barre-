export type BarcodeFormat =
  | "EAN13"
  | "EAN8"
  | "UPCA"
  | "UPCE"
  | "Code39"
  | "Code93"
  | "Code128"
  | "Codabar"
  | "ITF"
  | "ITF14"
  | "QRCode"
  | "DataMatrix"
  | "Aztec"
  | "PDF417"
  | "MaxiCode";

export const RETAIL_FORMATS: readonly BarcodeFormat[] = [
  "EAN13",
  "EAN8",
  "UPCA",
  "UPCE",
] as const;

export type DecodeQuality = "fast" | "balanced" | "robust";

export interface ScanResult {
  code: string;
  format: BarcodeFormat;
  rawBytes?: Uint8Array;
}

export interface RoiPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameStats {
  fps: number;
  decodeMs: number;
  localizeMs: number;
  meanLuma: number;
  saturatedRatio: number;
  bboxFrac: number;
  recoveryActive: boolean;
}

export interface WorkerDecodeRequest {
  type: "decode";
  id: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  formats: readonly BarcodeFormat[];
  quality: DecodeQuality;
}

export interface WorkerReadyRequest {
  type: "ready";
}

export type WorkerInMessage = WorkerDecodeRequest | WorkerReadyRequest;

export interface WorkerFrameMetrics {
  decodeMs: number;
  localizeMs: number;
  meanLuma: number;
  saturatedRatio: number;
  bboxFrac: number;
  recoveryActive: boolean;
}

export interface WorkerResultMessage {
  type: "result";
  id: number;
  scan: ScanResult | null;
  metrics: WorkerFrameMetrics;
}

export interface WorkerErrorMessage {
  type: "error";
  id: number | null;
  message: string;
}

export interface WorkerReadyMessage {
  type: "ready";
}

export type WorkerOutMessage =
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerReadyMessage;
