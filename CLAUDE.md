# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start frontend dev server (port 5173)
npm run dev

# Start backend server (port 3001)
node server.js

# Production build
npm run build

# Preview production build
npm run preview
```

Both servers must run simultaneously during development. The Vite dev server proxies requests to port 3001.

## Architecture

**Full-stack golf course design tool** — React frontend with a canvas-based map editor, backed by an Express backend for terrain mesh generation.

### Frontend (`golf-course-creator.jsx`)
The entire UI is a single large React component. It renders an interactive map using the **Canvas 2D** interface (no external mapping library). Key subsystems within this component:

- **Tile rendering**: Loads and caches 256×256 ArcGIS World Imagery tiles; implements Web Mercator projection to convert between lat/lng and pixel coordinates
- **Drawing tools**: Defined in `src/constants.js` — tee box, green, fairway, bunker, water hazard, cart path, plus pan/select modes
- **State**: Holes array (each hole has tee/green markers, polygon features, par/yardage/handicap), view state (zoom/pan/offset), overlay image settings
- **Distance**: Haversine formula calculates tee-to-green yardage live as markers are placed
- **Search**: Debounced OpenStreetMap Nominatim lookups to navigate to courses

Entry point: `index.html` → `src/main.jsx` → `golf-course-creator.jsx`

### Backend (`server.js`)
Express on port 3001 with one route:

- `POST /api/terrain` — accepts `{ bounds, resolution, courseName }`, queries the **USGS 3DEP National Elevation Dataset** via WCS, parses the returned GeoTIFF with `geotiff`, and returns a Unity-importable `.obj` mesh (Y-up, 1 unit = 1 meter, elevation normalized to Y=0)

### Vite Proxy (`vite.config.js`)
The dev server proxies three external targets to avoid CORS issues:
- Requests to port 3001 (local backend)
- ArcGIS tile requests → ArcGIS CDN
- `/nominatim/*` → OpenStreetMap Nominatim

### Data Export
- **JSON**: Full course data — hole metadata (par, handicap, notes), marker lat/lng positions, polygon feature geometries
- **OBJ**: Terrain mesh from USGS elevation data, scoped to the bounding box of all placed markers/polygons. Note: USGS 3DEP only covers the US and territories.
