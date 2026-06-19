import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";

export interface Prompt {
  isTTY(): boolean;
  text(message: string): Promise<string>;
  hidden(message: string): Promise<string>;
}

export class PromptCancelledError extends Error {
  constructor(message = "Prompt cancelled.") {
    super(message);
    this.name = "PromptCancelledError";
  }
}

type PromptStream = NodeJS.ReadStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  isPaused?: () => boolean;
};

type PromptOutput = NodeJS.WriteStream & {
  isTTY?: boolean;
};

type PromptSignalTarget = {
  on(event: "SIGINT", listener: () => void): PromptSignalTarget;
  off(event: "SIGINT", listener: () => void): PromptSignalTarget;
};

export function parseNumericMultiSelect(input: string, maxIndex: number): number[] {
  const parts = input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    throw new Error("Enter at least one number.");
  }

  const selected: number[] = [];
  const seen = new Set<number>();

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error("Selections must be whole numbers.");
    }

    const value = Number(part);
    if (value < 1 || value > maxIndex) {
      throw new Error(`Selections must be between 1 and ${maxIndex}.`);
    }

    if (!seen.has(value)) {
      seen.add(value);
      selected.push(value);
    }
  }

  return selected;
}

export function createTerminalPrompt(options: {
  input?: PromptStream;
  output?: PromptOutput;
  signalTarget?: PromptSignalTarget;
} = {}): Prompt {
  const input = options.input ?? processStdin;
  const output = options.output ?? processStdout;
  const signalTarget = options.signalTarget ?? process;

  return {
    isTTY() {
      return Boolean(input.isTTY && output.isTTY);
    },

    async text(message) {
      const readline = createInterface({
        input,
        output,
        terminal: Boolean(input.isTTY && output.isTTY),
      });

      try {
        return await readline.question(message);
      } finally {
        readline.close();
      }
    },

    async hidden(message) {
      if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
        throw new Error("Hidden input requires an interactive terminal.");
      }

      output.write(message);

      const wasRaw = input.isRaw === true;
      const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;
      input.resume();
      let value = "";

      const onSigint = () => {
        rejectPrompt(new PromptCancelledError());
      };

      const onError = (error: Error) => {
        rejectPrompt(error);
      };

      const onData = (chunk: string | Buffer) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

        for (const character of text) {
          if (character === "\u0003") {
            rejectPrompt(new PromptCancelledError());
            return;
          }

          if (character === "\r" || character === "\n") {
            resolvePrompt(value);
            return;
          }

          if (character === "\u007f" || character === "\b") {
            value = value.slice(0, -1);
            continue;
          }

          value += character;
        }
      };

      let resolvePrompt!: (value: string) => void;
      let rejectPrompt!: (error: Error) => void;

      const pending = new Promise<string>((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
      });

      signalTarget.on("SIGINT", onSigint);
      input.on("error", onError);
      input.on("data", onData);

      try {
        if (!wasRaw) {
          input.setRawMode(true);
        }

        return await pending;
      } finally {
        input.off("data", onData);
        input.off("error", onError);
        signalTarget.off("SIGINT", onSigint);
        if (!wasRaw) {
          input.setRawMode(false);
        }
        if (wasPaused) {
          input.pause();
        }
        output.write("\n");
      }
    },
  };
}
