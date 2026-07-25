import GearPanel from "./GearPanel";

// Dedicated Gear page: the shelf of every camera body and lens the library was
// shot with, drawn as line-art and counted from the EXIF. The inverse of the
// gallery's device/lens filter chips — instead of "narrow the grid by camera",
// it answers "what have I shot with, and how much" at a glance, then links each
// piece of gear back to its frames.
export default function GearPage() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Gear</h1>
        <span className="hint max-sm:hidden">what the library was shot with</span>
      </div>
      <div className="pipeline-body">
        <GearPanel />
      </div>
    </div>
  );
}
