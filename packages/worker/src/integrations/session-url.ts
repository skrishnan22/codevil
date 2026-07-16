export function externalSessionUrl(
  env: { CODEVIL_WEB_ORIGIN?: string },
  workerOrigin: string,
  sessionId: string,
): string {
  const webOrigin = (env.CODEVIL_WEB_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .find(Boolean);
  const origin = (webOrigin ?? workerOrigin).replace(/\/+$/, "");
  return `${origin}/sessions/${sessionId}`;
}
