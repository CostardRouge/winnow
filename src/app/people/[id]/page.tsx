import PersonDetail from "./PersonDetail";

// One person: their media grid (the gallery's own tiles + viewer), the rename
// field, the cover-face picker and the merge action. The URL carries the person
// id, so a stack is linkable from anywhere (the /people shelf, a facet chip).
export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PersonDetail personId={Number.parseInt(id, 10)} />;
}
