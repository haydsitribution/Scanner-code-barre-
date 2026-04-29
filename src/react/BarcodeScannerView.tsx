import { useCallback, useEffect, useRef, useState } from "react";
import { useScanner, type UseScannerOptions } from "./use-scanner";
import { DEFAULT_ROI } from "@/core/scanner-engine";
import type { FrameStats, ScanResult } from "@/core/types";
import "@/styles/ui.css";

export type HintKind =
  | "starting"
  | "tooDark"
  | "glare"
  | "moveCloser"
  | "holdSteady";

export interface ScannerLabels {
  starting?: string;
  tooDark?: string;
  glare?: string;
  moveCloser?: string;
  holdSteady?: string;
  torchOn?: string;
  torchOff?: string;
  zoom?: string;
}

const DEFAULT_LABELS: Required<ScannerLabels> = {
  starting: "Démarrage de la caméra…",
  tooDark: "Plus de lumière",
  glare: "Reflet détecté — bougez le téléphone",
  moveCloser: "Rapprochez le code-barres",
  holdSteady: "Tenez stable",
  torchOn: "Éteindre la torche",
  torchOff: "Allumer la torche",
  zoom: "Zoom",
};

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
  hideZoomSlider?: boolean;
  hideHints?: boolean;
  enableHaptics?: boolean;
  enableTapToFocus?: boolean;
  labels?: ScannerLabels;
  className?: string;
  style?: React.CSSProperties;
}

interface HintState {
  kind: HintKind | null;
}

const HINT_STREAK = 6;
const HINT_CLEAR_STREAK = 3;

export function BarcodeScannerView({
  active = true,
  onScan,
  onError,
  onFrameStats,
  hideTorchButton = false,
  hideZoomSlider = false,
  hideHints = false,
  enableHaptics = true,
  enableTapToFocus = true,
  labels,
  className,
  style,
  formats,
  roi,
  cooldownMs,
  stableFrames,
  quality,
  camera,
}: BarcodeScannerViewProps) {
  const mergedLabels = { ...DEFAULT_LABELS, ...labels };

  const handleDetect = useCallback(
    (result: ScanResult) => {
      if (enableHaptics && typeof navigator !== "undefined" && navigator.vibrate) {
        try {
          navigator.vibrate(40);
        } catch {
        }
      }
      onScan(result);
    },
    [onScan, enableHaptics],
  );

  const [hint, setHint] = useState<HintState>({ kind: null });
  const hintCountsRef = useRef({ tooDark: 0, glare: 0, moveCloser: 0, holdSteady: 0 });
  const goodCountRef = useRef(0);
  const [zoomValue, setZoomValue] = useState<number | null>(null);
  const [focusPing, setFocusPing] = useState<{ x: number; y: number; key: number } | null>(null);

  const handleFrameStats = useCallback(
    (stats: FrameStats) => {
      onFrameStats?.(stats);
      if (hideHints) return;

      const counts = hintCountsRef.current;
      const tooDark = stats.meanLuma < 60;
      const glare = stats.saturatedRatio > 0.01 || stats.recoveryActive;
      const moveCloser = stats.bboxFrac > 0 && stats.bboxFrac < 0.08;
      const holdSteady = stats.recoveryActive && stats.bboxFrac > 0.1;

      counts.tooDark = tooDark ? counts.tooDark + 1 : 0;
      counts.glare = glare ? counts.glare + 1 : 0;
      counts.moveCloser = moveCloser ? counts.moveCloser + 1 : 0;
      counts.holdSteady = holdSteady ? counts.holdSteady + 1 : 0;

      const triggered: HintKind | null =
        counts.tooDark >= HINT_STREAK
          ? "tooDark"
          : counts.glare >= HINT_STREAK
            ? "glare"
            : counts.moveCloser >= HINT_STREAK
              ? "moveCloser"
              : counts.holdSteady >= HINT_STREAK
                ? "holdSteady"
                : null;

      if (triggered) {
        goodCountRef.current = 0;
        setHint((prev) => (prev.kind === triggered ? prev : { kind: triggered }));
      } else {
        goodCountRef.current += 1;
        if (goodCountRef.current >= HINT_CLEAR_STREAK) {
          setHint((prev) => (prev.kind === null ? prev : { kind: null }));
        }
      }
    },
    [onFrameStats, hideHints],
  );

  const {
    videoRef,
    isScanning,
    error,
    hasTorch,
    torchOn,
    cameraInfo,
    toggleTorch,
    setZoom,
    tapToFocus,
  } = useScanner({
    enabled: active,
    onDetect: handleDetect,
    onError,
    onFrameStats: handleFrameStats,
    formats,
    roi,
    cooldownMs,
    stableFrames,
    quality,
    camera,
  });

  useEffect(() => {
    if (!isScanning) {
      setHint({ kind: null });
      hintCountsRef.current = { tooDark: 0, glare: 0, moveCloser: 0, holdSteady: 0 };
      setZoomValue(null);
      return;
    }
    if (cameraInfo?.hasZoom && zoomValue === null) {
      setZoomValue(cameraInfo.zoomMin);
    }
  }, [isScanning, cameraInfo, zoomValue]);

  const onZoomInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(event.target.value);
      setZoomValue(value);
      void setZoom(value);
    },
    [setZoom],
  );

  const onTap = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enableTapToFocus || !cameraInfo?.hasPointsOfInterest) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      setFocusPing({ x: event.clientX - rect.left, y: event.clientY - rect.top, key: Date.now() });
      void tapToFocus(x, y);
    },
    [enableTapToFocus, cameraInfo, tapToFocus],
  );

  const effectiveRoi = roi ?? DEFAULT_ROI;
  const showZoom = !hideZoomSlider && isScanning && cameraInfo?.hasZoom && zoomValue !== null;
  const showHint = !hideHints && isScanning && hint.kind !== null;
  const tapEnabled = enableTapToFocus && isScanning && cameraInfo?.hasPointsOfInterest;

  return (
    <div className={`bcsdk-view${className ? ` ${className}` : ""}`} style={style}>
      <video ref={videoRef} className="bcsdk-video" muted playsInline />
      {tapEnabled && (
        <div
          className="bcsdk-tap-layer"
          role="presentation"
          onPointerDown={onTap}
        />
      )}
      {focusPing && (
        <span
          key={focusPing.key}
          className="bcsdk-focus-ring"
          style={{ left: focusPing.x, top: focusPing.y }}
          aria-hidden="true"
        />
      )}
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
      {showHint && (
        <div className="bcsdk-hint" role="status" aria-live="polite">
          {mergedLabels[hint.kind!]}
        </div>
      )}
      {!isScanning && active && (
        <div className="bcsdk-overlay-cta">
          <span className="bcsdk-cta">{mergedLabels.starting}</span>
        </div>
      )}
      {showZoom && cameraInfo && (
        <label className="bcsdk-zoom">
          <span aria-hidden="true">{mergedLabels.zoom}</span>
          <input
            type="range"
            min={cameraInfo.zoomMin}
            max={cameraInfo.zoomMax}
            step={cameraInfo.zoomStep}
            value={zoomValue ?? cameraInfo.zoomMin}
            onChange={onZoomInput}
            aria-label={mergedLabels.zoom}
          />
          <span className="bcsdk-zoom-label">
            {(zoomValue ?? cameraInfo.zoomMin).toFixed(1)}×
          </span>
        </label>
      )}
      {!hideTorchButton && isScanning && hasTorch && (
        <button
          type="button"
          className={`bcsdk-torch${torchOn ? " bcsdk-torch-on" : ""}`}
          onClick={() => void toggleTorch()}
          aria-label={torchOn ? mergedLabels.torchOn : mergedLabels.torchOff}
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
