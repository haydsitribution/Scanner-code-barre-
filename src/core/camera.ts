export interface OpenCameraOptions {
  deviceId?: string;
  idealWidth?: number;
  idealHeight?: number;
  minFrameRate?: number;
}

export interface CameraStream {
  stream: MediaStream;
  track: MediaStreamTrack;
  capabilities: MediaTrackCapabilities | null;
  settings: MediaTrackSettings;
}

interface ExtendedTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
  focusDistance?: { min: number; max: number; step: number };
  exposureMode?: string[];
  exposureCompensation?: { min: number; max: number; step: number };
  pointsOfInterest?: unknown;
  zoom?: { min: number; max: number; step: number };
}

interface ExtendedTrackConstraints extends MediaTrackConstraintSet {
  torch?: boolean;
  focusMode?: ConstrainDOMString;
  focusDistance?: ConstrainDouble;
  exposureMode?: ConstrainDOMString;
  exposureCompensation?: ConstrainDouble;
  pointsOfInterest?: Array<{ x: number; y: number }>;
  zoom?: ConstrainDouble;
}

export interface CameraCapabilitiesInfo {
  hasTorch: boolean;
  hasZoom: boolean;
  zoomMin: number;
  zoomMax: number;
  zoomStep: number;
  hasFocusDistance: boolean;
  focusDistanceMin: number;
  focusDistanceMax: number;
  hasPointsOfInterest: boolean;
  hasContinuousFocus: boolean;
  hasContinuousExposure: boolean;
}

const DEFAULTS = {
  idealWidth: 1920,
  idealHeight: 1080,
  minFrameRate: 30,
} as const;

export async function openCamera(
  options: OpenCameraOptions = {},
): Promise<CameraStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia not available in this environment");
  }

  const idealWidth = options.idealWidth ?? DEFAULTS.idealWidth;
  const idealHeight = options.idealHeight ?? DEFAULTS.idealHeight;
  const minFrameRate = options.minFrameRate ?? DEFAULTS.minFrameRate;

  const video: MediaTrackConstraints = options.deviceId
    ? { deviceId: { exact: options.deviceId } }
    : { facingMode: { ideal: "environment" } };

  video.width = { ideal: idealWidth };
  video.height = { ideal: idealHeight };
  video.frameRate = { ideal: minFrameRate, min: 15 };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video,
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("no video track in stream");
  }

  const capabilities = typeof track.getCapabilities === "function"
    ? track.getCapabilities()
    : null;

  const settings = track.getSettings();

  if (capabilities) {
    const ext = capabilities as ExtendedTrackCapabilities;
    if (ext.focusMode?.includes("continuous")) {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: "continuous" } as ExtendedTrackConstraints],
        });
      } catch {
      }
    }
    if (ext.exposureMode?.includes("continuous")) {
      try {
        await track.applyConstraints({
          advanced: [{ exposureMode: "continuous" } as ExtendedTrackConstraints],
        });
      } catch {
      }
    }
  }

  return { stream, track, capabilities, settings };
}

export function describeCameraCapabilities(camera: CameraStream): CameraCapabilitiesInfo {
  const ext = (camera.capabilities ?? {}) as ExtendedTrackCapabilities;
  const zoom = ext.zoom;
  const focus = ext.focusDistance;
  return {
    hasTorch: Boolean(ext.torch),
    hasZoom: Boolean(zoom),
    zoomMin: zoom?.min ?? 1,
    zoomMax: zoom?.max ?? 1,
    zoomStep: zoom?.step ?? 0.1,
    hasFocusDistance: Boolean(focus),
    focusDistanceMin: focus?.min ?? 0,
    focusDistanceMax: focus?.max ?? 0,
    hasPointsOfInterest: ext.pointsOfInterest !== undefined,
    hasContinuousFocus: Boolean(ext.focusMode?.includes("continuous")),
    hasContinuousExposure: Boolean(ext.exposureMode?.includes("continuous")),
  };
}

export function streamHasTorch(camera: CameraStream): boolean {
  if (!camera.capabilities) return false;
  const ext = camera.capabilities as ExtendedTrackCapabilities;
  return Boolean(ext.torch);
}

export async function applyTorch(
  camera: CameraStream,
  on: boolean,
): Promise<void> {
  if (!streamHasTorch(camera)) {
    throw new Error("torch is not supported on this device");
  }
  await camera.track.applyConstraints({
    advanced: [{ torch: on } as ExtendedTrackConstraints],
  });
}

export async function setZoom(camera: CameraStream, zoom: number): Promise<void> {
  const ext = (camera.capabilities ?? {}) as ExtendedTrackCapabilities;
  if (!ext.zoom) throw new Error("zoom not supported");
  const clamped = Math.max(ext.zoom.min, Math.min(ext.zoom.max, zoom));
  await camera.track.applyConstraints({
    advanced: [{ zoom: clamped } as ExtendedTrackConstraints],
  });
}

export async function setPointOfInterest(
  camera: CameraStream,
  xRatio: number,
  yRatio: number,
): Promise<void> {
  const x = Math.max(0, Math.min(1, xRatio));
  const y = Math.max(0, Math.min(1, yRatio));
  const ext = (camera.capabilities ?? {}) as ExtendedTrackCapabilities;
  const advanced: ExtendedTrackConstraints[] = [];
  if (ext.pointsOfInterest !== undefined) {
    advanced.push({ pointsOfInterest: [{ x, y }] });
  }
  if (ext.focusMode?.includes("single-shot")) {
    advanced.push({ focusMode: "single-shot" });
  } else if (ext.focusMode?.includes("manual") && ext.focusDistance) {
    const mid = (ext.focusDistance.min + ext.focusDistance.max) / 2;
    advanced.push({ focusMode: "manual", focusDistance: mid });
  }
  if (ext.exposureMode?.includes("single-shot")) {
    advanced.push({ exposureMode: "single-shot" });
  }
  if (advanced.length === 0) {
    throw new Error("tap-to-focus not supported");
  }
  await camera.track.applyConstraints({ advanced });
}

export async function setFocusContinuous(camera: CameraStream): Promise<void> {
  const ext = (camera.capabilities ?? {}) as ExtendedTrackCapabilities;
  if (!ext.focusMode?.includes("continuous")) {
    throw new Error("continuous focus not supported");
  }
  await camera.track.applyConstraints({
    advanced: [{ focusMode: "continuous" } as ExtendedTrackConstraints],
  });
}

export async function setFocusManual(
  camera: CameraStream,
  distance: number,
): Promise<void> {
  const ext = (camera.capabilities ?? {}) as ExtendedTrackCapabilities;
  if (!ext.focusMode?.includes("manual") || !ext.focusDistance) {
    throw new Error("manual focus not supported");
  }
  const clamped = Math.max(
    ext.focusDistance.min,
    Math.min(ext.focusDistance.max, distance),
  );
  await camera.track.applyConstraints({
    advanced: [
      { focusMode: "manual", focusDistance: clamped } as ExtendedTrackConstraints,
    ],
  });
}

export function closeCamera(camera: CameraStream | null): void {
  if (!camera) return;
  camera.stream.getTracks().forEach((t) => t.stop());
}
