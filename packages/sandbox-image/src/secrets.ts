import { readFile, unlink } from "node:fs/promises";

export async function readAndUnlinkSecret(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    await unlink(path);
    return value || undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
