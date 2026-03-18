import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import RAPIER from "@dimforge/rapier3d-compat";
import Minimap from "./Minimap.jsx";
import {
  GRAVITY, BALL_RADIUS_VIS, BALL_RADIUS_PHYS, BALL_MASS, FIXED_DT,
  AIR_LIN_DAMP, AIR_ANG_DAMP, FLIGHT_THRESH,
  computeAeroForces, stepPhysics, computeLaunchVelocity, createBallBody,
} from "./ballPhysics.js";

// ---------------------------------------------------------------------------
// Constants (GameView-specific)
// ---------------------------------------------------------------------------
const HOLE_RADIUS = 0.54;   // metres — if ball within this on landing, it's holed
const EYE_HEIGHT  = 1.8;    // first-person camera height in metres

// Low-poly feature colours (Three.js hex)
const FEATURE_COLORS = {
  fairway:    0x4fa83d,
  green_area: 0x2e9e28,
  bunker:     0xd4b97a,
  water:      0x2e6bbf,
  path:       0xa8b0b8,
  rough:      0x2d5a1e,
};

// Edge/border colour drawn around fairway + green to show the mow line
const FEATURE_EDGE_COLORS = {
  fairway:    0x3d8c2e,
  green_area: 0x1e7a1e,
};

// Y offset above terrain per surface type (metres)
// Positive = raised above rough baseline, negative = sunken
const FEATURE_Y_OFFSET = {
  rough:      0.00,
  path:       0.04,
  fairway:    0.10,  // raised above rough — shows the tighter mow height
  green_area: 0.16,  // highest — very flat, slightly elevated
  bunker:    -0.05,  // sunken below surrounding grade
  water:      0.02,
};

// PBR material properties [roughness, metalness, opacity]
const FEATURE_MAT = {
  rough:      [0.95, 0.0, 0.96],
  fairway:    [0.80, 0.0, 0.97],
  green_area: [0.65, 0.0, 0.98],
  bunker:     [0.90, 0.0, 0.98],
  water:      [0.15, 0.1, 0.82],
  path:       [0.85, 0.0, 0.97],
};

// Overlay render order — higher = renders on top
const FEATURE_Z_ORDER = {
  rough: 1, path: 2, fairway: 3, green_area: 4, water: 5, bunker: 6,
};

// Rolling surface physics [linearDamping, angularDamping]
// Applied only when the ball is near/on the ground. Values calibrated to real
// rolling friction coefficients:
//   green  μ≈0.06, fairway μ≈0.18, rough μ≈0.55, bunker μ≈1.2
const SURFACE_PHYSICS = {
  green_area: [0.06, 0.18],
  fairway:    [0.22, 0.55],
  path:       [0.10, 0.25],
  rough:      [0.80, 2.00],
  bunker:     [1.50, 4.00],
  water:      [3.50, 7.00],
  default:    [0.50, 1.20],
};

// Tree model variants served from /Models/
const TREE_MODEL_URLS = [
  "/Models/tree_pineDefaultA.glb",
  "/Models/tree_pineDefaultB.glb",
  "/Models/tree_pineTallA.glb",
  "/Models/tree_pineRoundC.glb",
  "/Models/tree_pineRoundD.glb",
  "/Models/tree_default.glb",
  "/Models/tree_fat.glb",
  "/Models/tree_oak.glb",
  "/Models/tree_thin.glb",
  "/Models/tree_small.glb",
];

const gltfLoader = new GLTFLoader();
function loadGLTF(url) {
  return new Promise(resolve =>
    gltfLoader.load(url, g => resolve(g.scene), undefined, () => resolve(null))
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function haversineMeters(p1, p2) {
  const R = 6371000;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Build the same world-space XZ transform used in server.js / TerrainPreview
function makeToXZ(bounds) {
  const { north, south, east, west } = bounds;
  const centerLat = (north + south) / 2;
  const centerLon = (east  + west)  / 2;
  const mPerLat   = 110540;
  const mPerLon   = 111320 * Math.cos(centerLat * Math.PI / 180);
  return (lat, lng) => ({
    x: -(lng - centerLon) * mPerLon,
    z:  (lat - centerLat) * mPerLat,
  });
}

// Three.js raycaster used for terrain height queries (immune to Rapier winding issues).
const _hRaycaster = new THREE.Raycaster();
_hRaycaster.firstHitOnly = true;
const _downDir = new THREE.Vector3(0, -1, 0);

// ---------------------------------------------------------------------------
// GameView component
// ---------------------------------------------------------------------------
export default function GameView({ objText, bounds, courseJson, courseName, trees = [], onClose }) {
  const mountRef = useRef(null);
  const stateRef = useRef(null);

  const [status,      setStatus]      = useState("loading");
  const [holeIndex,   setHoleIndex]   = useState(0);
  const [shots,       setShots]       = useState([]);
  const [shotCount,   setShotCount]   = useState(0);
  const [ballSpeed,   setBallSpeed]   = useState(134);  // mph — ~60 m/s, typical 7-iron
  const [launchAngle, setLaunchAngle] = useState(16);   // degrees
  const [azimuth,     setAzimuth]     = useState(0);    // degrees, 0 = straight
  const [backspinRpm, setBackspinRpm] = useState(5000); // rpm, positive = backspin
  const [sidespinRpm, setSidespinRpm] = useState(0);    // rpm, + = draw, − = fade
  const [wsStatus,    setWsStatus]    = useState("disconnected");
  const [distToPin,   setDistToPin]   = useState(null);
  const [shotOriginXZ, setShotOriginXZ] = useState(null); // null = use tee

  // -------------------------------------------------------------------------
  // Build Three.js + Rapier scene
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!mountRef.current || !objText) return;
    let destroyed = false;
    let animId;
    let rapierWorld = null;
    let renderer    = null;
    let controls    = null;

    (async () => {
      await RAPIER.init();
      if (destroyed) return;

      rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
      rapierWorld.timestep = FIXED_DT;

      // -- Renderer --
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(w, h);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mountRef.current.appendChild(renderer.domElement);

      // -- Scene --
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x87ceeb);
      scene.fog = new THREE.Fog(0x87ceeb, 800, 2000);

      scene.add(new THREE.AmbientLight(0xffffff, 1.2));
      // Hemisphere light gives sky/ground colour to PBR (MeshStandardMaterial) tree models
      const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4a7a2a, 1.0);
      scene.add(hemi);
      const sun = new THREE.DirectionalLight(0xfffbe8, 1.5);
      sun.position.set(300, 600, 200);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near   = 1;
      sun.shadow.camera.far    = 3000;
      sun.shadow.camera.left   = sun.shadow.camera.bottom = -800;
      sun.shadow.camera.right  = sun.shadow.camera.top   =  800;
      scene.add(sun);

      // -- Camera + controls --
      const camera = new THREE.PerspectiveCamera(70, w / h, 0.1, 5000);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;

      // -- Load terrain OBJ --
      const terrainObj    = new OBJLoader().parse(objText);
      const terrainMeshes = [];
      const box           = new THREE.Box3();

      terrainObj.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        child.receiveShadow = true;
        child.material = new THREE.MeshStandardMaterial({ color: FEATURE_COLORS.rough, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
        terrainMeshes.push(child);
        box.expandByObject(child);
      });
      scene.add(terrainObj);

      // Local height query using Three.js raycasting — works correctly with
      // DoubleSide terrain regardless of triangle winding.
      const groundY = (x, z, fallback) => {
        _hRaycaster.set(new THREE.Vector3(x, 9999, z), _downDir);
        const hits = _hRaycaster.intersectObjects(terrainMeshes, false);
        return hits.length > 0 ? hits[0].point.y : fallback;
      };

      const centre = new THREE.Vector3();
      box.getCenter(centre);
      const size = new THREE.Vector3();
      box.getSize(size);
      const span = Math.max(size.x, size.z);

      // -- Rapier trimesh collider from terrain geometry --
      // Apply matrixWorld so local mesh coords are converted to world space before
      // handing off to Rapier (mesh may be a child of a transformed Group).
      const verts = [], indices = [];
      let vOffset = 0;
      const _v = new THREE.Vector3();
      for (const mesh of terrainMeshes) {
        mesh.updateWorldMatrix(true, false);
        const geo = mesh.geometry, pos = geo.attributes.position, idx = geo.index;
        for (let i = 0; i < pos.count; i++) {
          _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          verts.push(_v.x, _v.y, _v.z);
        }
        // Push both winding orders so the trimesh collides from both sides,
        // regardless of OBJ winding (X-negation flips CCW→CW in this mesh).
        if (idx) {
          for (let i = 0; i + 2 < idx.count; i += 3) {
            const a = idx.getX(i) + vOffset, b = idx.getX(i+1) + vOffset, c = idx.getX(i+2) + vOffset;
            indices.push(a, b, c);
            indices.push(a, c, b);
          }
        } else {
          for (let i = 0; i + 2 < pos.count; i += 3) {
            indices.push(i + vOffset, i+1 + vOffset, i+2 + vOffset);
            indices.push(i + vOffset, i+2 + vOffset, i+1 + vOffset);
          }
        }
        vOffset += pos.count;
      }
      rapierWorld.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(indices)));

      // -- Ball mesh --
      const ballMesh = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_RADIUS_VIS, 16, 16),
        new THREE.MeshPhongMaterial({ color: 0xffffff })
      );
      ballMesh.castShadow  = true;
      ballMesh.visible     = false;
      ballMesh.renderOrder = 2;
      scene.add(ballMesh);

      // -- Shot tracer (Line2 = fat line, visible at any linewidth) --
      const trailPoints = [];   // THREE.Vector3[]
      const trailGeo    = new LineGeometry();
      const trailMat    = new LineMaterial({
        color: 0xffffff,
        linewidth: 3,          // screen-space pixels
        transparent: true,
        opacity: 0.90,
        resolution: new THREE.Vector2(w, h),
        depthTest: true,
        depthWrite: false,
      });
      // Seed geometry with two identical dummy points so Line2 is valid before first shot
      trailGeo.setPositions([0, 0, 0, 0, 0, 0]);
      const trailLine = new Line2(trailGeo, trailMat);
      trailLine.visible = false;
      trailLine.renderOrder = 3;
      scene.add(trailLine);

      // -- Load GLTF assets --
      const toXZ = makeToXZ(bounds);
      const [flagModel, ...treeModelsList] =
        await Promise.all([loadGLTF("/Models/flag-green.glb"), ...TREE_MODEL_URLS.map(loadGLTF)]);
      if (destroyed) return;
      const treeModels = treeModelsList.filter(Boolean);

      // -- Hole markers: tee boxes, flags, cup rings --
      const holeObjects  = []; // { pinXZ, camPos, camTarget, holeNumber }
      const markers      = courseJson?.markers || [];
      const holes        = courseJson?.holes   || [];

      for (const hole of holes) {
        const teeM = markers.find(m => m.hole === hole.number && m.type === "tee") || hole.tee;
        const pinM = markers.find(m => m.hole === hole.number && m.type === "green") || hole.green;

        // --- Tee box ---
        if (teeM) {
          const { x, z } = toXZ(teeM.lat, teeM.lng);
          const ty = groundY(x, z, centre.y);
          const teeBox = new THREE.Mesh(
            new THREE.BoxGeometry(3, 0.08, 2),
            new THREE.MeshLambertMaterial({ color: 0xb8e090 })
          );
          teeBox.position.set(x, ty + 0.04, z);
          teeBox.receiveShadow = true;
          scene.add(teeBox);
        }

        // --- Flag + cup ring ---
        let pinXZ = null;
        if (pinM) {
          const { x, z } = toXZ(pinM.lat, pinM.lng);
          const py = groundY(x, z, centre.y);
          pinXZ = { x, y: py, z };

          // Cup ring (always shown regardless of flag model)
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(HOLE_RADIUS * 0.8, HOLE_RADIUS, 16),
            new THREE.MeshLambertMaterial({ color: 0x222222, side: THREE.DoubleSide })
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(x, py + 0.02, z);
          scene.add(ring);

          if (flagModel) {
            const flag = flagModel.clone();
            flag.scale.setScalar(3);
            flag.position.set(x, py, z);
            flag.traverse(c => { if (c.isMesh) c.castShadow = true; });
            scene.add(flag);
          } else {
            // Fallback: simple pole + plane flag
            const pole = new THREE.Mesh(
              new THREE.CylinderGeometry(0.03, 0.03, 3, 6),
              new THREE.MeshLambertMaterial({ color: 0xffffff })
            );
            pole.position.set(x, py + 1.5, z);
            pole.castShadow = true;
            const flagPlane = new THREE.Mesh(
              new THREE.PlaneGeometry(0.8, 0.5),
              new THREE.MeshLambertMaterial({ color: 0xff2222, side: THREE.DoubleSide })
            );
            flagPlane.position.set(x + 0.4, py + 2.8, z);
            scene.add(pole, flagPlane);
          }
        }

        // --- Per-hole first-person camera position ---
        let camPos, camTarget, nearTarget;
        if (teeM) {
          const { x: tx, z: tz } = toXZ(teeM.lat, teeM.lng);
          const ty = groundY(tx, tz, centre.y);
          camPos = new THREE.Vector3(tx, ty + EYE_HEIGHT, tz);
          if (pinM && pinXZ) {
            camTarget = new THREE.Vector3(pinXZ.x, pinXZ.y + 1.0, pinXZ.z);
            const dx = pinXZ.x - tx, dz = pinXZ.z - tz;
            const d  = Math.sqrt(dx * dx + dz * dz) || 1;
            nearTarget = new THREE.Vector3(tx + (dx / d) * 10, ty + EYE_HEIGHT, tz + (dz / d) * 10);
          } else {
            camTarget  = new THREE.Vector3(tx, ty + EYE_HEIGHT, tz + 50);
            nearTarget = new THREE.Vector3(tx, ty + EYE_HEIGHT, tz + 10);
          }
        } else {
          camPos     = new THREE.Vector3(centre.x, centre.y + span * 0.5, centre.z - span * 0.9);
          camTarget  = centre.clone();
          nearTarget = centre.clone();
        }

        holeObjects.push({ pinXZ, camPos, camTarget, nearTarget, holeNumber: hole.number });
      }

      // -- Feature polygon overlays --
      // Point-in-polygon test (XZ plane, ray-casting algorithm)
      const pip = (px, pz, poly) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x, zi = poly[i].z;
          const xj = poly[j].x, zj = poly[j].z;
          if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi))
            inside = !inside;
        }
        return inside;
      };

      for (const hole of holes) {
        for (const feat of (hole.features || [])) {
          if (!feat.points || feat.points.length < 3) continue;
          const color = FEATURE_COLORS[feat.type] || FEATURE_COLORS.rough;
          const pts2d = feat.points.map(p => toXZ(p.lat, p.lng));

          // Build a grid mesh that drapes onto terrain (3m cell resolution)
          const minX = Math.min(...pts2d.map(p => p.x));
          const maxX = Math.max(...pts2d.map(p => p.x));
          const minZ = Math.min(...pts2d.map(p => p.z));
          const maxZ = Math.max(...pts2d.map(p => p.z));
          const step = 3;
          const xs = [], zs = [];
          for (let x = minX - step; x <= maxX + step; x += step) xs.push(x);
          for (let z = minZ - step; z <= maxZ + step; z += step) zs.push(z);

          const yOff = FEATURE_Y_OFFSET[feat.type] ?? 0.05;
          const positions = [];
          const gridIdx   = new Map();
          for (let zi = 0; zi < zs.length; zi++) {
            for (let xi = 0; xi < xs.length; xi++) {
              const x = xs[xi], z = zs[zi];
              if (!pip(x, z, pts2d)) continue;
              const gy = groundY(x, z, centre.y);
              gridIdx.set(`${xi},${zi}`, positions.length / 3);
              positions.push(x, gy + yOff, z);
            }
          }
          if (positions.length === 0) continue;

          const triIdx = [];
          for (let zi = 0; zi < zs.length - 1; zi++) {
            for (let xi = 0; xi < xs.length - 1; xi++) {
              const tl = gridIdx.get(`${xi},${zi}`);
              const tr = gridIdx.get(`${xi+1},${zi}`);
              const bl = gridIdx.get(`${xi},${zi+1}`);
              const br = gridIdx.get(`${xi+1},${zi+1}`);
              if (tl !== undefined && tr !== undefined && bl !== undefined)
                triIdx.push(tl, tr, bl);
              if (tr !== undefined && br !== undefined && bl !== undefined)
                triIdx.push(tr, br, bl);
            }
          }
          if (triIdx.length === 0) continue;

          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          geo.setIndex(triIdx);
          geo.computeVertexNormals();

          const [matRoughness, matMetal, matOpacity] = FEATURE_MAT[feat.type] ?? [0.9, 0, 0.95];
          const mat = new THREE.MeshStandardMaterial({
            color,
            roughness: matRoughness,
            metalness: matMetal,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: matOpacity,
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4,
            depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = FEATURE_Z_ORDER[feat.type] ?? 1;
          scene.add(mesh);

          // Edge border line around fairway / green to mark the mow-cut boundary
          if (FEATURE_EDGE_COLORS[feat.type]) {
            const edgePts = pts2d.map(p => {
              const gy = groundY(p.x, p.z, centre.y);
              return new THREE.Vector3(p.x, gy + yOff + 0.02, p.z);
            });
            // Close the loop
            edgePts.push(edgePts[0].clone());
            const edgeGeo = new THREE.BufferGeometry().setFromPoints(edgePts);
            const edgeMat = new THREE.LineBasicMaterial({
              color: FEATURE_EDGE_COLORS[feat.type],
              transparent: true,
              opacity: 0.7,
              depthWrite: false,
            });
            const edgeLine = new THREE.Line(edgeGeo, edgeMat);
            edgeLine.renderOrder = (FEATURE_Z_ORDER[feat.type] ?? 1) + 0.5;
            scene.add(edgeLine);
          }
        }
      }

      // -- Trees --
      const trunkMat  = new THREE.MeshLambertMaterial({ color: 0x6b4226 });
      const canopyMat = new THREE.MeshLambertMaterial({ color: 0x2d5e1e });

      const terrainMinY = box.min.y;
      const terrainMaxY = box.max.y;

      const _treeBox = new THREE.Box3();
      for (const tree of trees) {
        const { x, z } = toXZ(tree.lat, tree.lng);
        const gy = groundY(x, z, centre.y);
        // Skip trees that land way outside plausible terrain range
        if (gy < terrainMinY - 10 || gy > terrainMaxY + 30) continue;
        const treeH = Math.max((tree.heightAboveGround || 1) * 6, 15);

        let treeObj;
        if (treeModels.length > 0) {
          treeObj = treeModels[Math.floor(Math.random() * treeModels.length)].clone();
          treeObj.scale.setScalar(treeH / 5);
          treeObj.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
          // Snap the GLTF model's base to terrain surface regardless of model origin
          treeObj.position.set(x, gy, z);
          _treeBox.setFromObject(treeObj);
          if (!_treeBox.isEmpty()) treeObj.position.y += gy - _treeBox.min.y;
        } else {
          treeObj = new THREE.Group();
          const trunk  = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, treeH * 0.35, 6), trunkMat);
          trunk.position.y = treeH * 0.175;
          trunk.castShadow = true;
          const canopy = new THREE.Mesh(new THREE.ConeGeometry(treeH * 0.28, treeH * 0.7, 7), canopyMat);
          canopy.position.y = treeH * 0.7;
          canopy.castShadow = true;
          treeObj.add(trunk, canopy);
          treeObj.position.set(x, gy, z);
        }
        scene.add(treeObj);
      }

      // -- Set camera for hole 0 (first-person at tee) --
      if (holeObjects[0]) {
        camera.position.copy(holeObjects[0].camPos);
        camera.lookAt(holeObjects[0].camTarget);
        controls.target.copy(holeObjects[0].nearTarget);
      } else {
        camera.position.set(centre.x, centre.y + span * 0.5, centre.z - span * 0.9);
        controls.target.copy(centre);
      }
      controls.enableZoom = false;
      controls.update();

      // -- Store mutable state --
      // Flat list of world-XZ polygons used for surface physics detection
      const surfacePolygons = holes.flatMap(hole =>
        (hole.features || [])
          .filter(f => f.points?.length >= 3)
          .map(f => ({ type: f.type, pts: f.points.map(p => toXZ(p.lat, p.lng)) }))
      );

      stateRef.current = {
        scene, camera, renderer, controls, rapierWorld,
        terrainMeshes, groundY, holeObjects, toXZ,
        ballMesh, ballBody: null,
        trailPoints, trailGeo, trailMat, trailLine,
        followBall: false,
        surfacePolygons,
        centre, span,
        ballSpin: null,     // { backspin: rpm, sidespin: rpm } — set on each shot
        lastBallPos: null,  // { x, y, z } — where ball last stopped
      };

      // -- Animate --
      let lastT = performance.now();

      const animate = () => {
        if (destroyed) return;
        animId = requestAnimationFrame(animate);
        const now = performance.now();
        const dt  = Math.min((now - lastT) / 1000, 0.05);
        lastT = now;

        const ref = stateRef.current;
        if (!ref) return;

        if (ref.ballBody) {
          const vel   = ref.ballBody.linvel();
          const vLen  = Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2);
          const t_pre = ref.ballBody.translation();

          // --- Surface type detection (XZ polygon test) ---
          let surfType = "default", bestOrder = -1;
          if (ref.surfacePolygons?.length) {
            for (const { type, pts } of ref.surfacePolygons) {
              let inside = false;
              for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                const xi = pts[i].x, zi = pts[i].z, xj = pts[j].x, zj = pts[j].z;
                if (((zi > t_pre.z) !== (zj > t_pre.z)) &&
                    (t_pre.x < (xj - xi) * (t_pre.z - zi) / (zj - zi) + xi))
                  inside = !inside;
              }
              if (inside) {
                const order = FEATURE_Z_ORDER[type] ?? 0;
                if (order > bestOrder) { bestOrder = order; surfType = type; }
              }
            }
          }

          // --- Flight detection: is ball sufficiently above terrain? ---
          const terrY = ref.groundY
            ? ref.groundY(t_pre.x, t_pre.z, t_pre.y - BALL_RADIUS_VIS)
            : (t_pre.y - BALL_RADIUS_VIS);
          const inFlight = (t_pre.y - terrY - BALL_RADIUS_PHYS) > FLIGHT_THRESH;

          if (inFlight) {
            ref.ballBody.setLinearDamping(AIR_LIN_DAMP);
            ref.ballBody.setAngularDamping(AIR_ANG_DAMP);
          } else {
            const [ld, ad] = SURFACE_PHYSICS[surfType] ?? SURFACE_PHYSICS.default;
            ref.ballBody.setLinearDamping(ld);
            ref.ballBody.setAngularDamping(ad);
          }

          // --- Aerodynamic forces (drag + Magnus) — applied only in flight ---
          const { Fx, Fy, Fz } = computeAeroForces(vel, vLen, inFlight, ref.ballSpin, dt);
          stepPhysics(ref.ballBody, ref.rapierWorld, Fx, Fy, Fz, dt);

          const t = ref.ballBody.translation();
          ref.ballMesh.position.set(t.x, t.y, t.z);

          ref.trailPoints.push(new THREE.Vector3(t.x, t.y, t.z));
          if (ref.trailPoints.length > 300) ref.trailPoints.shift();
          if (ref.trailPoints.length >= 2) {
            const flat = new Float32Array(ref.trailPoints.length * 3);
            for (let i = 0; i < ref.trailPoints.length; i++) {
              flat[i * 3]     = ref.trailPoints[i].x;
              flat[i * 3 + 1] = ref.trailPoints[i].y;
              flat[i * 3 + 2] = ref.trailPoints[i].z;
            }
            ref.trailGeo.setPositions(flat);
            ref.trailLine.visible = true;
          }

          if (ref.followBall) {
            const speed = vLen;

            // Chase cam: orbit around ball from above/behind
            ref.camera.position.lerp(
              new THREE.Vector3(t.x - vel.x * 3, t.y + 8, t.z - vel.z * 3), 0.05
            );
            ref.controls.target.lerp(new THREE.Vector3(t.x, t.y, t.z), 0.1);

            if (speed < 0.3) {
              ref.followBall  = false;
              ref.rapierWorld.removeRigidBody(ref.ballBody);
              ref.ballBody    = null;
              ref.lastBallPos = { x: t.x, y: t.y, z: t.z };
              setStatus("ready");
              setShotOriginXZ({ x: t.x, z: t.z });

              // Position camera at ball's resting spot, looking toward pin
              const hi  = stateRef.current._holeIndex ?? 0;
              const pin = ref.holeObjects[hi]?.pinXZ;
              const camY = terrY + EYE_HEIGHT;
              if (pin) {
                const dx = pin.x - t.x, dz = pin.z - t.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                const lookX = dist > 2 ? pin.x : t.x + dx * 5;
                const lookZ = dist > 2 ? pin.z : t.z + dz * 5;
                ref.camera.position.set(t.x, camY, t.z);
                ref.camera.lookAt(lookX, camY - 1, lookZ);
                ref.controls.target.set(lookX, camY - 1, lookZ);
              } else {
                const cam = ref.holeObjects[hi];
                if (cam) {
                  ref.camera.position.copy(cam.camPos);
                  ref.camera.lookAt(cam.camTarget);
                  ref.controls.target.copy(cam.nearTarget);
                }
              }
              ref.controls.update();

              // Check hole distance
              const curHole = ref.holeObjects[hi];
              if (curHole?.pinXZ) {
                const dx = t.x - curHole.pinXZ.x;
                const dz = t.z - curHole.pinXZ.z;
                const d  = Math.sqrt(dx * dx + dz * dz);
                setDistToPin(d.toFixed(1));
                if (d < HOLE_RADIUS) setStatus("holed");
              }
            }
          }
        }

        ref.controls.update();
        ref.renderer.render(ref.scene, ref.camera);
      };
      animate();

      // -- Resize --
      const onResize = () => {
        const el = mountRef.current;
        if (!el || !stateRef.current) return;
        const w = el.clientWidth, h = el.clientHeight;
        stateRef.current.renderer.setSize(w, h);
        stateRef.current.camera.aspect = w / h;
        stateRef.current.camera.updateProjectionMatrix();
        stateRef.current.trailMat.resolution.set(w, h);
      };
      window.addEventListener("resize", onResize);

      setStatus("ready");
      stateRef.current._cleanup = () => window.removeEventListener("resize", onResize);
    })();

    return () => {
      destroyed = true;
      cancelAnimationFrame(animId);
      const savedState = stateRef.current;
      stateRef.current = null;
      try { savedState?._cleanup?.(); } catch {}
      try { controls?.dispose(); } catch {}
      try { renderer?.dispose(); } catch {}
      try { rapierWorld?.free(); } catch {}
    };
  }, [objText, bounds, courseJson]);

  // -------------------------------------------------------------------------
  // Launch ball
  // -------------------------------------------------------------------------
  const launchBall = useCallback(() => {
    const ref = stateRef.current;
    if (!ref || !ref.rapierWorld) return;

    if (ref.ballBody) {
      ref.rapierWorld.removeRigidBody(ref.ballBody);
      ref.ballBody = null;
    }

    // Shot origin: use last ball position if available, otherwise tee
    let startX, startZ;
    if (ref.lastBallPos) {
      startX = ref.lastBallPos.x;
      startZ = ref.lastBallPos.z;
    } else {
      const currentHole = (courseJson?.holes || [])[holeIndex];
      const teeM = (courseJson?.markers || []).find(m =>
        m.hole === currentHole?.number && m.type === "tee"
      ) || currentHole?.tee;
      if (teeM) {
        const { x, z } = ref.toXZ(teeM.lat, teeM.lng);
        startX = x; startZ = z;
      } else {
        startX = ref.centre.x; startZ = ref.centre.z;
      }
    }

    const gy     = ref.groundY ? ref.groundY(startX, startZ, ref.centre.y) : ref.centre.y;
    const startY = gy + BALL_RADIUS_PHYS + 0.005;

    const body = createBallBody(ref.rapierWorld, RAPIER, startX, startY, startZ);
    const { vx, vy, vz } = computeLaunchVelocity(ballSpeed, launchAngle, azimuth, true);
    body.setLinvel({ x: vx, y: vy, z: vz }, true);

    // Store spin for Magnus effect application during flight
    ref.ballSpin = { backspin: backspinRpm, sidespin: sidespinRpm };

    ref.ballBody              = body;
    ref.lastBallPos           = null;  // clear until this shot stops
    ref.ballMesh.visible      = true;
    ref.ballMesh.position.set(startX, startY, startZ);
    ref.trailPoints.length    = 0;
    ref.trailLine.visible     = false;
    ref.trailGeo.setPositions([startX, startY, startZ, startX, startY, startZ]);
    ref.followBall            = true;
    stateRef.current._holeIndex = holeIndex;

    ref.camera.position.set(startX - vx * 0.2, startY + 6, startZ - vz * 0.2);
    ref.controls.target.set(startX, startY, startZ);

    setShotCount(c => c + 1);
    setDistToPin(null);
    setStatus("flying");
  }, [courseJson, holeIndex, ballSpeed, launchAngle, azimuth, backspinRpm, sidespinRpm]);

  // -------------------------------------------------------------------------
  // WebSocket launch monitor
  // -------------------------------------------------------------------------
  useEffect(() => {
    let ws;
    const connect = () => {
      try {
        ws = new WebSocket("ws://localhost:3001/launch-monitor");
        ws.onopen    = () => setWsStatus("connected");
        ws.onclose   = () => setWsStatus("disconnected");
        ws.onerror   = () => setWsStatus("disconnected");
        ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            // BallSpeed in m/s → convert to mph
            if (data.BallSpeed       != null) setBallSpeed(Math.round(data.BallSpeed * 2.23694));
            if (data.LaunchAngle     != null) setLaunchAngle(Math.round(data.LaunchAngle));
            if (data.LaunchDirection != null) setAzimuth(Math.round(data.LaunchDirection));
            // Spin fields (GSPro extended format)
            if (data.BackSpin  != null) setBackspinRpm(Math.round(data.BackSpin));
            if (data.SideSpin  != null) setSidespinRpm(Math.round(data.SideSpin));
            // SpinAxis/TotalSpin → decompose into back/side
            if (data.TotalSpin != null && data.SpinAxis != null) {
              const axRad = data.SpinAxis * Math.PI / 180;
              setBackspinRpm(Math.round(data.TotalSpin * Math.cos(axRad)));
              setSidespinRpm(Math.round(data.TotalSpin * Math.sin(axRad)));
            }
            setTimeout(() => launchBall(), 100);
          } catch {}
        };
      } catch {}
    };
    connect();
    return () => ws?.close();
  }, [launchBall]);

  // -------------------------------------------------------------------------
  // Sync azimuth to tee→pin bearing when hole changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!bounds || !courseJson) return;
    const toXZ = makeToXZ(bounds);
    const hole = (courseJson?.holes || [])[holeIndex];
    const teeM = (courseJson?.markers || []).find(m => m.hole === hole?.number && m.type === "tee") || hole?.tee;
    const pinM = (courseJson?.markers || []).find(m => Number(m.hole) === Number(hole?.number) && m.type === "green") || hole?.green;
    if (!teeM || !pinM) return;
    const tee = toXZ(teeM.lat, teeM.lng);
    const pin = toXZ(pinM.lat, pinM.lng);
    const dx = pin.x - tee.x;
    const dz = pin.z - tee.z;
    // flipX=true convention: positive az = right, az = atan2(-dx, dz)
    const az = Math.atan2(-dx, dz) * 180 / Math.PI;
    const clamped = Math.round(Math.max(-90, Math.min(90, az)));
    setAzimuth(clamped);
    // Also pivot the camera immediately if the scene is ready
    const ref = stateRef.current;
    if (ref && !ref.followBall) {
      const azRad = clamped * Math.PI / 180;
      const hi = holeIndex;
      const teePos = ref.holeObjects?.[hi]?.camPos;
      if (teePos) {
        const tx = teePos.x + (-Math.sin(azRad)) * 120;
        const ty = teePos.y - 1.2;
        const tz = teePos.z + Math.cos(azRad) * 120;
        ref.camera.position.copy(teePos);
        ref.camera.lookAt(tx, ty, tz);
        ref.controls.target.set(tx, ty, tz);
        ref.controls.update();
      }
    }
  }, [bounds, courseJson, holeIndex]);

  // -------------------------------------------------------------------------
  // Advance to next hole
  // -------------------------------------------------------------------------
  const nextHole = useCallback(() => {
    setShots(s => { const next = [...s]; next[holeIndex] = shotCount; return next; });
    const nextIdx = holeIndex + 1;
    setHoleIndex(nextIdx);
    setShotCount(0);
    setStatus("ready");
    setDistToPin(null);
    setShotOriginXZ(null);

    const ref = stateRef.current;
    if (ref) {
      ref.lastBallPos = null;  // reset to tee for new hole
      ref.ballSpin    = null;
      const cam = ref.holeObjects[nextIdx];
      if (cam) {
        ref.camera.position.copy(cam.camPos);
        ref.camera.lookAt(cam.camTarget);
        ref.controls.target.copy(cam.nearTarget);
      } else {
        ref.camera.position.set(ref.centre.x, ref.centre.y + ref.span * 0.5, ref.centre.z - ref.span * 0.9);
        ref.controls.target.copy(ref.centre);
      }
      if (ref.ballMesh) ref.ballMesh.visible = false;
    }
  }, [holeIndex, shotCount]);

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  const currentHole = (courseJson?.holes || [])[holeIndex];
  const par         = currentHole?.par ?? "–";
  const totalHoles  = (courseJson?.holes || []).length;

  // --- Aim change from minimap — updates azimuth state AND pivots camera ---
  const handleAimChange = useCallback((az) => {
    setAzimuth(az);
    const ref = stateRef.current;
    if (!ref || ref.followBall) return;
    const azRad = az * Math.PI / 180;
    const hi = ref._holeIndex ?? 0;

    // Camera base: last ball pos (for subsequent shots) or tee
    let camBase;
    if (ref.lastBallPos) {
      const terrY = ref.groundY
        ? ref.groundY(ref.lastBallPos.x, ref.lastBallPos.z, ref.lastBallPos.y)
        : ref.lastBallPos.y;
      camBase = new THREE.Vector3(ref.lastBallPos.x, terrY + EYE_HEIGHT, ref.lastBallPos.z);
    } else {
      camBase = ref.holeObjects?.[hi]?.camPos;
    }
    if (!camBase) return;

    const tx = camBase.x + (-Math.sin(azRad)) * 120;
    const ty = camBase.y - 1.2;
    const tz = camBase.z + ( Math.cos(azRad)) * 120;
    ref.camera.position.copy(camBase);
    ref.camera.lookAt(tx, ty, tz);
    ref.controls.target.set(tx, ty, tz);
    ref.controls.update();
  }, []);

  // --- Minimap data (derived from bounds + courseJson, updated per hole) ---
  const minimapWorldBounds = useMemo(() => {
    if (!bounds) return { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
    const toXZ = makeToXZ(bounds);
    const corners = [
      toXZ(bounds.north, bounds.west), toXZ(bounds.north, bounds.east),
      toXZ(bounds.south, bounds.west), toXZ(bounds.south, bounds.east),
    ];
    return {
      minX: Math.min(...corners.map(c => c.x)),
      maxX: Math.max(...corners.map(c => c.x)),
      minZ: Math.min(...corners.map(c => c.z)),
      maxZ: Math.max(...corners.map(c => c.z)),
    };
  }, [bounds]);

  const minimapFeatures = useMemo(() => {
    if (!courseJson || !bounds) return [];
    const toXZ = makeToXZ(bounds);
    const holeData = (courseJson.holes || [])[holeIndex];
    if (!holeData) return [];
    return (holeData.features || [])
      .filter(f => f.points?.length >= 3)
      .map(f => ({ type: f.type, points: f.points.map(p => toXZ(p.lat, p.lng)) }));
  }, [courseJson, holeIndex, bounds]);

  const minimapTeeXZ = useMemo(() => {
    // Show current shot origin (ball's last resting spot) or fall back to the actual tee
    if (shotOriginXZ) return shotOriginXZ;
    if (!bounds) return { x: 0, z: 0 };
    const toXZ = makeToXZ(bounds);
    const hole = (courseJson?.holes || [])[holeIndex];
    const teeM = (courseJson?.markers || []).find(m => Number(m.hole) === Number(hole?.number) && m.type === "tee") || hole?.tee;
    return teeM ? toXZ(teeM.lat, teeM.lng) : { x: 0, z: 0 };
  }, [courseJson, holeIndex, bounds, shotOriginXZ]);

  const minimapPinXZ = useMemo(() => {
    if (!bounds) return null;
    const toXZ = makeToXZ(bounds);
    const hole = (courseJson?.holes || [])[holeIndex];
    const pinM = (courseJson?.markers || []).find(m => Number(m.hole) === Number(hole?.number) && m.type === "green") || hole?.green;
    return pinM ? toXZ(pinM.lat, pinM.lng) : null;
  }, [courseJson, holeIndex, bounds]);

  const panelStyle = {
    position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
    borderRadius: 12, padding: "12px 20px", color: "#fff",
    display: "flex", flexDirection: "column", gap: 10, minWidth: 320,
    fontSize: 13, userSelect: "none", zIndex: 10,
  };

  const btn = (color = "#2ecc71") => ({
    background: color, border: "none", borderRadius: 8,
    color: "#fff", padding: "8px 18px", cursor: "pointer",
    fontWeight: 700, fontSize: 14, fontFamily: "inherit",
  });

  const sliderRow = (label, val, min, max, step, setter, unit = "", extra = null) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 76, color: "#aaa", fontSize: 12 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={e => setter(+e.target.value)} style={{ flex: 1 }} />
      <span style={{ width: 58, textAlign: "right", fontSize: 12 }}>{val}{unit}</span>
      {extra && <span style={{ color: "#666", fontSize: 11 }}>{extra}</span>}
    </div>
  );

  const speedMs = (ballSpeed * 0.44704).toFixed(0);
  const spinLabel = sidespinRpm === 0 ? "Straight"
    : sidespinRpm > 0 ? `Draw ${sidespinRpm}` : `Fade ${Math.abs(sidespinRpm)}`;

  // ---------------------------------------------------------------------------
  // Scoreboard helpers
  // ---------------------------------------------------------------------------
  const allHoles = courseJson?.holes || [];

  // Build per-hole score data at the time of rendering.
  // shots[i] is set when nextHole() is called (i.e. previous holes).
  // The current hole score is shotCount.
  const holeScores = allHoles.map((hole, idx) => {
    const score = idx < holeIndex ? shots[idx]
                : idx === holeIndex && status === "holed" ? shotCount
                : null;
    const toPar = score != null && hole.par ? score - hole.par : null;
    return { hole, score, toPar };
  });

  const completedCount = holeIndex + (status === "holed" ? 1 : 0);
  const totalPar       = holeScores.slice(0, completedCount).reduce((s, h) => s + (h.hole.par ?? 0), 0);
  const totalScore     = holeScores.slice(0, completedCount).reduce((s, h) => s + (h.score ?? 0), 0);
  const totalToPar     = totalScore - totalPar;

  const scoreStyle = (toPar) => {
    if (toPar == null) return { color: "#666" };
    if (toPar <= -2)   return { color: "#f0c040", fontWeight: 700 };  // eagle+
    if (toPar === -1)  return { color: "#2ecc71", fontWeight: 700 };  // birdie
    if (toPar === 0)   return { color: "#58a6ff", fontWeight: 700 };  // par
    if (toPar === 1)   return { color: "#e67e22", fontWeight: 600 };  // bogey
    return                    { color: "#e74c3c", fontWeight: 600 };  // double+
  };

  const scoreName = (toPar, par) => {
    if (toPar == null) return "–";
    const score = toPar + par;
    if (score === 1)   return toPar <= -2 ? "Condor" : "";  // hole-in-one on par 3 = birdie label below
    if (toPar <= -3)   return "Albatross";
    if (toPar === -2)  return "Eagle";
    if (toPar === -1)  return "Birdie";
    if (toPar === 0)   return "Par";
    if (toPar === 1)   return "Bogey";
    if (toPar === 2)   return "Double";
    if (toPar === 3)   return "Triple";
    return `+${toPar}`;
  };

  const toParStr = (n) => n > 0 ? `+${n}` : n === 0 ? "E" : `${n}`;

  // Hole-in-one check
  const hio = (h) => h.score === 1;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#000", display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, padding: "8px 16px",
        background: "rgba(0,0,0,0.8)", color: "#fff", flexShrink: 0, zIndex: 20, fontSize: 13,
      }}>
        <button onClick={onClose} style={{ ...btn("#e74c3c"), padding: "4px 10px", fontSize: 12 }}>← Exit</button>
        <strong style={{ fontSize: 15 }}>{courseName}</strong>
        {currentHole && (
          <>
            <span>Hole {currentHole.number} / {totalHoles}</span>
            <span>Par {par}</span>
            <span>Shots: {shotCount}</span>
          </>
        )}
        {distToPin !== null && status !== "holed" && (
          <span style={{ color: "#f1c40f" }}>📍 {distToPin} m to pin</span>
        )}
        <span style={{ marginLeft: "auto", color: wsStatus === "connected" ? "#2ecc71" : "#555" }}>
          ⚡ {wsStatus}
        </span>
      </div>

      {/* Viewport */}
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />

      {/* Shot panel — hidden while flying or when scoreboard is showing */}
      {status !== "flying" && status !== "holed" && (
        <div style={panelStyle}>
          {sliderRow("Ball Speed", ballSpeed,   40, 220, 1,  setBallSpeed,   " mph", `${speedMs} m/s`)}
          {sliderRow("Launch",     launchAngle,  2,  55, 1,  setLaunchAngle, "°")}
          {sliderRow("Direction",  azimuth,    -90,  90, 1,  setAzimuth,     "°")}
          {sliderRow("Backspin",   backspinRpm,  0, 9000, 50, setBackspinRpm, " rpm")}
          {sliderRow("Side Spin",  sidespinRpm, -3000, 3000, 50, setSidespinRpm, " rpm")}
          <button style={btn()} onClick={launchBall}>
            🏌️ Hit · {ballSpeed} mph · {launchAngle}° · {spinLabel}
          </button>
          {stateRef.current?.lastBallPos && (
            <div style={{ textAlign: "center", color: "#888", fontSize: 11 }}>
              Hitting from resting spot — <button
                onClick={() => { if (stateRef.current) stateRef.current.lastBallPos = null; setShotOriginXZ(null); }}
                style={{ background: "none", border: "none", color: "#58a6ff", cursor: "pointer", fontSize: 11 }}
              >return to tee</button>
            </div>
          )}
        </div>
      )}

      {/* Scoreboard overlay — shown when a hole is holed */}
      {status === "holed" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 30,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
        }}>
          <div style={{
            background: "#0d1117",
            border: "1px solid #30363d",
            borderRadius: 14,
            padding: "24px 28px",
            minWidth: 420,
            maxWidth: 600,
            maxHeight: "80vh",
            overflowY: "auto",
            boxShadow: "0 20px 60px rgba(0,0,0,0.8)",
            fontFamily: "monospace",
          }}>

            {/* Header */}
            <div style={{ textAlign: "center", marginBottom: 18 }}>
              <div style={{ fontSize: 13, color: "#8b949e", letterSpacing: "0.12em", textTransform: "uppercase" }}>
                {hio(holeScores[holeIndex]) ? "🏆 Hole in One!" : "⛳ Hole Complete"}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#e6edf3", marginTop: 4 }}>
                {courseName}
              </div>
              <div style={{ fontSize: 13, color: "#8b949e", marginTop: 2 }}>
                Hole {holeIndex + 1} of {totalHoles} · Par {currentHole?.par ?? "–"} · {shotCount} shot{shotCount !== 1 ? "s" : ""}
                {holeScores[holeIndex].toPar != null && (
                  <span style={{ marginLeft: 8, ...scoreStyle(holeScores[holeIndex].toPar) }}>
                    ({scoreName(holeScores[holeIndex].toPar, currentHole?.par)})
                  </span>
                )}
              </div>
            </div>

            {/* Scorecard table */}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #21262d", color: "#8b949e" }}>
                  <th style={{ textAlign: "left",  padding: "5px 6px", fontWeight: 500 }}>Hole</th>
                  <th style={{ textAlign: "right", padding: "5px 6px", fontWeight: 500 }}>Par</th>
                  <th style={{ textAlign: "right", padding: "5px 6px", fontWeight: 500 }}>Yds</th>
                  <th style={{ textAlign: "right", padding: "5px 6px", fontWeight: 500 }}>Score</th>
                  <th style={{ textAlign: "right", padding: "5px 6px", fontWeight: 500 }}>+/−</th>
                  <th style={{ textAlign: "left",  padding: "5px 6px", fontWeight: 500, paddingLeft: 10 }}></th>
                </tr>
              </thead>
              <tbody>
                {holeScores.map(({ hole, score, toPar }, idx) => {
                  const isCurrent  = idx === holeIndex;
                  const isFuture   = score == null;
                  const rowBg      = isCurrent ? "rgba(46,204,113,0.08)" : "transparent";
                  return (
                    <tr key={hole.number} style={{
                      background: rowBg,
                      borderBottom: "1px solid #161b22",
                      opacity: isFuture ? 0.38 : 1,
                    }}>
                      <td style={{ padding: "6px 6px", color: isCurrent ? "#2ecc71" : "#e6edf3", fontWeight: isCurrent ? 700 : 400 }}>
                        {hole.number}
                      </td>
                      <td style={{ textAlign: "right", padding: "6px 6px", color: "#8b949e" }}>{hole.par ?? "–"}</td>
                      <td style={{ textAlign: "right", padding: "6px 6px", color: "#8b949e" }}>{hole.yardage ?? "–"}</td>
                      <td style={{ textAlign: "right", padding: "6px 6px", ...scoreStyle(toPar) }}>
                        {score ?? "–"}
                      </td>
                      <td style={{ textAlign: "right", padding: "6px 6px", ...scoreStyle(toPar) }}>
                        {toPar != null ? toParStr(toPar) : "–"}
                      </td>
                      <td style={{ textAlign: "left",  padding: "6px 6px", paddingLeft: 10, color: scoreStyle(toPar).color, fontSize: 11 }}>
                        {hio({ score }) ? "Hole in One!" : (toPar != null ? scoreName(toPar, hole.par) : "")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {completedCount > 0 && (
                <tfoot>
                  <tr style={{ borderTop: "2px solid #30363d", fontWeight: 700 }}>
                    <td style={{ padding: "8px 6px", color: "#e6edf3" }}>Total</td>
                    <td style={{ textAlign: "right", padding: "8px 6px", color: "#8b949e" }}>{totalPar}</td>
                    <td></td>
                    <td style={{ textAlign: "right", padding: "8px 6px", color: "#e6edf3" }}>{totalScore}</td>
                    <td style={{ textAlign: "right", padding: "8px 6px", ...scoreStyle(totalToPar) }}>
                      {toParStr(totalToPar)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "center" }}>
              {holeIndex + 1 < totalHoles ? (
                <button style={{ ...btn(), minWidth: 140 }} onClick={nextHole}>
                  Next Hole →
                </button>
              ) : (
                <>
                  <div style={{ color: "#f1c40f", fontWeight: 700, fontSize: 15, alignSelf: "center" }}>
                    Round Complete · {toParStr(totalToPar)}
                  </div>
                  <button style={{ ...btn("#e74c3c"), minWidth: 140 }} onClick={onClose}>
                    Finish Round
                  </button>
                </>
              )}
            </div>

          </div>
        </div>
      )}

      {status === "loading" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 18, pointerEvents: "none" }}>
          Building course…
        </div>
      )}

      {/* Minimap */}
      {status !== "loading" && bounds && (
        <Minimap
          stateRef={stateRef}
          teeXZ={minimapTeeXZ}
          pinXZ={minimapPinXZ}
          features={minimapFeatures}
          worldBounds={minimapWorldBounds}
          aimAzimuth={azimuth}
          onAimChange={handleAimChange}
          flipX={true}
        />
      )}
    </div>
  );
}
