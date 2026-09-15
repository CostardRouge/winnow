"use client";

// Shared "Download ▾" dropdown: one labelled trigger that drops the three ways to
// pull a set of files out of the browser (ZIP · each file · save to folder).
// The items themselves come from `useDownloadItems`, so a row's ⋯ menu can
// carry the same three entries without nesting a menu in a menu.
import ActionMenu from "./ActionMenu";
import { Icons } from "./ui";
import { useDownloadItems, type DownloadSource } from "./useDownloadItems";

export default function DownloadMenu({
  zipHref,
  zipName,
  listFiles,
  label = "Download",
  triggerClassName = "seg-btn",
  disabled = false,
  onMessage,
}: DownloadSource & {
  label?: string;
  /** Trigger button class (defaults to a segmented-control segment). */
  triggerClassName?: string;
  disabled?: boolean;
}) {
  const { items, busy } = useDownloadItems({
    zipHref,
    zipName,
    listFiles,
    onMessage,
  });

  return (
    <ActionMenu
      ariaLabel="Download options"
      label={label}
      items={items}
      disabled={disabled || busy}
      trigger={{
        label: busy ? "Downloading…" : label,
        icon: Icons.download,
        className: triggerClassName,
      }}
    />
  );
}
