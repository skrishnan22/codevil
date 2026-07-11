import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface DetectPackageManagerOptions {
  cwd: string;
  root?: string;
  declared?: string;
  fallback?: PackageManager;
}

export function detectPackageManager(
  options: DetectPackageManagerOptions,
): PackageManager | undefined {
  const { cwd, declared, fallback } = options;
  const resolvedRoot = resolve(options.root ?? cwd);
  let current = resolve(cwd);

  const declaredManager = parseDeclaredManager(declared);
  if (declaredManager) return declaredManager;

  while (current === resolvedRoot || current.startsWith(`${resolvedRoot}/`)) {
    const inherited = parseDeclaredManager(
      readPackageManagerField(join(current, "package.json")),
    );
    if (inherited) return inherited;

    if (existsSync(join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (
      existsSync(join(current, "package-lock.json"))
      || existsSync(join(current, "npm-shrinkwrap.json"))
    ) return "npm";
    if (existsSync(join(current, "yarn.lock"))) return "yarn";
    if (existsSync(join(current, "bun.lock")) || existsSync(join(current, "bun.lockb"))) return "bun";

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return fallback;
}

function parseDeclaredManager(value: string | undefined): PackageManager | undefined {
  const declared = value?.split("@", 1)[0];
  if (declared === "pnpm" || declared === "npm" || declared === "yarn" || declared === "bun") {
    return declared;
  }
  return undefined;
}

function readPackageManagerField(packageJsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { packageManager?: unknown };
    if (typeof parsed.packageManager !== "string") return undefined;
    return parsed.packageManager;
  } catch {
    return undefined;
  }
}
