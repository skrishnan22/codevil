import { createRootRoute, Outlet, useLocation } from "@tanstack/react-router";
import { TopBar } from "@/components/layout/top-bar";

export const Route = createRootRoute({
  component: function Root() {
    const location = useLocation();
    const isSessionRoute = location.pathname.startsWith('/session/');
    
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        {!isSessionRoute && <TopBar />}
        <Outlet />
      </div>
    );
  },
});
