import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Codevil</h1>
      <p className="mt-2 text-muted-foreground">No sessions yet.</p>
    </div>
  );
}
