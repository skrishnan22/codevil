import { startEntrypoint } from "./entrypoint.js";

startEntrypoint().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
