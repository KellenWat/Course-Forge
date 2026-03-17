import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy satellite tile requests to ArcGIS World Imagery (no CORS issues)
      // URL pattern: /tiles/{z}/{y}/{x}
      "/tiles": {
        target: "https://server.arcgisonline.com",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/tiles/, "/ArcGIS/rest/services/World_Imagery/MapServer/tile"),
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
        rewrite: (path) => path.replace(/^\/nominatim/, ""),
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
