interface LogoProps {
  /** Show the "Codevil" wordmark next to the mark. */
  wordmark?: boolean;
  className?: string;
}

/**
 * Single source of truth for the Codevil brand lockup. Used by both the home
 * top bar and the session top bar so the logo stays consistent everywhere.
 */
export function Logo({ wordmark = true, className }: LogoProps) {
  return (
    <span className={`cv-logo${className ? ` ${className}` : ""}`}>
      <span className="cv-logo-mark" aria-hidden="true" />
      {wordmark && <span className="cv-logo-word">Codevil</span>}
    </span>
  );
}
