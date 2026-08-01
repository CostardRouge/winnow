import { redirect } from "next/navigation";

// /settings has no landing pane of its own — the tab bar's first entry is the
// content. Send it straight to Pipeline so the section always opens on a pane
// with the tabs already showing where you are.
export default function SettingsPage() {
  redirect("/settings/pipeline");
}
