import PipelineAssetList from "../PipelineAssetList";

// Media awaiting (or mid-) derivative generation. From here you can re-queue a
// stuck item (Regenerate), pull it out of the pipeline (Skip) or remove it.
// Same reusable browser as Media (list / grid / folder + sort), scoped to the
// pending queue.
export default function PendingPage() {
  return (
    <PipelineAssetList
      query="derivative_status=pending,processing"
      actions={["download", "regenerate", "skip", "delete"]}
      views={["list", "grid", "folder"]}
      defaultSort={{ field: "processed", dir: "desc" }}
      hint="Media queued for (or mid-) analysis. There's no preview yet — download the original to inspect it, re-queue a stuck item, Skip it so it stops being processed, or remove it."
      emptyTitle="Queue is clear"
      emptyHint="Nothing is waiting for analysis right now. 🎉"
    />
  );
}
