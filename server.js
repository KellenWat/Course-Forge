import express from "express";
import cors from "cors";
import { fromArrayBuffer } from "geotiff";

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// --- Terrain generation ---

function generateOBJ(elevations, width, height, bounds, courseName) {
  const { north, south, east, west } = bounds;
  const centerLat = (north + south) / 2;
  const centerLon = (east + west) / 2;
  const metersPerDegLat = 110540;
  const metersPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);

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

  // Vertices: X=east(+), Y=elevation, Z=north(+) — Unity-compatible
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const lat = north - (row / (height - 1)) * (north - south);
      const lon = west + (col / (width - 1)) * (east - west);
      const x = (lon - centerLon) * metersPerDegLon;
      const z = (lat - centerLat) * metersPerDegLat;
      const raw = elevations[row * width + col];
      const y = isFinite(raw) && raw > -1000 ? raw - minElev : 0;
      lines.push(`v ${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`);
    }
  }

  lines.push("");

  // UV coordinates (u=east, v=north)
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

  return lines.join("\n");
}

// POST /api/terrain — generate Unity-importable OBJ from USGS 3DEP elevation data
app.post("/api/terrain", async (req, res) => {
  try {
    const { bounds, resolution = 128, courseName = "course" } = req.body;
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

    const obj = generateOBJ(elevations, resolution, resolution, bounds, courseName);
    const filename = `${courseName.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_terrain.obj`;

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(obj);
  } catch (err) {
    console.error("terrain error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () =>
  console.log("Course Forge server → http://localhost:3001")
);
