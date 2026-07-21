import { execFileSync } from "node:child_process";

const image = process.env.CODEVIL_SANDBOX_IMAGE ?? "codevil-sandbox:ci";
const script = [
  'const fs = require("node:fs")',
  'if (process.getuid?.() !== 10001) throw new Error(`expected uid 10001, got ${process.getuid?.()}`)',
  'if (process.env.HOME !== "/home/codevil") throw new Error(`unexpected HOME ${process.env.HOME}`)',
  'fs.writeFileSync("/workspace/.codevil-smoke", "workspace-ok")',
  'if (fs.readFileSync("/workspace/.codevil-smoke", "utf8") !== "workspace-ok") throw new Error("workspace IO failed")',
  'const http = require("node:http")',
  'const server = http.createServer((_request, response) => response.end("preview-ok"))',
  'server.listen(5173, "127.0.0.1", async () => {',
  '  try {',
  '    const response = await fetch("http://127.0.0.1:5173")',
  '    if (await response.text() !== "preview-ok") throw new Error("preview response failed")',
  '    console.log("sandbox image smoke passed")',
  '    server.close(() => process.exit(0))',
  '  } catch (error) { console.error(error); server.close(() => process.exit(1)) }',
  '})',
].join(";");

execFileSync("docker", [
  "run", "--rm",
  "--env", "HOME=/home/codevil",
  "--env", "USER=codevil",
  "--env", "LOGNAME=codevil",
  "--entrypoint", "setpriv", image,
  "--reuid=10001", "--regid=10001", "--clear-groups", "--", "node", "-e", script,
], { stdio: "inherit", timeout: 60_000 });
