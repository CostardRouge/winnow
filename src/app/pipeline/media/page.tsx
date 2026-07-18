import PipelineAssetList from "../PipelineAssetList";

// Every indexed media, browsable as a list, a virtualized thumbnail grid, or by
// folder — with a sort control and a derivative-status facet (All / Ready /
// Pending / Error / Skipped). The "Ready" facet is what the old "Analyzed" page
// showed, so it lives here now (deep-linked as ?status=ready). Actions: open the
// viewer, download the original, re-create a bad preview, or soft-delete an item
// (the RAW original is never touched — reversible).
export default function MediaPage() {
  return (
    <PipelineAssetList
      query=""
      actions={["view", "download", "regenerate", "delete"]}
      views={["list", "grid", "folder"]}
      showStatus
      hint="All indexed media. Switch between list, grid and folder views; filter by status, sort, or open the viewer."
      emptyTitle="No media yet"
      emptyHint="Indexed photos and videos will appear here as roots are scanned."
    />
  );
}
