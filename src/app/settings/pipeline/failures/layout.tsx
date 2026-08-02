import FailuresNav from "./FailuresNav";

// Shared chrome for Settings › Pipeline › Failures: the one-line intro and the
// family tab bar, above whichever family page is open. Each family is its own
// sub-route, so the tab bar is plain links and a copied URL lands back on the
// same list.
export default function FailuresLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="pl-section">
      <div className="filterbar">
        <span className="hint">
          Everything that failed (scan · analyze · import · deduplication), in
          one place. Pick a family below, fix the cause, then retry per item, by
          selection, or by family.
        </span>
      </div>
      <FailuresNav />
      {children}
    </div>
  );
}
