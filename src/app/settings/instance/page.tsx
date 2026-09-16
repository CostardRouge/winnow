import type { Metadata } from "next";
import { describeInstance } from "@/lib/instance";

export const metadata: Metadata = { title: "Instance · Settings" };

// Settings › Instance — the effective configuration of this process, read-only.
//
// Rendered on the server with no endpoint behind it: the data is `process.env`
// as this container sees it, so there is nothing to fetch and no reason to serve
// the whole configuration as JSON to a browser that only needs to print it.
//
// `force-dynamic` is LOAD-BEARING here, for a different reason than everywhere
// else in the tree. The usual one is staleness — a DB-backed route pre-rendered
// at build time serves frozen numbers. This page would be worse than stale: the
// image is built in CI (.github/workflows/docker-build.yml), so a pre-rendered
// copy would bake the BUILD RUNNER's environment into the page and then present
// it, on the Optiplex, as that box's configuration. Every value would be a
// default, and the drift count this page exists for would read 100 %.
export const dynamic = "force-dynamic";

// Admin-only, enforced centrally in `src/lib/authz.ts` (ADMIN_ONLY_PREFIXES)
// rather than here: the page names internal hostnames, filesystem layout and
// which credentials exist, which is the same "reading it is already sensitive"
// class as the user list. The Settings tab bar hides itself to match.
// `formatDuration` in lib/format is a CLIP length (h:mm:ss) and would print a
// nine-day uptime as "216:43:12". An uptime wants its largest two units.
// Stated in UTC and labelled as such. `formatDateTime` renders in the runtime's
// locale and zone, which on a server-rendered page is the CONTAINER's — it would
// present the box's clock as though it were the reader's. The containers run
// UTC; saying so is cheaper than pretending to know where the reader is.
function startedLabel(iso: string): string {
  return `${new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function uptimeLabel(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export default function InstancePage() {
  const { runtime, groups, counts } = describeInstance();

  return (
    // The layout above supplies no padding or scroll — each plain section owns
    // its own, the same `.pipeline-body` as Volumes and Database.
    <div className="pipeline-body">
    <div className="inst-page">
      <div className="pane-head">
        <div>
          <h2 className="pane-title">Instance</h2>
          <p className="hint pane-desc">
            How this container is configured, as it is actually running — the
            environment tier, which needs a restart to change and is therefore
            shown read-only. The live settings are on Pipeline, the optional
            sections under Features.
          </p>
        </div>
      </div>

      <div className="statbar inst-statbar">
        <div className="stat">
          <div className="stat-value">{counts.total}</div>
          <div className="stat-label">Settings shown</div>
          <div className="stat-sub">grouped by subsystem</div>
        </div>
        {/* No verdict tone on this one: green would say "good" about a number
            that is neutral — a container is not better for setting more
            variables than it needs (UI review H4: green/red are a verdict on a
            frame, never a count). */}
        <div className="stat">
          <div className="stat-value">{counts.fromEnv}</div>
          <div className="stat-label">From the environment</div>
          <div className="stat-sub">set for this container</div>
        </div>
        {/* Amber is attention, and only when there is something to attend to —
            never on a zero. */}
        <div className={`stat${counts.defaults > 0 ? " warn" : ""}`}>
          <div className="stat-value">{counts.defaults}</div>
          <div className="stat-label">On their default</div>
          <div className="stat-sub">not set anywhere</div>
        </div>
        <div className="stat">
          <div className="stat-value">{uptimeLabel(runtime.uptimeSeconds)}</div>
          <div className="stat-label">Uptime</div>
          <div className="stat-sub">since {startedLabel(runtime.startedAt)}</div>
        </div>
      </div>

      {/* The one caveat that makes the numbers above honest. A value showing
          "default" is not proof it is unset in production: the worker is a
          separate container, and this page can only report its own. */}
      <p className="hint inst-caveat">
        <strong>On their default</strong> means the variable is not set in{" "}
        <em>this</em> container, so the schema&rsquo;s value is what is running.
        That is the cheapest way to catch a knob you believe you tuned and did
        not — a variable missing from the compose environment fails silently,
        because the default keeps everything working. Two things to hold
        alongside it: the worker runs as its own container with its own
        environment, and this is the app&rsquo;s view of it; and a variable
        deliberately set to the same value as the default counts as set, which
        is why the source is stated per row rather than inferred from the value.
        Running {runtime.node} on {runtime.platform}.
      </p>

      {groups.map((g) => (
        <section key={g.id} className="inst-group">
          <div className="section-head">
            <h3 className="section-title">
              {g.label}
              {g.on === false && <span className="tag inst-off">off</span>}
            </h3>
            <p className="hint section-desc">{g.blurb}</p>
          </div>
          <div className="vol-table-wrap">
            <table className="vol-table inst-table">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {g.fields.map((f) => (
                  <tr key={f.env}>
                    <td>
                      <div className="inst-label">{f.label}</div>
                      <div className="vol-path inst-env">{f.env}</div>
                      {f.note && <div className="hint inst-note">{f.note}</div>}
                    </td>
                    <td>
                      <span
                        className={`inst-value${f.secret ? " is-secret" : ""}`}
                      >
                        {f.value}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`tag ${f.fromEnv ? "tag-origin" : "inst-default"}`}
                      >
                        {f.fromEnv ? "env" : "default"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
    </div>
  );
}
