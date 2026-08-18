import type { Metadata } from "next";
import TrashTab from "../../TrashTab";

export const metadata: Metadata = { title: "Trash · Library" };

// /library/trash — reclaim space: empty the recycle bin of rejected/deleted shots.
export default function TrashPage() {
  return <TrashTab />;
}
