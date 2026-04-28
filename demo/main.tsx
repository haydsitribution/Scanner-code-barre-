import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BarcodeScannerModal,
  BarcodeScannerView,
  type ScanResult,
} from "@/index";
import "@/styles/ui.css";

interface DetectionEntry {
  id: number;
  code: string;
  format: string;
  at: number;
}

let entryCounter = 0;
type Mode = "view" | "modal";

function App() {
  const initialMode: Mode = new URLSearchParams(window.location.search).get("mode") === "modal" ? "modal" : "view";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [active, setActive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [entries, setEntries] = useState<DetectionEntry[]>([]);

  const handleScan = useCallback((result: ScanResult) => {
    setEntries((prev) => [
      { id: ++entryCounter, code: result.code, format: result.format, at: Date.now() },
      ...prev.slice(0, 49),
    ]);
  }, []);

  const handleModalScan = useCallback(
    (result: ScanResult) => {
      handleScan(result);
      setModalOpen(false);
    },
    [handleScan],
  );

  function setModeAndUpdateUrl(next: Mode) {
    setMode(next);
    const url = new URL(window.location.href);
    if (next === "modal") url.searchParams.set("mode", "modal");
    else url.searchParams.delete("mode");
    window.history.replaceState(null, "", url.toString());
  }

  return (
    <main className="demo-shell">
      <h1>Barcode Scanner SDK Demo</h1>
      <div className="actions">
        <button className={`btn ghost${mode === "view" ? " active" : ""}`} onClick={() => setModeAndUpdateUrl("view")}>Inline view</button>
        <button className={`btn ghost${mode === "modal" ? " active" : ""}`} onClick={() => setModeAndUpdateUrl("modal")}>Modal</button>
      </div>
      {mode === "view" && (
        <>
          {!active && <button className="btn primary" onClick={() => setActive(true)}>Demarrer la camera</button>}
          {active && <BarcodeScannerView active={active} onScan={handleScan} />}
          {active && <button className="btn danger" onClick={() => setActive(false)}>Arreter</button>}
        </>
      )}
      {mode === "modal" && (
        <>
          <button className="btn primary" onClick={() => setModalOpen(true)}>Ouvrir le scanner modal</button>
          <BarcodeScannerModal open={modalOpen} onClose={() => setModalOpen(false)} onScan={handleModalScan} />
        </>
      )}
      <ul className="log">
        {entries.length === 0 && <li className="empty">En attente d un code...</li>}
        {entries.map((entry) => (
          <li key={entry.id} className="hit">
            <code>{entry.code}</code>
            <span className="format">{entry.format}</span>
            <span className="time">{new Date(entry.at).toLocaleTimeString("fr-FR")}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing root");
createRoot(container).render(<App />);
