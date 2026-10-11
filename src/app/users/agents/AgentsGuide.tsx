"use client";

// Users › Agents: connecting Claude (or any MCP client) to this library, in
// four numbered steps over the live state — pick the app, mint an agent's
// token, connect, try it. Atelier has the same guide (#/agents there); the
// steps differ because Winnow's bridge needs a credential and Atelier's a
// browser tab.
//
// Nothing here is new machinery: the token is minted by the very modal
// Users › App tokens uses (preset to "An agent"), the setup lines are the
// ones its secret modal prints, and the bridge is the file the instance
// serves under /agent/ (scripts/build-agent-bridge.ts). The clear token lives
// in this page's state only, for the minutes the person follows the steps —
// leaving the page loses it, exactly like closing the secret modal.
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { formatRelativeTime } from "@/lib/format";
import type { TokenRole, UserRole } from "@/lib/authz";
import { Icons, LoadingState } from "../../ui";
import { OptionPicker, type PickerOption } from "../../OptionPicker";
import {
  CopyRow,
  CreateTokenModal,
  claudeCodeSetup,
  type Account,
  type Minted,
} from "../tokens/TokensPanel";

type App = "code" | "desktop" | "other";

const APPS: PickerOption<App>[] = [
  { key: "code", label: "Claude Code", hint: "The terminal app — one line to paste" },
  { key: "desktop", label: "Claude Desktop", hint: "The desktop app — an extension to open, no terminal" },
  { key: "other", label: "Another MCP app", hint: "Any client that runs a local MCP server over stdio" },
];

type AgentToken = {
  id: number;
  name: string;
  agent: boolean;
  role: TokenRole;
  effectiveRole: UserRole;
  owner: { username: string; disabled: boolean };
  lastUsedAt: string | null;
  expired: boolean;
};

// Prompts that exercise the loop end to end, mildest first: the first only
// reads, the last writes — and a read-only token is refused it with the
// reason, which is itself a useful first test.
const PROMPTS = [
  "Call winnow_status and tell me which account you act as and whether you may write.",
  "List the Incoming folders still to sort, smallest first, and show me the pictures of the first one.",
  "In folder <id>, compare each burst with assets.lookMany, pick the sharpest frame of each and reject the rest of the pile. Tell me what you did.",
  "Find my best sunset pictures from 2025 with assets.search, look at them, and give the five best 4 stars and the tag “sunsets”.",
];

function bridgeDownload(origin: string): string {
  return `mkdir -p ~/.winnow && curl -fsSL ${origin}/agent/winnow-mcp.mjs -o ~/.winnow/winnow-mcp.mjs`;
}

function mcpServersJson(origin: string, secret: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        winnow: {
          command: "node",
          args: ["/absolute/path/to/.winnow/winnow-mcp.mjs"],
          env: { WINNOW_HOST: origin, WINNOW_TOKEN: secret },
        },
      },
    },
    null,
    2,
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={`guide-step${done ? " is-done" : ""}`} aria-label={done ? `Step ${n}, done` : `Step ${n}`}>
      <span className="guide-num" aria-hidden="true">
        {done ? "✓" : n}
      </span>
      <div className="guide-body">
        <h3 className="section-title">{title}</h3>
        {children}
      </div>
    </li>
  );
}

export default function AgentsGuide() {
  const [app, setApp] = useState<App>("code");
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [meId, setMeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<Minted | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const load = useCallback(async () => {
    try {
      const [list, users, whoami] = await Promise.all([
        fetchJson<{ tokens: AgentToken[] }>("/api/auth/tokens"),
        fetchJson<{ users: Account[] }>("/api/auth/users"),
        fetchJson<{ user: { id: number } }>("/api/auth/me"),
      ]);
      setTokens(list.tokens.filter((t) => t.agent));
      setAccounts(users.users);
      setMeId(whoami.user.id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingState label="Loading agents…" />;

  const live = tokens.filter((t) => !t.expired && !t.owner.disabled);
  const secret = minted?.secret ?? "wnw_…";

  return (
    <div className="guide">
      <div className="pane-head">
        <div>
          <h2 className="pane-title">Connect an agent</h2>
          <p className="pane-desc hint">
            Claude can browse the library, look at the pictures and cull them for
            you — through the same requests this app makes, with a token you can
            limit to reading and revoke at any time. Its ratings are marked as an
            agent’s, so you can tell its picks from yours.
          </p>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <ol className="guide-steps">
        <Step n={1} title="Pick the app you use">
          <OptionPicker options={APPS} value={app} onChange={setApp} ariaLabel="Agent app" />
          <p className="hint">{APPS.find((a) => a.key === app)?.hint}</p>
        </Step>

        <Step n={2} title="Mint a token for the agent" done={minted != null}>
          <p className="section-desc hint">
            <b>Read only</b> lets it browse and look; <b>Read &amp; write</b> also
            lets it rate, tag and send its rejects to the trash. Start read-only;
            you can mint another later. It never reaches settings, volumes or
            the originals.
          </p>
          {minted ? (
            <p className="hint">
              <b>{minted.name}</b> is ready. Its token is filled in below and
              shown only while you stay on this page.
            </p>
          ) : (
            <>
              <div>
                <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                  {Icons.key} Create an agent token
                </button>
              </div>
              {live.length > 0 && (
                <p className="hint">
                  Already minted: {live.map((t) => `${t.name} (${t.effectiveRole === "viewer" ? "read only" : "read & write"}, used ${formatRelativeTime(t.lastUsedAt)})`).join(" · ")}.
                  Winnow keeps no copy of a token it could show again — use the one
                  you saved, or create another.
                </p>
              )}
            </>
          )}
        </Step>

        <Step n={3} title={`Connect ${APPS.find((a) => a.key === app)?.label}`}>
          {app === "code" && (
            <>
              <p className="section-desc hint">
                Paste this line in a terminal on the computer where you use Claude
                Code (Node 18 or later). It downloads the bridge from this instance
                and registers it with your token, in your own settings — never in
                a project’s files.
              </p>
              <CopyRow label="Terminal" value={claudeCodeSetup(origin, secret)} />
              <p className="hint">
                Then start <code>claude</code>: the Winnow tools appear under{" "}
                <code>/mcp</code>.
              </p>
            </>
          )}
          {app === "desktop" && (
            <>
              <p className="section-desc hint">
                Download the extension and open it: Claude Desktop shows an install
                dialog and asks for the two values below. It keeps the token in
                your system’s keychain.
              </p>
              <div>
                <a className="btn" href="/agent/winnow.mcpb" download>
                  Download the Winnow extension
                </a>
              </div>
              <CopyRow label="Winnow address" value={origin} />
              {minted && <CopyRow label="Agent token" value={minted.secret} />}
            </>
          )}
          {app === "other" && (
            <>
              <p className="section-desc hint">
                Download the bridge — one JavaScript file, Node 18 or later, no
                dependency — then add it to your app’s MCP servers with the
                absolute path you saved it to.
              </p>
              <CopyRow label="Download" value={bridgeDownload(origin)} />
              <span className="modal-label">MCP servers (JSON)</span>
              <pre className="guide-code">{mcpServersJson(origin, secret)}</pre>
            </>
          )}
          {!minted && (
            <p className="hint">
              Replace <code>wnw_…</code> with your agent token.
            </p>
          )}
        </Step>

        <Step n={4} title="Try it">
          <p className="section-desc hint">
            Ask Claude in plain words; it chooses the commands. A few to start
            with, from reading only to culling:
          </p>
          <ul className="guide-prompts">
            {PROMPTS.map((p) => (
              <li key={p}>
                <CopyRow label="Prompt" value={p} bare />
              </li>
            ))}
          </ul>
        </Step>
      </ol>

      <details className="card-rules">
        <summary>Good to know</summary>
        <p>
          <b>What it can do</b>: list days, folders, people, facets; search by
          meaning; look at thumbnails and proxies; set verdicts, stars and colour
          labels (500 media at most a call, a whole burst pile at once); tag; send
          media it already <i>rejected</i> to the trash and restore them. Not:
          export, geotag, purge, settings, volumes or users.
        </p>
        <p>
          <b>Its marks</b>: a rating it sets reads <code>by: agent</code> and is
          stored as <code>rated_via = agent</code>; rate the frame yourself and the
          mark goes. Tags and the trash record no author.
        </p>
        <p>
          <b>After a Winnow update</b>: re-run the download (Claude Code, other
          apps) or download the extension again (Claude Desktop) to get the new
          commands.
        </p>
        <p>
          <b>To stop it</b>: revoke its token on <a href="/users/tokens">App
          tokens</a> — the next request is refused. Disabling the account does
          the same for all its tokens.
        </p>
      </details>

      {creating && (
        <CreateTokenModal
          accounts={accounts.filter((a) => !a.disabled)}
          defaultOwner={meId}
          defaultHolder="agent"
          defaultName="Claude"
          onClose={() => setCreating(false)}
          onCreated={async (m) => {
            setCreating(false);
            setMinted(m);
            await load();
          }}
        />
      )}
    </div>
  );
}
