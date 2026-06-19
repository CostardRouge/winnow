"use client";

import { useRef, useState } from "react";
import Link from "next/link";

type BatchStatus = {
  id: number;
  origin: string;
  status: string;
  imported: number;
  duplicates: number;
  failed: number;
};

export default function ImportPage() {
  const [progress, setProgress] = useState<number | null>(null);
  const [offloadPath, setOffloadPath] = useState("");
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const [msg, setMsg] = useState<string>("");
  const fileInput = useRef<HTMLInputElement>(null);

  function pollBatch(id: number) {
    let errors = 0;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/import/${id}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        errors = 0;
        if (data.batch) {
          setBatch(data.batch);
          if (data.batch.status === "done" || data.batch.status === "error") {
            clearInterval(t);
          }
        }
      } catch {
        // Tolerate a few network hiccups, then give up the polling.
        if (++errors >= 5) {
          clearInterval(t);
          setMsg("Lost contact with the import job. Refresh to check status.");
        }
      }
    }, 1500);
  }

  function uploadFiles(files: FileList) {
    if (files.length === 0) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);

    setMsg(`Uploading ${files.length} file(s)…`);
    setProgress(0);
    setBatch(null);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setProgress(null);
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.batch_id) {
          setMsg(`Uploaded. Importing on the server…`);
          pollBatch(data.batch_id);
        } else {
          setMsg(`Error: ${data.error ?? xhr.statusText}`);
        }
      } catch {
        setMsg(`Error: ${xhr.statusText}`);
      }
      if (fileInput.current) fileInput.current.value = "";
    };
    xhr.onerror = () => {
      setProgress(null);
      setMsg("Upload failed.");
    };
    xhr.send(fd);
  }

  async function offload() {
    if (!offloadPath.trim()) return;
    setMsg("Queuing card offload…");
    setBatch(null);
    const r = await fetch("/api/import/offload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: offloadPath.trim() }),
    });
    const data = await r.json();
    if (data.batch_id) {
      setMsg("Offload queued. Importing…");
      pollBatch(data.batch_id);
    } else {
      setMsg(`Error: ${data.error ?? "unknown"}`);
    }
  }

  return (
    <>
      <div className="topbar">
        <Link href="/" className="btn">
          ←
        </Link>
        <h1>Import</h1>
      </div>

      <div className="container">
        <section style={{ marginBottom: 28 }}>
          <h3>From this device (phone)</h3>
          <p className="hint">
            Pick photos/videos; they upload to the inbox and get filed into the
            NAS automatically (deduped + organised by date/device).
          </p>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/*,video/*,.arw,.dng,.heic,.heif,.hif"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            className="input"
            style={{ display: "block", width: "100%", padding: 12 }}
          />
          {progress != null && (
            <div style={{ marginTop: 10 }}>
              <div
                style={{
                  height: 8,
                  background: "var(--panel-2)",
                  borderRadius: 999,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${progress}%`,
                    height: "100%",
                    background: "var(--accent)",
                  }}
                />
              </div>
              <span className="hint">{progress}%</span>
            </div>
          )}
        </section>

        <section style={{ marginBottom: 28 }}>
          <h3>From a card mounted on the server</h3>
          <p className="hint">
            Path of the inserted SD card (as seen inside the container, e.g.
            <code> /media/card</code>). The card is left untouched.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="/media/card"
              value={offloadPath}
              onChange={(e) => setOffloadPath(e.target.value)}
            />
            <button className="btn btn-primary" onClick={offload}>
              Offload
            </button>
          </div>
        </section>

        <section>
          <h3>SMB / FTP drop</h3>
          <p className="hint">
            Drop files into the watched inbox share — they import automatically.
            No action needed here.
          </p>
        </section>

        {msg && <p style={{ marginTop: 20 }}>{msg}</p>}
        {batch && (
          <div className="session-card" style={{ marginTop: 12 }}>
            <div>
              <strong>Batch #{batch.id}</strong> · {batch.origin} ·{" "}
              <span
                style={{
                  color:
                    batch.status === "done"
                      ? "var(--pick)"
                      : batch.status === "error"
                        ? "var(--reject)"
                        : "var(--star)",
                }}
              >
                {batch.status}
              </span>
              <div className="counters" style={{ marginTop: 8 }}>
                <span className="pill ready">{batch.imported} imported</span>
                <span className="pill">{batch.duplicates} duplicates</span>
                {batch.failed > 0 && (
                  <span className="pill error">{batch.failed} failed</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
