import { createInterface } from "node:readline/promises";

export async function promptForText(question: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await readline.question(question)).trim();
    if (!answer) throw new Error("Value is required");
    return answer;
  } finally {
    readline.close();
  }
}
