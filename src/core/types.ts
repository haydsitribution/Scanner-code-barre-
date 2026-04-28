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

export interface ScanResult {
  code: string;
  format: BarcodeFormat;
  rawBytes?: Uint8Array;
}

export interface WorkerDecodeRequest {
  type: "decode";
  id: number;
  imageData: ImageData;
  formats: readonly BarcodeFormat[];
}

export interface WorkerReadyRequest {
  type: "ready";
}

export type WorkerInMessage = WorkerDecodeRequest | WorkerReadyRequest;

export interface WorkerResultMessage {
  type: "result";
  id: number;
  scan: ScanResult | null;
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
