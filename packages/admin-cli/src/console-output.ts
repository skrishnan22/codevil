export interface Output {
  log(message: string): void;
  error(message: string): void;
}

export function createConsoleOutput(): Output {
  return {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  };
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}
