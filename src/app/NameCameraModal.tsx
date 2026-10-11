"use client";

// "Name the camera…" — the one free-text entry of the camera-body flows
// (migration 0051, lib/deviceAttribution.ts labelDevice).
//
// Everywhere else a body is PICKED from the ones the library's files already
// name, because a typed string mints a gear card of its own. That rule stands;
// this is its sanctioned exception, for the case it cannot cover: media shot by
// a camera no file names — a friend's Sony exported without metadata, the
// wedding photographer's, photos received through WhatsApp (which strips EXIF).
// Picking the nearest known body there is a lie the gear shelf then repeats.
//
// What keeps the exception from becoming drift: the name is recorded with its
// own provenance ('named'), so it reads as typed everywhere it shows; the names
// already given are offered first, and the server reuses one whatever its case
// or spacing; and a name that is really a body a file declares is refused.
import { useEffect, useRef, useState } from "react";
import { Spinner } from "./ui";
import type { KnownBody } from "@/lib/deviceTypes";

export default function NameCameraModal({
  what,
  named,
  onClose,
  onSubmit,
}: {
  /** What the name lands on, as a phrase: "the 14 media of Pot de départ". */
  what: string;
  /** The cameras already named by hand, busiest first — offered as chips. */
  named: KnownBody[];
  onClose: () => void;
  /** Writes the name; resolves to an error to show, or null once done. */
  onSubmit: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const trimmed = name.trim();

  async function submit(value = trimmed) {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(value);
    // On success the host closes the dialog; on an error it stays, with the
    // server's reason (a name that is really a body a file declares).
    if (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Name the camera"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3 className="modal-title">Name the camera</h3>
        <div className="modal-body">
          {error && (
            <p className="dev-pick-warn" role="alert">
              {error}
            </p>
          )}
          <p>
            For {what}, shot by a camera none of the library’s files names — a
            friend’s, a wedding photographer’s, photos received through
            WhatsApp. The name becomes a body of its own on the gear shelf,
            marked as named by hand; nothing is written into the files.
          </p>
          <input
            ref={input}
            className="input dev-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Emeric’s camera"
            maxLength={200}
            aria-label="Camera name"
            disabled={busy}
          />
          {named.length > 0 && (
            <>
              <p className="dev-pick-note">Already named:</p>
              <div className="chips dev-name-chips">
                {named.map((b) => (
                  <button
                    key={b.device}
                    type="button"
                    className={`chip${trimmed.toLowerCase() === b.device.toLowerCase() ? " active" : ""}`}
                    onClick={() => setName(b.device)}
                    disabled={busy}
                    title={`${b.count.toLocaleString()} media carry it`}
                  >
                    {b.device}
                    <span className="chip-count">{b.count.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !trimmed}
          >
            {busy ? <Spinner sm /> : "Name it"}
          </button>
        </div>
      </form>
    </div>
  );
}
