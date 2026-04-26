import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "../settings-dialog";

export function TopBar() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="flex h-14 items-center justify-between border-b px-4">
      <Link to="/" className="text-lg font-semibold">
        Codevil
      </Link>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" asChild>
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
