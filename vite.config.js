import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import nodePath from "path";
import fs from "fs";

// Serve project-root /Models/ folder as /Models/* in both dev and prod build
function modelsPlugin() {
  const modelsDir = nodePath.resolve(process.cwd(), "Models");
  return {
    name: "serve-models",
    configureServer(server) {
      server.middlewares.use("/Models", (req, res, next) => {
        const filePath = nodePath.join(modelsDir, decodeURIComponent(req.url));
        try {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = nodePath.extname(filePath).toLowerCase();
            res.setHeader("Content-Type", ext === ".glb" ? "model/gltf-binary" : "application/octet-stream");
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        } catch {}
        next();
      });
    },
    closeBundle() {
      if (!fs.existsSync(modelsDir)) return;
      const dest = nodePath.resolve(process.cwd(), "dist/Models");
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(modelsDir)) {
        fs.copyFileSync(nodePath.join(modelsDir, f), nodePath.join(dest, f));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), modelsPlugin()],
  server: {
    proxy: {
      // Proxy satellite tile requests to ArcGIS World Imagery (no CORS issues)
      // URL pattern: /tiles/{z}/{y}/{x}
      "/tiles": {
        target: "https://server.arcgisonline.com",
        changeOrigin: true,
        rewrite: (nodePath) =>
          nodePath.replace(/^\/tiles/, "/ArcGIS/rest/services/World_Imagery/MapServer/tile"),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Referer", "https://server.arcgisonline.com/");
          });
        },
      },
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/launch-monitor": {
        target: "ws://localhost:3001",
        ws: true,
      },
      "/nominatim": {
        target: "https://nominatim.openstreetmap.org",
        changeOrigin: true,
        rewrite: (nodePath) => nodePath.replace(/^\/nominatim/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // Nominatim usage policy requires a valid User-Agent
            proxyReq.setHeader("User-Agent", "CourseForge/1.0 (golf-course-designer)");
            proxyReq.setHeader("Referer", "http://localhost:5173/");
          });
        },
      },
    },
  },
});
