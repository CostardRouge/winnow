"use client";

// Settings › Features — one switch per optional section of the app.
//
// The list is not written here: it comes from GET /api/features, which serves
// the registry in src/lib/features.ts. A section added to the rail therefore
// shows up on this page by itself, with its own blurb, and nothing can drift.
//
// A flip must move the rail under your hand — that is the feedback the switch
// owes. `router.refresh()` cannot do it (it does not re-render the ROOT layout,
// which is where the rail lives), so the confirmed answer is pushed straight
// into the shared context instead; see the header of FeaturesProvider.tsx.
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { useSetFeatures } from "../../FeaturesProvider";
import type { FeatureId, Features } from "@/lib/features";
import { Spinner } from "../../ui";

type Descriptor = {
  id: FeatureId;
  label: string;
  blurb: string;
  caveat?: string;
  default: boolean;
};

type Payload = {
  features: Features;
  registry: Descriptor[];
};

export default function FeaturesPanel() {
  const publish = useSetFeatures();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Payload>("/api/features"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = useCallback(
    async (id: FeatureId, next: boolean) => {
      // Optimistic: the switch answers immediately, and reverts if the PATCH
      // is refused (a viewer/editor account gets a 403 from the proxy guard).
      setData((d) =>
        d ? { ...d, features: { ...d.features, [id]: next } } : d,
      );
      setBusy(id);
      try {
        const res = await fetchJson<{ features: Features }>("/api/features", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [id]: next }),
        });
        setData((d) => (d ? { ...d, features: res.features } : d));
        setError(null);
        publish(res.features); // the rail redraws now, not on the next load
      } catch (e) {
        setError((e as Error).message);
        setData((d) =>
          d ? { ...d, features: { ...d.features, [id]: !next } } : d,
        );
      } finally {
        setBusy(null);
      }
    },
    [publish],
  );

  if (error && !data)
    return (
      <div className="error-box">
        <span>Couldn’t load the feature flags: {error}</span>
        <button className="btn" onClick={load}>
          Retry
        </button>
      </div>
    );

  if (!data) return <Spinner />;

  return (
    <div className="control">
      <div>
        <h2 className="feature-title">Sections</h2>
        <p className="hint control-note feature-intro">
          What this instance offers in the navigation rail. The Library is
          always there — browsing, culling and exporting is what Winnow is;
          everything below is built on top of it. A section that is off is not
          just hidden: its pages and its own API routes answer 404, so nothing
          — not a bookmark, not a client app — can reach a feature you have
          turned off.
        </p>
      </div>

      {error && <div className="error-box">{error}</div>}

      <ul className="feature-list">
        {data.registry.map((f) => {
          const on = Boolean(data.features[f.id]);
          return (
            <li key={f.id} className="feature-row">
              <label className="feature-switch">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy === f.id}
                  onChange={(e) => toggle(f.id, e.target.checked)}
                />
                <span className="feature-name">{f.label}</span>
              </label>
              <p className="feature-blurb">{f.blurb}</p>
              {f.caveat && <p className="feature-caveat">{f.caveat}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
