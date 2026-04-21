import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type { CLIToDOMessage } from "@codevil/shared";

export async function promptForApproval(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<CLIToDOMessage> {
  const readline = createInterface({ input, output });

  try {
    const answer = (await readline.question("Approve plan? [y/n or refinement feedback] ")).trim();

    if (answer.toLowerCase() === "y") return { type: "approve" };
    if (answer.toLowerCase() === "n") return { type: "abort" };
    if (answer.length > 0) return { type: "refine_plan", feedback: answer };

    return { type: "abort" };
  } finally {
    readline.close();
  }
}
