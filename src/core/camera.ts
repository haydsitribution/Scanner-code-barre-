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
  zoom?: { min: number; max: number; step: number };
}

interface ExtendedTrackConstraints extends MediaTrackConstraintSet {
  torch?: boolean;
  focusMode?: ConstrainDOMString;
  zoom?: ConstrainDouble;
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
  }

  return { stream, track, capabilities, settings };
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

export function closeCamera(camera: CameraStream | null): void {
  if (!camera) return;
  camera.stream.getTracks().forEach((t) => t.stop());
}
