import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

// DEV middleware: servíruje soubory OMSI instalace pod /omsi/<relcesta>,
// aby šlo v prohlížeči (náhled) testovat načítání reálných modelů a textur.
// Cesta se bere z env OMSI_ROOT, jinak výchozí instalace.
const OMSI_ROOT = process.env.OMSI_ROOT || "D:/steam app/steamapps/common/OMSI 2";

export default defineConfig({
  base: "./",
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
  },
  plugins: [
    {
      name: "omsi-asset-dev-server",
      configureServer(server) {
        server.middlewares.use("/omsi/", (req, res, next) => {
          try {
            const rel = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/+/, "");
            const full = path.join(OMSI_ROOT, rel);
            if (!full.startsWith(path.resolve(OMSI_ROOT))) { res.statusCode = 403; res.end(); return; }
            if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.statusCode = 404; res.end(); return; }
            res.setHeader("Content-Type", "application/octet-stream");
            fs.createReadStream(full).pipe(res);
          } catch {
            next();
          }
        });
      },
    },
  ],
});
