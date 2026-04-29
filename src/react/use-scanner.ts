import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ScannerEngine, type ScannerEngineOptions } from "@/core/scanner-engine";
import type { CameraCapabilitiesInfo } from "@/core/camera";
import type { FrameStats, ScanResult } from "@/core/types";

export interface UseScannerOptions
  extends Omit<
    ScannerEngineOptions,
    "video" | "onDetect" | "onError" | "onFrameStats"
  > {
  enabled?: boolean;
  onDetect: (result: ScanResult) => void;
  onError?: (err: Error) => void;
  onFrameStats?: (stats: FrameStats) => void;
}

export interface UseScannerHandle {
  videoRef: RefObject<HTMLVideoElement>;
  isScanning: boolean;
  error: Error | null;
  hasTorch: boolean;
  torchOn: boolean;
  cameraInfo: CameraCapabilitiesInfo | null;
  start: () => Promise<void>;
  stop: () => void;
  toggleTorch: () => Promise<void>;
  setZoom: (zoom: number) => Promise<void>;
  tapToFocus: (xRatio: number, yRatio: number) => Promise<void>;
}

export function useScanner(options: UseScannerOptions): UseScannerHandle {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<ScannerEngine | null>(null);

  const onDetectRef = useRef(options.onDetect);
  const onErrorRef = useRef(options.onError);
  const onFrameStatsRef = useRef(options.onFrameStats);
  onDetectRef.current = options.onDetect;
  onErrorRef.current = options.onError;
  onFrameStatsRef.current = options.onFrameStats;

  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraInfo, setCameraInfo] = useState<CameraCapabilitiesInfo | null>(null);

  const start = useCallback(async () => {
    if (engineRef.current) return;
    const video = videoRef.current;
    if (!video) {
      const err = new Error("video ref is not attached");
      setError(err);
      onErrorRef.current?.(err);
      return;
    }
    setError(null);

    const engine = new ScannerEngine({
      video,
      formats: options.formats,
      roi: options.roi,
      cooldownMs: options.cooldownMs,
      stableFrames: options.stableFrames,
      quality: options.quality,
      camera: options.camera,
      onDetect: (result) => onDetectRef.current(result),
      onError: (err) => {
        setError(err);
        onErrorRef.current?.(err);
      },
      onFrameStats: (stats) => onFrameStatsRef.current?.(stats),
    });
    engineRef.current = engine;

    try {
      await engine.start();
      setIsScanning(true);
      setHasTorch(engine.hasTorch());
      setCameraInfo(engine.getCameraInfo());
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      onErrorRef.current?.(e);
      engine.destroy();
      engineRef.current = null;
    }
  }, [
    options.formats,
    options.roi,
    options.cooldownMs,
    options.stableFrames,
    options.quality,
    options.camera,
  ]);

  const stop = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setIsScanning(false);
    setHasTorch(false);
    setTorchOn(false);
    setCameraInfo(null);
  }, []);

  const toggleTorch = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const next = !torchOn;
      await engine.toggleTorch(next);
      setTorchOn(next);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      onErrorRef.current?.(e);
    }
  }, [torchOn]);

  const setZoomLevel = useCallback(async (zoom: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      await engine.setZoom(zoom);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      onErrorRef.current?.(e);
    }
  }, []);

  const tapToFocus = useCallback(async (xRatio: number, yRatio: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      await engine.tapToFocus(xRatio, yRatio);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      onErrorRef.current?.(e);
    }
  }, []);

  const enabled = options.enabled ?? false;

  useEffect(() => {
    if (enabled && !engineRef.current) {
      void start();
    }
    if (!enabled && engineRef.current) {
      stop();
    }
  }, [enabled, start, stop]);

  useEffect(() => {
    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  return {
    videoRef: videoRef as RefObject<HTMLVideoElement>,
    isScanning,
    error,
    hasTorch,
    torchOn,
    cameraInfo,
    start,
    stop,
    toggleTorch,
    setZoom: setZoomLevel,
    tapToFocus,
  };
}
