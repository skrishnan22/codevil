import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/session/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = Route.useParams();
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Session: {id}</h1>
    </div>
  );
}
