import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { SettingsDialog } from "../settings-dialog";

export function TopBar() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="app-topbar">
      <Link to="/" className="brand-lockup">
        <Logo />
      </Link>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">Sessions</Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          Settings
        </Button>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
