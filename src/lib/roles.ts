// Rôle d'un dossier (root), déduit de `roots.kind` — source de vérité unique.
//   incoming = à trier (inbox + incoming)        → kind ∈ ('source','inbox')
//   final    = déjà finalisé, consultation seule  → kind = 'finals'
//
// Le classement est AUTOMATIQUE (pas de bascule manuelle par dossier) : on
// ajoute les dossiers finaux via la config (FINALS_DIRS) ou l'API /api/roots,
// et tout le reste (scans, incoming, inbox) relève de l'Incoming. Garder cette
// logique ici évite de la dupliquer entre l'UI, les filtres et le SQL.
import type { Root } from "./types";

export type Role = "incoming" | "final";

export function roleForKind(kind: string): Role {
  return kind === "finals" ? "final" : "incoming";
}

// Kinds Postgres correspondant à un rôle (pour les clauses SQL `= ANY`).
export function kindsForRole(role: Role): Root["kind"][] {
  return role === "final" ? ["finals"] : ["source", "inbox"];
}
