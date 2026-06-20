import PipelineAssetList from "../PipelineAssetList";

// Ready derivatives, most recently processed first. These are done — kept as-is —
// but you can re-create a bad preview (Regenerate) or remove the media.
export default function AnalyzedPage() {
  return (
    <PipelineAssetList
      query="derivative_status=ready&sort=recent"
      actions={["view", "regenerate", "delete"]}
      hint="Latest derivatives processed (thumb + proxy ready). Re-create one if a preview looks wrong, or remove the media."
      emptyTitle="Nothing analyzed yet"
      emptyHint="Once derivatives are generated, the latest ones show up here."
    />
  );
}
