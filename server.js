import express from "express";
import cors from "cors";
import { fromArrayBuffer } from "geotiff";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// --- Helpers ---

function haversineMeters(p1, p2) {
  const R = 6371000;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Shoelace formula — area of a 2D polygon given [{x, z}] points
function polygonArea2D(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].z - pts[j].x * pts[i].z;
  }
  return Math.abs(area) / 2;
}

function detectTrees_UNUSED(elevations, width, height, bounds) {
  const candidates = [];

  for (let row = MEAN_WIN; row < height - MEAN_WIN; row++) {
    for (let col = MEAN_WIN; col < width - MEAN_WIN; col++) {
      const elev = elevations[row * width + col];
      if (!isFinite(elev) || elev <= -1000) continue;

      // Compute baseline mean over large window
      let sum = 0, cnt = 0;
      for (let dr = -MEAN_WIN; dr <= MEAN_WIN; dr++) {
        for (let dc = -MEAN_WIN; dc <= MEAN_WIN; dc++) {
          const e = elevations[(row + dr) * width + (col + dc)];
          if (isFinite(e) && e > -1000) { sum += e; cnt++; }
        }
      }
      if (!cnt) continue;
      const prominence = elev - sum / cnt;
      if (prominence < MIN_PROMI) continue;

      // Must be local maximum within small window
      let isMax = true;
      outer:
      for (let dr = -PEAK_WIN; dr <= PEAK_WIN; dr++) {
        for (let dc = -PEAK_WIN; dc <= PEAK_WIN; dc++) {
          if (!dr && !dc) continue;
          const e = elevations[(row + dr) * width + (col + dc)];
          if (isFinite(e) && e > elev) { isMax = false; break outer; }
        }
      }
      if (!isMax) continue;

      candidates.push({ row, col, prominence });
    }
  }

  // Non-max suppression — keep the highest candidate within MIN_SEP radius
  candidates.sort((a, b) => b.prominence - a.prominence);
  const suppressed = new Uint8Array(width * height);
  const kept = [];
  for (const c of candidates) {
    if (suppressed[c.row * width + c.col]) continue;
    kept.push(c);
    for (let dr = -MIN_SEP; dr <= MIN_SEP; dr++) {
      for (let dc = -MIN_SEP; dc <= MIN_SEP; dc++) {
        const r2 = c.row + dr, c2 = c.col + dc;
        if (r2 >= 0 && r2 < height && c2 >= 0 && c2 < width)
          suppressed[r2 * width + c2] = 1;
      }
    }
  }

  console.log(`tree detection: ${candidates.length} raw candidates → ${kept.length} after suppression`);
  const { north, south, east, west } = bounds;
  return kept.map(({ row, col, prominence }) => ({
    lat: +(north - (row / (height - 1)) * (north - south)).toFixed(7),
    lng: +(west  + (col / (width  - 1)) * (east  - west )).toFixed(7),
    heightAboveGround: +prominence.toFixed(1),
  }));
}

// --- Terrain OBJ generation ---

function generateOBJ(elevations, width, height, bounds, courseName, holeData) {
  const { north, south, east, west } = bounds;
  const centerLat = (north + south) / 2;
  const centerLon = (east + west) / 2;
  const metersPerDegLat = 110540;
  const metersPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);

  const toXZ = (lat, lng) => ({
    x: (lng - centerLon) * metersPerDegLon,
    z: (lat - centerLat) * metersPerDegLat,
  });

  // Normalize elevation relative to minimum so terrain sits near Y=0
  let minElev = Infinity;
  for (const e of elevations) {
    if (isFinite(e) && e > -1000) minElev = Math.min(minElev, e);
  }
  if (!isFinite(minElev)) minElev = 0;

  const lines = [
    `# Terrain mesh for ${courseName}`,
    `# Source: USGS 3DEP National Elevation Dataset`,
    `# Coordinate system: Y-up, 1 unit = 1 meter`,
    `# Origin: lon=${centerLon.toFixed(6)} lat=${centerLat.toFixed(6)}`,
    `# Base elevation: ${minElev.toFixed(1)} m`,
    "",
    `o ${courseName.replace(/[^a-z0-9]/gi, "_")}_terrain`,
    "",
  ];

  // Terrain vertices: X=east(+), Y=elevation, Z=north(+)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const lat = north - (row / (height - 1)) * (north - south);
      const lon = west  + (col / (width  - 1)) * (east  - west);
      const { x, z } = toXZ(lat, lon);
      const raw = elevations[row * width + col];
      const y = isFinite(raw) && raw > -1000 ? raw - minElev : 0;
      lines.push(`v ${(-x).toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`); // X negated: Unity negates X on import, so this double-negates back to correct
    }
  }

  lines.push("");

  // Terrain UV coordinates (u=east, v=north)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      lines.push(`vt ${(col / (width - 1)).toFixed(4)} ${(1 - row / (height - 1)).toFixed(4)}`);
    }
  }

  lines.push("");

  // Triangulated quads — CCW winding (Unity front-face convention)
  for (let row = 0; row < height - 1; row++) {
    for (let col = 0; col < width - 1; col++) {
      const tl = row * width + col + 1; // OBJ indices are 1-based
      const tr = tl + 1;
      const bl = tl + width;
      const br = bl + 1;
      lines.push(`f ${tl}/${tl} ${tr}/${tr} ${bl}/${bl}`);
      lines.push(`f ${tr}/${tr} ${br}/${br} ${bl}/${bl}`);
    }
  }

  // --- Per-hole feature objects ---
  if (holeData && holeData.length > 0) {
    lines.push("");
    lines.push(`# ${"=".repeat(60)}`);
    lines.push(`# HOLE FEATURES`);
    lines.push(`# ${"=".repeat(60)}`);

    let vBase = width * height; // terrain already occupies indices 1..vBase

    for (const hole of holeData) {
      const { number, par, yardage, handicap, tee, green, features = [] } = hole;
      if (!tee && !green && features.length === 0) continue;

      lines.push("");
      lines.push(`# ${"─".repeat(56)}`);
      lines.push(`# Hole ${number}  |  Par ${par}  |  ${yardage} yds  |  Handicap ${handicap}`);

      if (tee) {
        const { x, z } = toXZ(tee.lat, tee.lng);
        lines.push(`# Tee:   (${x.toFixed(1)}, ?, ${z.toFixed(1)}) m  [lat ${tee.lat.toFixed(6)}, lng ${tee.lng.toFixed(6)}]`);
      }
      if (green) {
        const { x, z } = toXZ(green.lat, green.lng);
        lines.push(`# Green: (${x.toFixed(1)}, ?, ${z.toFixed(1)}) m  [lat ${green.lat.toFixed(6)}, lng ${green.lng.toFixed(6)}]`);
      }
      if (tee && green) {
        const distM   = haversineMeters(tee, green);
        const distYds = distM * 1.09361;
        lines.push(`# Straight-line distance: ${distM.toFixed(1)} m  /  ${distYds.toFixed(0)} yds`);
      }

      lines.push(`# ${"─".repeat(56)}`);
      lines.push(`g Hole_${number}`);

      for (const feat of features) {
        if (!feat.points || feat.points.length < 3) continue;

        const pts2d  = feat.points.map(p => toXZ(p.lat, p.lng));
        const area   = polygonArea2D(pts2d);
        const areaYd = area * 1.19599;
        const label  = feat.type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

        // Bounding box dimensions
        const xs = pts2d.map(p => p.x), zs = pts2d.map(p => p.z);
        const bboxW = (Math.max(...xs) - Math.min(...xs)).toFixed(1);
        const bboxD = (Math.max(...zs) - Math.min(...zs)).toFixed(1);

        lines.push("");
        lines.push(`# ${label} — area: ${area.toFixed(0)} m² (${areaYd.toFixed(0)} yd²)  bbox: ${bboxW} × ${bboxD} m`);
        lines.push(`o Hole_${number}_${feat.type}`);

        // Vertices at Y=0 (flat feature outline on the terrain plane)
        for (const { x, z } of pts2d) {
          lines.push(`v ${(-x).toFixed(3)} 0.000 ${z.toFixed(3)}`);
        }

        lines.push("");

        // Fan triangulation from vertex 0 (works for convex/near-convex shapes)
        const base = vBase + 1;
        for (let i = 1; i < pts2d.length - 1; i++) {
          lines.push(`f ${base} ${base + i} ${base + i + 1}`);
        }

        vBase += pts2d.length;
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// POST /api/terrain — generate Unity-importable OBJ from USGS 3DEP elevation data
app.post("/api/terrain", async (req, res) => {
  try {
    const { bounds, resolution = 128, courseName = "course", holeData } = req.body;
    if (!bounds) return res.status(400).json({ error: "bounds required" });
    const { north, south, east, west } = bounds;

    const wcsUrl =
      `https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WCSServer` +
      `?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=DEP3Elevation` +
      `&CRS=EPSG:4326&BBOX=${west},${south},${east},${north}` +
      `&WIDTH=${resolution}&HEIGHT=${resolution}&FORMAT=GeoTIFF`;

    const r = await fetch(wcsUrl);
    if (!r.ok) throw new Error(`USGS WCS responded with ${r.status} ${r.statusText}`);

    const contentType = r.headers.get("content-type") || "";
    if (!contentType.includes("tiff") && !contentType.includes("octet-stream")) {
      const text = await r.text();
      throw new Error(`USGS WCS returned unexpected content: ${text.slice(0, 300)}`);
    }

    const arrayBuffer = await r.arrayBuffer();
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const [elevations] = await image.readRasters();

    const obj = generateOBJ(elevations, resolution, resolution, bounds, courseName, holeData);
    res.json({ obj });
  } catch (err) {
    console.error("terrain error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- WebSocket: launch monitor bridge ---
// Accepts connections from both the browser client and launch monitor software.
// Any JSON message received from a launch monitor client is broadcast to all
// browser clients (and vice versa), acting as a simple relay.
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/launch-monitor" });

const browserClients   = new Set();
const launchMonClients = new Set();

wss.on("connection", (ws, req) => {
  const isLaunchMon = req.headers["x-client-type"] === "launch-monitor";
  const bucket = isLaunchMon ? launchMonClients : browserClients;
  bucket.add(ws);
  console.log(`launch-monitor WS: ${isLaunchMon ? "launch monitor" : "browser"} connected (${wss.clients.size} total)`);

  ws.on("message", raw => {
    // Relay to the other side
    const targets = isLaunchMon ? browserClients : launchMonClients;
    for (const t of targets) {
      if (t.readyState === 1) t.send(raw.toString());
    }
  });

  ws.on("close", () => {
    bucket.delete(ws);
    console.log("launch-monitor WS: client disconnected");
  });
});

httpServer.listen(3001, () =>
  console.log("Course Forge server → http://localhost:3001  (WS: /launch-monitor)")
);
