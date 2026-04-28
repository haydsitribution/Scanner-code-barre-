import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  BarcodeScannerView,
  type BarcodeScannerViewProps,
} from "./BarcodeScannerView";

export interface BarcodeScannerModalProps
  extends Omit<BarcodeScannerViewProps, "active" | "className" | "style"> {
  open: boolean;
  onClose: () => void;
}

export function BarcodeScannerModal({
  open,
  onClose,
  ...viewProps
}: BarcodeScannerModalProps) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="bcsdk-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bcsdk-modal-shell">
        <button
          type="button"
          className="bcsdk-modal-close"
          onClick={onClose}
          aria-label="Fermer le scanner"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
        <BarcodeScannerView active={open} {...viewProps} />
      </div>
    </div>,
    document.body,
  );
}
