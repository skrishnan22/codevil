import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { SettingsDialog } from "../settings-dialog";
import { loadConfig } from "@/lib/config";
import { getAuthMe, signOut, type AuthMeResponse } from "@/lib/api-client";
import { useTheme } from "@/hooks/use-theme";

function canManageTeam(auth: AuthMeResponse | null): boolean {
  const role = auth?.membership?.role;
  return role === "owner" || role === "admin";
}

export function TopBar() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [auth, setAuth] = useState<AuthMeResponse | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    const config = loadConfig();
    if (!config) return;
    void (async () => {
      try {
        const result = await getAuthMe(config);
        if (!cancelled) setAuth(result);
      } catch {
        /* keep topbar usable if auth fetch fails */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (!profileRef.current) return;
      if (!profileRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function handleSignOut() {
    const config = loadConfig();
    if (!config) return;
    try {
      await signOut(config);
    } catch {
      /* fall through to reload regardless */
    } finally {
      setMenuOpen(false);
      window.location.reload();
    }
  }

  const user = auth?.user;
  const showProfile = Boolean(user);
  const showTeam = canManageTeam(auth);
  const displayName = user?.name?.trim() || user?.email || "";
  const initial = (displayName || "?").slice(0, 1).toUpperCase();

  return (
    <header className="app-topbar">
      <Link to="/" className="brand-lockup">
        <Logo />
      </Link>
      <div className="flex items-center gap-1 ml-auto">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">Sessions</Link>
        </Button>
        {showTeam && (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/team">Team</Link>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          Settings
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? "☀" : "☾"}
        </Button>
        {showProfile && user && (
          <div ref={profileRef} style={{ position: "relative" }}>
            <button
              type="button"
              className="app-topbar-profile"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="app-topbar-profile-avatar" aria-hidden="true">
                {initial}
              </span>
              <span className="app-topbar-profile-name">{displayName}</span>
            </button>
            {menuOpen && (
              <div className="app-topbar-profile-menu" role="menu">
                <div className="app-topbar-profile-menu-head">
                  <div className="app-topbar-profile-menu-name">
                    {user.name?.trim() || user.email}
                  </div>
                  <div className="app-topbar-profile-menu-email">{user.email}</div>
                </div>
                <div className="app-topbar-profile-menu-divider" />
                <button
                  type="button"
                  className="app-topbar-profile-menu-action"
                  onClick={() => void handleSignOut()}
                  role="menuitem"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
