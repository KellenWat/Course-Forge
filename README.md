# Course Forge

A browser-based golf course designer and simulator. Map real courses using satellite imagery, draw features, generate terrain from elevation data, and play them in-browser with physics-based ball flight — no installs required beyond running the local dev server.

---

## Modes

### Home Screen
Three entry points from the landing page:

- **Driving Range** — practice your swing on a low-poly range with yardage targets
- **Course Creator** — design a course on live satellite imagery
- **Play a Course** — build or load a course, then tee off in first-person

---

### Course Creator
- Interactive satellite map (ArcGIS World Imagery) with pan, zoom, and course search
- Drawing tools: Fairway, Green Area, Bunker, Water Hazard, Cart Path
- Place Tee Box and Pin markers per hole — live yardage calculated automatically
- 18-hole scorecard with par, handicap, and notes
- Overlay support: import a course image to trace over

### Terrain Preview
- Pulls real elevation data from the **USGS 3DEP National Elevation Dataset** (US coverage)
- Satellite texture draped over the 3D mesh
- LiDAR-style tree detection from satellite pixel color
- Configurable rough type and tree density slider

### Play a Course
- First-person camera at tee height (~6 ft), looking toward the pin
- Low-poly terrain with colored feature overlays (fairway, bunker, water, etc.)
- **Rapier3D** WASM physics — trimesh terrain collision, realistic ball bounce and roll
- Shot controls: power, azimuth, loft
- Persistent shot tracer, distance-to-pin readout, hole detection
- **Minimap** (bottom-right): bird's-eye view of the current hole with zoom and click-to-aim

### Driving Range
- First-person low-poly range lined with trees
- Yardage markers at 50 / 100 / 150 / 200 / 250 yards — color-coded poles, 3D signs, target discs
- Select a target to highlight it and snap your aim
- Shot tracer and landing distance in yards
- **Minimap** with yardage ring overlay and click-to-aim

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) 18+

### Install
```bash
npm install
```

### Run (development)
Two servers must run simultaneously:

```bash
# Terminal 1 — Vite frontend  (http://localhost:5173)
npm run dev

# Terminal 2 — Express backend (http://localhost:3001)
node server.js
```

Open [http://localhost:5173](http://localhost:5173).

> Terrain generation requires an internet connection to reach USGS 3DEP and only covers the US and territories. The satellite map works globally.

### Build
```bash
npm run build
npm run preview
```

---

## Architecture

```
Course Forge/
├── golf-course-creator.jsx   # Course editor — Canvas 2D map + TerrainPreview
├── server.js                 # Express + WebSocket relay (port 3001)
├── vite.config.js            # Proxy config + Models/ static serving
├── Models/                   # GLTF tree/flag assets (served at /Models/*)
└── src/
    ├── main.jsx              # Entry point
    ├── App.jsx               # Screen router
    ├── HomeScreen.jsx        # Landing page
    ├── GameView.jsx          # In-browser course player (Three.js + Rapier)
    ├── DrivingRange.jsx      # Practice range (Three.js + Rapier)
    ├── Minimap.jsx           # Shared bird's-eye minimap (Canvas 2D, rAF loop)
    └── constants.js          # Tool modes, colors, labels
```

### How it fits together

| Concern | Implementation |
|---|---|
| Satellite map | Canvas 2D, Web Mercator projection, ArcGIS tile cache with broken-image eviction |
| Elevation data | USGS 3DEP WCS → GeoTIFF parsed by `geotiff` → OBJ mesh |
| 3D rendering | Three.js — terrain mesh, GLTF trees/flags, low-poly feature polygons |
| Physics | `@dimforge/rapier3d-compat` — trimesh terrain collider, dynamic rigid body ball |
| Minimap | Canvas 2D rAF loop reading Three.js scene refs directly — zero React state updates per frame |
| Tree detection | Satellite pixel sampling — fairway green baseline, G/B ratio water exclusion |
| Launch monitor | WebSocket relay (`/launch-monitor`) — GSPro JSON format auto-launches ball |

---

## Launch Monitor Integration

Any GSPro-compatible launch monitor can connect over WebSocket:

```
ws://localhost:3001/launch-monitor
Header: x-client-type: launch-monitor
Payload: { "BallSpeed": 55, "LaunchAngle": 14, "LaunchDirection": -2 }
```

The server relays shots to the browser in real time — the ball launches automatically on receipt.

---

## Stack

- **React 18** · **Vite**
- **Three.js** — 3D rendering, GLTFLoader, OrbitControls
- **Rapier3D** — WebAssembly rigid-body physics
- **Express** · **ws** — local API server and WebSocket relay
- **geotiff** — USGS elevation GeoTIFF parsing
- **JSZip** — course data export
- **ArcGIS World Imagery** — satellite tiles
- **USGS 3DEP** — elevation data (US only)
- **OpenStreetMap Nominatim** — course search

---

## Future Directions

- **Community course sharing** — database + API so published courses appear for all users across IP addresses
- **Unity export** — polished terrain import pipeline via `CourseForgeImporter.cs` for higher-fidelity course rendering, custom shaders, and advanced tree placement
- **Curved polygon boundaries** — Catmull-Rom spline interpolation on drawn feature outlines
- **Multiplayer scoring** — shared scorecards and live leaderboards
- **Mobile support** — touch controls for map drawing and shot input
