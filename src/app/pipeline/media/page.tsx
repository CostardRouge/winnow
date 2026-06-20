import PipelineAssetList from "../PipelineAssetList";

// Every indexed media, newest captures first. Lets you jump to the full preview
// or soft-delete an item (the RAW original is never touched — reversible).
export default function MediaPage() {
  return (
    <PipelineAssetList
      query=""
      actions={["view", "delete"]}
      hint="All indexed media, newest first. Open the full preview or remove an item from the library (the original file is never touched)."
      emptyTitle="No media yet"
      emptyHint="Indexed photos and videos will appear here as roots are scanned."
    />
  );
}
