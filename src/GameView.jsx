import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import RAPIER from "@dimforge/rapier3d-compat";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GRAVITY        = -9.81;
const BALL_RADIUS    = 0.0214; // real golf ball radius in meters (scaled ×10 for visibility)
const BALL_RADIUS_VIS = 0.3;
const BALL_MASS      = 0.0459;
const MAX_POWER      = 80;     // m/s max launch speed
const HOLE_RADIUS    = 0.54;   // meters — if ball within this distance of pin, it's holed

// Low-poly feature colours (Three.js hex)
const FEATURE_COLORS = {
  fairway:    0x5aaa4a,
  green_area: 0x3d9e36,
  bunker:     0xe8d59a,
  water:      0x3a7bd5,
  path:       0xb0b8c0,
  rough:      0x3a6b2a, // default terrain
};

// Try to load a GLTF asset; resolves to the scene or null if not found.
// Drop files in /public/assets/ — e.g. /public/assets/tree.glb
const gltfLoader = new GLTFLoader();
function loadGLTF(url) {
  return new Promise(resolve => {
    gltfLoader.load(url, gltf => resolve(gltf.scene), undefined, () => resolve(null));
  });
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
    x: -(lng - centerLon) * mPerLon, // X pre-negated to match OBJ export
    z:  (lat - centerLat) * mPerLat,
  });
}

// Degrees → radians
const deg2rad = d => d * Math.PI / 180;

// ---------------------------------------------------------------------------
// fetchSatelliteTexture (same as TerrainPreview — tile stitching)
// ---------------------------------------------------------------------------
async function fetchSatelliteTexture(bounds) {
  const { north, south, east, west } = bounds;
  const zoom = 16;
  const lon2tile = (lon, z) => Math.floor((lon + 180) / 360 * (1 << z));
  const lat2tile = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << z));

  const tx0 = lon2tile(west, zoom),  tx1 = lon2tile(east, zoom);
  const ty0 = lat2tile(north, zoom), ty1 = lat2tile(south, zoom);
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const TW = 256;
  const canvas = document.createElement("canvas");
  canvas.width = cols * TW; canvas.height = rows * TW;
  const ctx = canvas.getContext("2d");

  await Promise.all(
    Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) =>
        new Promise(resolve => {
          const img = new Image(); img.crossOrigin = "anonymous";
          img.onload  = () => { ctx.drawImage(img, c * TW, r * TW, TW, TW); resolve(); };
          img.onerror = () => resolve();
          img.src = `/tiles/${zoom}/${ty0 + r}/${tx0 + c}`;
        })
      )
    ).flat()
  );
  return canvas;
}

// ---------------------------------------------------------------------------
// GameView component
// ---------------------------------------------------------------------------
export default function GameView({ objText, bounds, courseJson, courseName, trees = [], onClose }) {
  const mountRef   = useRef(null);
  const stateRef   = useRef(null); // mutable game state (Three.js + Rapier)

  const [status,     setStatus]     = useState("loading"); // loading | ready | flying | holed
  const [holeIndex,  setHoleIndex]  = useState(0);
  const [shots,      setShots]      = useState([]);        // shots per hole [n, n, …]
  const [shotCount,  setShotCount]  = useState(0);
  const [power,      setPower]      = useState(60);        // 0-100 %
  const [azimuth,    setAzimuth]    = useState(0);         // degrees, 0=north
  const [loft,       setLoft]       = useState(12);        // degrees launch angle
  const [wsStatus,   setWsStatus]   = useState("disconnected");
  const [distToPin,  setDistToPin]  = useState(null);

  // -------------------------------------------------------------------------
  // Build Three.js + Rapier scene once objText changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!mountRef.current || !objText) return;
    let destroyed = false;
    let animId;
    let rapierWorld = null;
    let ballBody    = null;
    let ballMesh    = null;
    let controls    = null;
    let renderer    = null;
    let followBall  = false;

    (async () => {
      // -- Rapier init --
      await RAPIER.init();
      if (destroyed) return;

      rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });

      // -- Three.js renderer --
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(w, h);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mountRef.current.appendChild(renderer.domElement);

      // -- Scene --
      const scene  = new THREE.Scene();
      scene.background = new THREE.Color(0x87ceeb); // sky blue
      scene.fog = new THREE.Fog(0x87ceeb, 800, 2000);

      const ambient = new THREE.AmbientLight(0xffffff, 0.7);
      scene.add(ambient);
      const sun = new THREE.DirectionalLight(0xfffbe8, 1.2);
      sun.position.set(300, 600, 200);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far  = 3000;
      sun.shadow.camera.left = sun.shadow.camera.bottom = -800;
      sun.shadow.camera.right = sun.shadow.camera.top  =  800;
      scene.add(sun);

      // -- Camera --
      const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 5000);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;

      // -- Load terrain OBJ --
      const terrainObj = new OBJLoader().parse(objText);
      const terrainMeshes = [];
      let minElev = Infinity, box = new THREE.Box3();

      terrainObj.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        child.receiveShadow = true;
        child.castShadow    = false;
        // Default rough colour — feature polygons will paint over this below
        child.material = new THREE.MeshLambertMaterial({ color: FEATURE_COLORS.rough, side: THREE.DoubleSide });
        terrainMeshes.push(child);
        box.expandByObject(child);
      });
      scene.add(terrainObj);

      const centre = new THREE.Vector3();
      box.getCenter(centre);
      const size   = new THREE.Vector3();
      box.getSize(size);
      const span   = Math.max(size.x, size.z);

      // Camera default: south of terrain, looking north (same as TerrainPreview)
      camera.position.set(centre.x, centre.y + span * 0.5, centre.z - span * 0.9);
      controls.target.copy(centre);
      controls.update();

      // -- Build Rapier trimesh collider from terrain geometry --
      const verts = [], indices = [];
      let vOffset = 0;
      for (const mesh of terrainMeshes) {
        const geo  = mesh.geometry;
        const pos  = geo.attributes.position;
        const idx  = geo.index;
        for (let i = 0; i < pos.count; i++) {
          verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        }
        if (idx) {
          for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vOffset);
        } else {
          for (let i = 0; i < pos.count; i++) indices.push(i + vOffset);
        }
        vOffset += pos.count;
      }
      const terrainDesc = RAPIER.ColliderDesc.trimesh(
        new Float32Array(verts),
        new Uint32Array(indices)
      );
      rapierWorld.createCollider(terrainDesc);

      // -- Ball mesh --
      const ballGeo  = new THREE.SphereGeometry(BALL_RADIUS_VIS, 16, 16);
      const ballMat  = new THREE.MeshPhongMaterial({ color: 0xffffff });
      ballMesh       = new THREE.Mesh(ballGeo, ballMat);
      ballMesh.castShadow = true;
      ballMesh.visible    = false;
      scene.add(ballMesh);

      // -- Ball trail --
      const trailPoints = [];
      const trailGeo    = new THREE.BufferGeometry();
      const trailMat    = new THREE.LineBasicMaterial({ color: 0xffff00, opacity: 0.5, transparent: true });
      const trailLine   = new THREE.Line(trailGeo, trailMat);
      scene.add(trailLine);

      // -- Hole markers (flag + cup) --
      const toXZ        = makeToXZ(bounds);
      const holeObjects = []; // { pinXZ, flagGroup, holeIndex }

      for (const hole of (courseJson?.holes || [])) {
        const pin = hole.markers?.find(m => m.type === "green") ||
                    courseJson?.markers?.find(m => m.hole === hole.number && m.type === "green");
        if (!pin) continue;
        const { x, z } = toXZ(pin.lat, pin.lng);

        // Raycast down to find Y
        const ray = new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 });
        const hit = rapierWorld.castRay(ray, 1000, true);
        const y   = hit ? 500 - hit.timeOfImpact : centre.y;

        // Flag pole
        const poleGeo  = new THREE.CylinderGeometry(0.03, 0.03, 3, 6);
        const poleMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const pole     = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(x, y + 1.5, z);
        pole.castShadow = true;

        // Flag
        const flagGeo  = new THREE.PlaneGeometry(0.8, 0.5);
        const flagMat  = new THREE.MeshLambertMaterial({ color: 0xff2222, side: THREE.DoubleSide });
        const flag     = new THREE.Mesh(flagGeo, flagMat);
        flag.position.set(x + 0.4, y + 2.8, z);

        // Cup ring
        const ringGeo  = new THREE.RingGeometry(HOLE_RADIUS * 0.8, HOLE_RADIUS, 16);
        const ringMat  = new THREE.MeshLambertMaterial({ color: 0x222222, side: THREE.DoubleSide });
        const ring     = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, y + 0.02, z);

        scene.add(pole, flag, ring);
        holeObjects.push({ pinXZ: { x, y, z }, holeNumber: hole.number });
      }

      // -- Low-poly feature polygon overlays --
      // For each drawn feature polygon, place a flat mesh just above the terrain
      // coloured by feature type (fairway=green, bunker=sand, water=blue, etc.)
      for (const hole of (courseJson?.holes || [])) {
        for (const feat of (hole.features || [])) {
          if (!feat.points || feat.points.length < 3) continue;
          const color = FEATURE_COLORS[feat.type] || FEATURE_COLORS.rough;
          const pts2d = feat.points.map(p => toXZ(p.lat, p.lng));

          // Build a flat polygon mesh slightly above ground (Y=0.15 m)
          const shape = new THREE.Shape(pts2d.map(p => new THREE.Vector2(p.x, p.z)));
          const geo   = new THREE.ShapeGeometry(shape);
          // ShapeGeometry uses XY — rotate to XZ plane
          geo.rotateX(-Math.PI / 2);
          const mat  = new THREE.MeshLambertMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: feat.type === "water",
            opacity:     feat.type === "water" ? 0.85 : 1.0,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.y = 0.15;
          mesh.receiveShadow = true;
          scene.add(mesh);
        }
      }

      // -- Trees from satellite detection --
      // Tries to load /public/assets/tree.glb first; falls back to cone+cylinder primitive
      const treeProto = await loadGLTF("/assets/tree.glb");
      if (destroyed) return;

      const trunkMat  = new THREE.MeshLambertMaterial({ color: 0x6b4226 });
      const canopyMat = new THREE.MeshLambertMaterial({ color: 0x2d5e1e });

      for (const tree of trees) {
        const { x, z } = toXZ(tree.lat, tree.lng);
        const tRay = new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 });
        const tHit = rapierWorld.castRay(tRay, 1000, true);
        const groundY = tHit ? 500 - tHit.timeOfImpact : centre.y;
        const treeH = Math.max((tree.heightAboveGround || 1) * 6, 12);

        let treeObj;
        if (treeProto) {
          treeObj = treeProto.clone();
          treeObj.scale.setScalar(treeH / 10);
          treeObj.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        } else {
          // Primitive fallback
          treeObj = new THREE.Group();
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, treeH * 0.35, 6), trunkMat);
          trunk.position.y = treeH * 0.175;
          trunk.castShadow = true;
          const canopy = new THREE.Mesh(new THREE.ConeGeometry(treeH * 0.28, treeH * 0.7, 7), canopyMat);
          canopy.position.y = treeH * 0.35 + treeH * 0.35;
          canopy.castShadow = true;
          treeObj.add(trunk, canopy);
        }
        treeObj.position.set(x, groundY, z);
        scene.add(treeObj);
      }

      // -- Store mutable state --
      stateRef.current = {
        scene, camera, renderer, controls, rapierWorld,
        terrainMeshes, holeObjects, toXZ,
        ballMesh, ballBody: null,
        trailPoints, trailGeo, trailLine,
        followBall: false,
        centre, span,
      };

      // -- Animate --
      const FIXED_DT = 1 / 120;
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
          // Step physics
          const steps = Math.round(dt / FIXED_DT);
          for (let i = 0; i < steps; i++) {
            ref.rapierWorld.step();
          }

          // Sync ball mesh
          const t = ref.ballBody.translation();
          ref.ballMesh.position.set(t.x, t.y, t.z);

          // Trail
          ref.trailPoints.push(new THREE.Vector3(t.x, t.y, t.z));
          if (ref.trailPoints.length > 300) ref.trailPoints.shift();
          ref.trailGeo.setFromPoints(ref.trailPoints);

          // Follow camera
          if (ref.followBall) {
            const vel = ref.ballBody.linvel();
            const speed = Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2);
            const behindX = t.x - vel.x * 3;
            const behindZ = t.z - vel.z * 3;
            ref.camera.position.lerp(
              new THREE.Vector3(behindX, t.y + 8, behindZ), 0.05
            );
            ref.controls.target.lerp(new THREE.Vector3(t.x, t.y, t.z), 0.1);

            // Check if ball has nearly stopped
            if (speed < 0.3) {
              ref.followBall = false;
              ref.ballBody   = null;
              setStatus("ready");

              // Check hole-in distance
              const curHole = ref.holeObjects[stateRef.current._holeIndex ?? 0];
              if (curHole) {
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
      };
      window.addEventListener("resize", onResize);

      setStatus("ready");
      stateRef.current._cleanup = () => {
        window.removeEventListener("resize", onResize);
      };
    })();

    return () => {
      destroyed = true;
      cancelAnimationFrame(animId);
      // Null stateRef first so the animate loop bails if it gets one more tick
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

    // Remove old ball body
    if (ref.ballBody) {
      ref.rapierWorld.removeRigidBody(ref.ballBody);
      ref.ballBody = null;
    }

    // Find tee position for current hole
    const currentHole = (courseJson?.holes || [])[holeIndex];
    const tee = courseJson?.markers?.find(m =>
      m.hole === currentHole?.number && m.type === "tee"
    );

    let startX, startZ;
    if (tee) {
      const { x, z } = ref.toXZ(tee.lat, tee.lng);
      startX = x; startZ = z;
    } else {
      startX = ref.centre.x; startZ = ref.centre.z;
    }

    // Raycast to find ground Y at tee
    const ray = new RAPIER.Ray({ x: startX, y: 500, z: startZ }, { x: 0, y: -1, z: 0 });
    const hit = ref.rapierWorld.castRay(ray, 1000, true);
    const groundY = hit ? 500 - hit.timeOfImpact : ref.centre.y;
    const startY  = groundY + BALL_RADIUS_VIS + 0.1;

    // Create rigid body
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(startX, startY, startZ)
      .setLinearDamping(0.1)
      .setAngularDamping(0.5);
    const body = ref.rapierWorld.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS_VIS)
      .setRestitution(0.6)
      .setFriction(0.4)
      .setMass(BALL_MASS);
    ref.rapierWorld.createCollider(colDesc, body);

    // Compute launch velocity
    const speed   = (power / 100) * MAX_POWER;
    const loftRad = deg2rad(loft);
    const azRad   = deg2rad(azimuth); // 0 = north (+Z), 90 = east (-X in our negated system)
    const vx      = -Math.sin(azRad) * Math.cos(loftRad) * speed;
    const vy      =  Math.sin(loftRad) * speed;
    const vz      =  Math.cos(azRad)   * Math.cos(loftRad) * speed;
    body.setLinvel({ x: vx, y: vy, z: vz }, true);

    ref.ballBody    = body;
    ref.ballMesh.visible  = true;
    ref.ballMesh.position.set(startX, startY, startZ);
    ref.trailPoints.length = 0;
    ref.followBall  = true;
    ref.camera.position.set(startX - vx * 0.2, startY + 6, startZ - vz * 0.2);
    ref.controls.target.set(startX, startY, startZ);

    // Track hole index for landing check
    stateRef.current._holeIndex = holeIndex;

    setShotCount(c => c + 1);
    setDistToPin(null);
    setStatus("flying");
  }, [courseJson, holeIndex, power, azimuth, loft]);

  // -------------------------------------------------------------------------
  // WebSocket launch monitor connection
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
            // GSPro-style: { BallSpeed, LaunchAngle, LaunchDirection }
            if (data.BallSpeed    != null) setPower(Math.min(100, (data.BallSpeed / MAX_POWER) * 100));
            if (data.LaunchAngle  != null) setLoft(data.LaunchAngle);
            if (data.LaunchDirection != null) setAzimuth(data.LaunchDirection);
            // Auto-launch on shot received
            setTimeout(() => launchBall(), 100);
          } catch {}
        };
      } catch {}
    };
    connect();
    return () => ws?.close();
  }, [launchBall]);

  // -------------------------------------------------------------------------
  // Advance to next hole
  // -------------------------------------------------------------------------
  const nextHole = useCallback(() => {
    setShots(s => {
      const next = [...s];
      next[holeIndex] = shotCount;
      return next;
    });
    setHoleIndex(i => i + 1);
    setShotCount(0);
    setStatus("ready");
    setDistToPin(null);

    // Reset camera
    const ref = stateRef.current;
    if (ref) {
      ref.camera.position.set(ref.centre.x, ref.centre.y + ref.span * 0.5, ref.centre.z - ref.span * 0.9);
      ref.controls.target.copy(ref.centre);
      if (ref.ballMesh) ref.ballMesh.visible = false;
    }
  }, [holeIndex, shotCount]);

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  const currentHole = (courseJson?.holes || [])[holeIndex];
  const par         = currentHole?.par ?? "–";
  const totalHoles  = (courseJson?.holes || []).length;

  const panelStyle = {
    position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
    borderRadius: 12, padding: "12px 20px", color: "#fff",
    display: "flex", flexDirection: "column", gap: 10, minWidth: 320,
    fontSize: 13, userSelect: "none", zIndex: 10,
  };

  const btnStyle = (color = "#2ecc71") => ({
    background: color, border: "none", borderRadius: 8,
    color: "#fff", padding: "8px 18px", cursor: "pointer",
    fontWeight: 700, fontSize: 14,
  });

  const sliderRow = (label, val, min, max, step, setter, unit = "") => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 72, color: "#aaa" }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={e => setter(+e.target.value)}
        style={{ flex: 1 }} />
      <span style={{ width: 44, textAlign: "right" }}>{val}{unit}</span>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#000", display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, padding: "8px 16px",
        background: "rgba(0,0,0,0.8)", color: "#fff", flexShrink: 0, zIndex: 20,
        fontSize: 13,
      }}>
        <button onClick={onClose} style={{ ...btnStyle("#e74c3c"), padding: "4px 10px", fontSize: 12 }}>✕ Exit</button>
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
        {status === "holed" && (
          <span style={{ color: "#2ecc71", fontWeight: 700 }}>⛳ Holed!</span>
        )}
        <span style={{ marginLeft: "auto", color: wsStatus === "connected" ? "#2ecc71" : "#888" }}>
          ⚡ Launch monitor: {wsStatus}
        </span>
      </div>

      {/* 3D viewport */}
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />

      {/* Shot panel — hidden while ball is flying */}
      {status !== "flying" && (
        <div style={panelStyle}>
          {status === "holed" ? (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 18, marginBottom: 8 }}>⛳ Holed in {shotCount}!</div>
              {holeIndex + 1 < totalHoles
                ? <button style={btnStyle()} onClick={nextHole}>Next Hole →</button>
                : <div style={{ color: "#f1c40f" }}>Course complete!</div>
              }
            </div>
          ) : (
            <>
              {sliderRow("Power",   power,   0, 100,  1, setPower,  "%")}
              {sliderRow("Azimuth", azimuth, -90, 90,  1, setAzimuth, "°")}
              {sliderRow("Loft",    loft,    5,  60,   1, setLoft,   "°")}
              <button style={btnStyle()} onClick={launchBall}>
                🏌️ Hit ({Math.round((power / 100) * MAX_POWER)} m/s · {loft}° · {azimuth > 0 ? azimuth + "°R" : azimuth < 0 ? Math.abs(azimuth) + "°L" : "Straight"})
              </button>
            </>
          )}
        </div>
      )}

      {status === "loading" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 18, pointerEvents: "none" }}>
          Building course…
        </div>
      )}
    </div>
  );
}
