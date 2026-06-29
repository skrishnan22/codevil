import { startEntrypoint } from "./entrypoint.js";
import { sandboxLogException } from "./logging.js";

startEntrypoint().catch((error: unknown) => {
  sandboxLogException("sandbox.entrypoint.fatal", error);
  process.exitCode = 1;
});
