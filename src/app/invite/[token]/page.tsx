import type { Metadata } from "next";
import InviteForm from "./InviteForm";

// Invite acceptance screen — the one-time /invite/<token> URL the admin hands
// over out of band. The person it names chooses their own password here (the
// admin never knows it) and lands signed in. Public route: the token is the
// credential (cf. lib/authz.ts).
export const metadata: Metadata = { title: "You're invited" };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <InviteForm token={(await params).token} />;
}
