"use client";

import ActionMenu, { type MenuItem } from "@/app/ActionMenu";
import { Icons } from "@/app/ui";
import {
  useDownloadItems,
  type DownloadSource,
} from "@/app/useDownloadItems";

/**
 * The ⋯ menu of a session: everything that is not THE action of the moment.
 * A session card shows one primary verb (Sift what is left, or Export the
 * picks once sorting is done) and keeps the rest here — Ignore, Export picks,
 * Geotag, Restack, the three download options — with Delete last and set
 * apart (UI review H2). It takes the same props as the segmented
 * SessionActions strip it replaces on the cards, so the session page can
 * adopt it in turn.
 *
 * There is no "complete" entry: whether a session is done is computed from its
 * verdict coverage, not hand-set. "Ignore" is the lone manual flag — "skip this
 * whole session" — which cascades the assets to ignored.
 */
export default function SessionMenu({
  ignored,
  canExport,
  onIgnore,
  onExportPicks,
  onGeotag,
  onRestack,
  onDelete,
  download,
  deleteHint = "Remove the session; its files can go with it",
}: {
  ignored: boolean;
  /** Whether the session has any picks to export (disables that entry). */
  canExport: boolean;
  onIgnore: () => void;
  onExportPicks: () => void;
  /** When provided, adds Geotag: set the capture location of the whole
   * session (location picker + per-media before/after recap). */
  onGeotag?: () => void;
  /** When provided, adds Restack: re-cluster the session's burst piles from
   * scratch with the current thresholds (cf. lib/bursts.ts). Non-destructive —
   * ratings are per-frame and survive. */
  onRestack?: () => void;
  onDelete: () => void;
  /** When provided, adds the three download entries for the originals. */
  download?: DownloadSource;
  /** Context-specific second line under Delete. */
  deleteHint?: string;
}) {
  const dl = useDownloadItems(download);

  const items: MenuItem[] = [
    {
      key: "ignore",
      label: ignored ? "Reactivate" : "Ignore",
      hint: ignored ? "Back into the queue" : "Skip this whole session",
      icon: ignored ? Icons.reset : Icons.skip,
      onSelect: onIgnore,
    },
    {
      key: "export",
      label: "Export picks",
      hint: canExport
        ? "RAW picks to the Capture One folder"
        : "No picks to export yet",
      icon: Icons.upload,
      disabled: !canExport,
      onSelect: onExportPicks,
    },
    ...(onGeotag
      ? [
          {
            key: "geotag",
            label: "Geotag…",
            hint: "One location for every frame, with a recap",
            icon: Icons.mapPin,
            onSelect: onGeotag,
          } as MenuItem,
        ]
      : []),
    ...(onRestack
      ? [
          {
            key: "restack",
            label: "Restack bursts",
            hint: "Re-cluster the piles; ratings are kept",
            icon: Icons.regenerate,
            onSelect: onRestack,
          } as MenuItem,
        ]
      : []),
    ...dl.items,
    {
      key: "delete",
      label: "Delete…",
      hint: deleteHint,
      icon: Icons.trash,
      danger: true,
      sep: true,
      onSelect: onDelete,
    },
  ];

  return (
    <ActionMenu
      ariaLabel="Session actions"
      items={items}
      trigger={{ className: "btn btn-icon card-more" }}
    />
  );
}
