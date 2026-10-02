/** UID:GID pairs the sandbox adapters chown written files to. */
export const OWNER_IDS = { codevil: "10001:10001", root: "0:0" } as const;

/** Single-quote a value for safe interpolation into a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
