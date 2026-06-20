import PipelineAssetList from "../PipelineAssetList";

// Media awaiting (or mid-) derivative generation. From here you can re-queue a
// stuck item (Regenerate), pull it out of the pipeline (Skip) or remove it.
export default function PendingPage() {
  return (
    <PipelineAssetList
      query="derivative_status=pending,processing&sort=recent"
      actions={["regenerate", "skip", "delete"]}
      hint="Media queued for (or mid-) analysis. Re-queue a stuck item, Skip it so it stops being processed, or remove it."
      emptyTitle="Queue is clear"
      emptyHint="Nothing is waiting for analysis right now. 🎉"
    />
  );
}
