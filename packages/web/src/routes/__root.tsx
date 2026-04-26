import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TopBar } from "@/components/layout/top-bar";

export const Route = createRootRoute({
  component: () => (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <TopBar />
      <Outlet />
    </div>
  ),
});
