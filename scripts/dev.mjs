// Spustí Vite dev server a po jeho naběhnutí otevře Electron okno.
// Použití: npm run electron:dev
import { spawn } from "node:child_process";

const PORT = 5180;
const URL = `http://localhost:${PORT}`;

const isWin = process.platform === "win32";

function run(cmd, args, extraEnv = {}) {
  return spawn(cmd, args, {
    stdio: "inherit",
    shell: isWin, // na Windows je npm/vite .cmd
    env: { ...process.env, ...extraEnv },
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) return true;
    } catch {
      // server ještě neběží
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Vite dev server nenaběhl na ${url} do ${timeoutMs} ms`);
}

const vite = run("npm", ["run", "dev"]);

let electron = null;
try {
  await waitForServer(URL);
  electron = run("electron", ["."], { VITE_DEV_SERVER_URL: URL });
  electron.on("close", () => {
    vite.kill();
    process.exit(0);
  });
} catch (err) {
  console.error(err);
  vite.kill();
  process.exit(1);
}

process.on("SIGINT", () => {
  electron?.kill();
  vite.kill();
  process.exit(0);
});
