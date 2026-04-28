import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ScannerEngine, type ScannerEngineOptions } from "@/core/scanner-engine";
import type { ScanResult } from "@/core/types";

export interface UseScannerOptions
  extends Omit<ScannerEngineOptions, "video" | "onDetect" | "onError"> {
  enabled?: boolean;
  onDetect: (result: ScanResult) => void;
  onError?: (err: Error) => void;
}

export interface UseScannerHandle {
  videoRef: RefObject<HTMLVideoElement>;
  isScanning: boolean;
  error: Error | null;
  hasTorch: boolean;
  torchOn: boolean;
  start: () => Promise<void>;
  stop: () => void;
  toggleTorch: () => Promise<void>;
}

export function useScanner(options: UseScannerOptions): UseScannerHandle {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<ScannerEngine | null>(null);

  const onDetectRef = useRef(options.onDetect);
  const onErrorRef = useRef(options.onError);
  onDetectRef.current = options.onDetect;
  onErrorRef.current = options.onError;

  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

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
      camera: options.camera,
      onDetect: (result) => onDetectRef.current(result),
      onError: (err) => {
        setError(err);
        onErrorRef.current?.(err);
      },
    });
    engineRef.current = engine;

    try {
      await engine.start();
      setIsScanning(true);
      setHasTorch(engine.hasTorch());
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
    options.camera,
  ]);

  const stop = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setIsScanning(false);
    setHasTorch(false);
    setTorchOn(false);
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
    start,
    stop,
    toggleTorch,
  };
}
