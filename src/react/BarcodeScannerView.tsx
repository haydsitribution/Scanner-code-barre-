import { useCallback } from "react";
import { useScanner, type UseScannerOptions } from "./use-scanner";
import { DEFAULT_ROI } from "@/core/scanner-engine";
import type { FrameStats, ScanResult } from "@/core/types";
import "@/styles/ui.css";

export interface BarcodeScannerViewProps
  extends Omit<
    UseScannerOptions,
    "onDetect" | "onError" | "enabled" | "onFrameStats"
  > {
  active?: boolean;
  onScan: (result: ScanResult) => void;
  onError?: (err: Error) => void;
  onFrameStats?: (stats: FrameStats) => void;
  hideTorchButton?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function BarcodeScannerView({
  active = true,
  onScan,
  onError,
  onFrameStats,
  hideTorchButton = false,
  className,
  style,
  formats,
  roi,
  cooldownMs,
  stableFrames,
  quality,
  camera,
}: BarcodeScannerViewProps) {
  const handleDetect = useCallback(
    (result: ScanResult) => {
      onScan(result);
    },
    [onScan],
  );

  const { videoRef, isScanning, error, hasTorch, torchOn, toggleTorch } = useScanner({
    enabled: active,
    onDetect: handleDetect,
    onError,
    onFrameStats,
    formats,
    roi,
    cooldownMs,
    stableFrames,
    quality,
    camera,
  });

  const effectiveRoi = roi ?? DEFAULT_ROI;

  return (
    <div className={`bcsdk-view${className ? ` ${className}` : ""}`} style={style}>
      <video ref={videoRef} className="bcsdk-video" muted playsInline />
      {isScanning && (
        <>
          <div className="bcsdk-scrim" style={{ top: 0, left: 0, right: 0, height: `${effectiveRoi.y * 100}%` }} />
          <div className="bcsdk-scrim" style={{ left: 0, right: 0, top: `${(effectiveRoi.y + effectiveRoi.height) * 100}%`, bottom: 0 }} />
          <div className="bcsdk-scrim" style={{ top: `${effectiveRoi.y * 100}%`, height: `${effectiveRoi.height * 100}%`, left: 0, width: `${effectiveRoi.x * 100}%` }} />
          <div className="bcsdk-scrim" style={{ top: `${effectiveRoi.y * 100}%`, height: `${effectiveRoi.height * 100}%`, left: `${(effectiveRoi.x + effectiveRoi.width) * 100}%`, right: 0 }} />
          <div className="bcsdk-roi" style={{ left: `${effectiveRoi.x * 100}%`, top: `${effectiveRoi.y * 100}%`, width: `${effectiveRoi.width * 100}%`, height: `${effectiveRoi.height * 100}%` }}>
            <span className="bcsdk-scan-line" />
          </div>
        </>
      )}
      {!isScanning && active && (
        <div className="bcsdk-overlay-cta">
          <span className="bcsdk-cta">Démarrage de la caméra…</span>
        </div>
      )}
      {!hideTorchButton && isScanning && hasTorch && (
        <button
          type="button"
          className={`bcsdk-torch${torchOn ? " bcsdk-torch-on" : ""}`}
          onClick={() => void toggleTorch()}
          aria-label={torchOn ? "Éteindre la torche" : "Allumer la torche"}
          aria-pressed={torchOn}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M5 9a7 7 0 0 1 14 0c0 2.5-1 4.5-2.5 6.5L16 17H8l-.5-1.5C6 13.5 5 11.5 5 9Z" />
          </svg>
        </button>
      )}
      {error && <div className="bcsdk-error">{error.message}</div>}
    </div>
  );
}
