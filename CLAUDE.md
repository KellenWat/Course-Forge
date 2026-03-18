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
- **Drawing tools**: Defined in `src/constants.js` — tee box, pin placement (⚑), green area, fairway, bunker, water hazard, cart path, plus pan/select modes
- **Polygon drawing**: Click to add points, click first node to close. `activePolygon` index tracks the in-progress polygon. Space-to-pan works during drawing without losing the active polygon. Switching drawing tools calls `finishPolygon()` to avoid cross-type node appends.
- **State**: Holes array (each hole has tee/green markers, polygon features, par/yardage/handicap), view state (zoom/pan/offset), overlay image settings
- **Distance**: Haversine formula calculates tee-to-green yardage live as markers are placed
- **Search**: Debounced OpenStreetMap Nominatim lookups to navigate to courses

Entry point: `index.html` → `src/main.jsx` → `golf-course-creator.jsx`

### Backend (`server.js`)
Express on port 3001 with one route:

- `POST /api/terrain` — accepts `{ bounds, resolution, courseName, holeData }`, queries the **USGS 3DEP National Elevation Dataset** via WCS (GeoTIFF), parses with `geotiff`, and returns `{ obj }`:
  - `obj`: Unity-importable `.obj` mesh (Y-up, 1 unit = 1 meter, CCW winding). Includes named objects per hole (`g Hole_N`, `o Hole_N_fairway`) with area/bbox comment metadata.
  - Tree detection is done entirely **client-side** from the satellite texture (no LiDAR).

Note: USGS 3DEP only covers the US and territories.

### Vite Proxy (`vite.config.js`)
The dev server proxies four targets to avoid CORS issues:
- `/api/*` → port 3001 (local backend)
- `/tiles/*` → ArcGIS World Imagery CDN (satellite tiles)
- `/nominatim/*` → OpenStreetMap Nominatim
- `/launch-monitor` → `ws://localhost:3001` (WebSocket passthrough, `ws: true`)

### Terrain Preview (`TerrainPreview` component in `golf-course-creator.jsx`)
Three.js scene showing the terrain mesh with an ArcGIS satellite texture draped over it. Camera is positioned **south** of the terrain looking north (east = right, matching map orientation). Uses `OrbitControls` for free rotation.

**Tree detection** (`detectTreesFromSatellite`): runs client-side after the satellite texture loads. Key design:
- Samples pixels inside drawn **fairway/green_area** polygons to establish an adaptive turf brightness baseline
- Samples pixels inside drawn **water** polygons to establish a water G/B ratio baseline
- A pixel qualifies as tree canopy if it is green-dominant, darker than 72% of fairway brightness, and its G/B ratio is >1.1× the water baseline (water tint rejection)
- Candidates inside water polygons are excluded geometrically (point-in-polygon)
- Non-max suppression at MIN_SEP=28px enforces minimum tree spacing
- **Density slider**: seeded LCG shuffle (`seededShuffle`) produces a deterministic subset — 100% = all detected trees, lower = fewer, stable across slider moves
- **Click to remove**: raycasts against tree meshes in `treeGroup`; removed trees stored in `deletedIndices` Set
- Tree models: `CylinderGeometry` trunk + `ConeGeometry` canopy, raycasted to terrain surface for ground placement
- Badge shows `visible / total` tree count

### Shared Ball Physics (`src/ballPhysics.js`)
All physics constants and helpers shared between GameView and DrivingRange.

**Key constants**: `GRAVITY`, `BALL_RADIUS_VIS` (0.3 m visual sphere), `BALL_RADIUS_PHYS` (0.02135 m, regulation 1.68" for Rapier collider), `BALL_MASS` (0.0459 kg), `K_DRAG` (2.1e-4), `K_MAGNUS` (4.2e-6), `SPIN_DECAY` (0.28/s).

**`computeAeroForces(vel, vLen, inFlight, spin, dt)`** — returns `{Fx, Fy, Fz}`:
- Drag: `F = -K_DRAG × |v| × v` (velocity-squared, always opposes motion)
- Backspin lift: `Fy += K_MAGNUS × ω_back × hLen` (scales with horizontal speed)
- Sidespin curve: `Fx += K_MAGNUS × ω_side × vzn × hLen` (also scales with speed — critical: `vzn` is a unit vector so `hLen` must be included explicitly)
- Spin decays by `SPIN_DECAY × dt` fraction per frame

**`SURFACE_ROLL`** — per-surface rolling physics used at DrivingRange landing handoff. Keyed by `'green' | 'fairway' | 'rough' | 'sand'`. Controls `ballFriction`, `restitution`, `linearDamping`, `angularDamping`. Green has low damping so backspin persists and can reverse the ball; rough has high damping so ball dies immediately.

**`createRollingBody(rapierWorld, RAPIER, x, y, z, surfaceKey)`** — creates a Rapier body with surface-specific friction and damping for post-landing roll.

**`applyLandingSpin(body, vel, spin)`** — sets Rapier angular velocity at landing to the actual flight spin values so Rapier's friction model produces natural check-up / spin-back. Backspin axis: `{x: -vzn × ω_back, y: ω_side, z: vxn × ω_back}` (perpendicular to direction of motion).

**Rapier API note**: Use `rapierWorld.timestep = dt` to set the physics timestep — NOT `rapierWorld.integrationParameters.dt`, which is silently ignored in Rapier 0.19.

### Playable Game (`src/GameView.jsx`)
Full-screen browser game mounted when the user clicks **▶ Play Course** in TerrainPreview. Requires `@dimforge/rapier3d-compat` (installed).

**Physics**: Rapier3D WASM world (`rapierWorld.timestep = FIXED_DT`). Terrain geometry is a **trimesh collider** so the ball rolls on real elevation data. Ball uses `BALL_RADIUS_PHYS` (0.02135 m) for the Rapier collider and `BALL_RADIUS_VIS` (0.3 m) for the visual sphere. Aero forces computed via `computeAeroForces` and applied via `addForce` each frame; `stepPhysics` runs substeps to match real frame time.

**Shot input**: Ball Speed (mph), Launch Angle, Azimuth (−90°–+90°, 0 = north), Backspin (rpm), Sidespin (rpm). Launch velocity via `computeLaunchVelocity(..., flipX=true)` — X is negated to match the pre-negated OBJ mesh coordinate system.

**Camera**: follows ball during flight (lerp behind velocity vector), returns to `OrbitControls` when ball speed < 0.3 m/s.

**Course features**: flag pole + flag mesh + cup ring placed at each hole's pin marker position via downward Rapier raycast to find ground Y.

**Scoring**: shot counter per hole, hole-in detection within 0.54 m of pin, hole progression with "Next Hole" button.

**Ball trail**: yellow `THREE.Line` updated each frame from ball position history (capped at 300 points).

**Launch monitor WebSocket**: connects to `ws://localhost:3001/launch-monitor`. Receives GSPro-format JSON (`BallSpeed`, `LaunchAngle`, `LaunchDirection`) and auto-fires a shot. The server relay (`wss` in `server.js`) bridges browser clients and launch monitor clients — launch monitor sends with header `x-client-type: launch-monitor`.

**Flow**: TerrainPreview → **▶ Play Course** → `setGameActive(true)` → GameView mounts. **✕ Exit** → `setGameActive(false)` → back to TerrainPreview.

### Driving Range (`src/DrivingRange.jsx`)
Standalone practice range. Shot controls: Ball Speed (40–220 mph), Launch Angle (2–55°), Direction (±45°), Backspin (0–9000 rpm), Sidespin (±3000 rpm).

**Physics architecture — two phases**:
1. **Flight** (`ref.phase === 'flight'`): pure kinematic JS Euler integration — no Rapier. Each frame: `vel += (gravity + aeroForces/mass) × dt`, `pos += vel × dt`. Aero forces from `computeAeroForces`. This avoids all Rapier collision artifacts that previously caused the ball to reverse direction mid-flight.
2. **Rolling** (`ref.phase === 'rolling'`): when `pos.y <= BALL_RADIUS_PHYS`, create a Rapier body via `createRollingBody` with surface-specific friction/damping, set `linvel` to the landing velocity, call `applyLandingSpin` to imprint spin as angular velocity, then step Rapier each frame. Ball stops when speed < 0.4 m/s.

**Floor**: enormous cuboid (10 km half-extents) at y = −0.5 to 0 — edges are unreachable so collision normals are always straight up.

**`ref.phase`** lifecycle: `null` → `'flight'` (on hit) → `'rolling'` (on ground contact) → `null` (on stop). `ref.ballBody` is `null` during flight and set only for the rolling Rapier body.

### Data Export
- **JSON**: Full course data — hole metadata (par, handicap, notes), marker lat/lng positions, polygon feature geometries
- **ZIP** (from terrain preview): `terrain.obj` + `terrain.mtl` + `terrain.jpg` (satellite texture) + `course_data.json`. The JSON includes holes, polygon features, detected tree positions, rough type, and tree density — consumed by `CourseForgeImporter.cs` in Unity.

### Unity Integration (`CourseForgeImporter.cs`)
Place in `Assets/Editor/` in Unity project. Menu: **Tools → Course Forge → Import Course**. Reads `*_course_data.json` and:
1. Paints TerrainLayer alphamaps — rough texture everywhere, fairway texture inside drawn fairway/green_area polygons
2. Places `TreeInstance` objects at detected tree positions, scaled by the density setting
Requires: Unity Terrain in scene, ≥2 TerrainLayers assigned (index 0 = rough, index 1 = fairway), tree prefabs in Tree Prototypes list.

### Coordinate Systems
- **Map canvas**: Web Mercator, Y-down (standard screen coords)
- **OBJ mesh**: X is **pre-negated** in `generateOBJ` (i.e. stored as `-x`). Unity negates X on OBJ import, so the double-negation restores correct east=+X orientation. `THREE.DoubleSide` is used on all terrain materials to compensate for the winding flip this causes in Three.js.
- **Three.js / GameView**: camera placed south of terrain looking north — camera right = −X, which after pre-negation means east appears correctly on the right. `makeToXZ` in `GameView.jsx` also negates X to stay consistent.
- **Unity**: receives east=+X, elevation=+Y, north=+Z after its own X negation undoes the pre-negation

### Planned / Future
- **GameView surface detection**: on ball landing, determine which drawn polygon (green, fairway, rough, bunker) contains the XZ position and pass the matching `SURFACE_ROLL` key to `createRollingBody`. Currently GameView uses default Rapier body without surface-specific rolling.
- **Low-poly assets**: replace cone+cylinder trees with GLTF models via `GLTFLoader`. Kenney.nl Golf Kit (CC0) is a ready source. Drop GLTF files in `/public/assets/` and load with `GLTFLoader` in GameView.
- **Community course sharing**: save course JSON to a database, expose `GET/POST /api/courses`, replace static `DEFAULT_COURSES` with live API. Terrain OBJ regenerated on demand from saved bounds.
- **GLB fairway/rough border**: model a rough-to-fairway edge strip in Blender, export GLB, instance along polygon edges at course load time.
