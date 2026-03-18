import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import RAPIER from "@dimforge/rapier3d-compat";
import Minimap from "./Minimap.jsx";
import {
  GRAVITY, BALL_RADIUS_VIS, BALL_RADIUS_PHYS, BALL_MASS,
  computeAeroForces, computeLaunchVelocity, createRollingBody, applyLandingSpin,
} from "./ballPhysics.js";

const YARDS_TO_M = 0.9144;
const YARDAGES   = [50, 100, 150, 200, 250];
const TEE_POS    = new THREE.Vector3(0, 0, 0); // camera / ball origin

const TREE_MODEL_URLS = [
  "/Models/tree_pineDefaultA.glb",
  "/Models/tree_pineDefaultB.glb",
  "/Models/tree_pineTallA.glb",
  "/Models/tree_pineRoundC.glb",
  "/Models/tree_pineRoundD.glb",
  "/Models/tree_pineSmallA.glb",
  "/Models/tree_pineSmallB.glb",
  "/Models/tree_default.glb",
  "/Models/tree_oak.glb",
  "/Models/tree_fat.glb",
  "/Models/tree_thin.glb",
  "/Models/tree_small.glb",
];

const GRASS_MODEL_URLS = [
  "/Models/grass_large.glb",
  "/Models/grass_leafs.glb",
];

// Color-coded large flags per yardage
const FLAG_URLS = { 50: "/Models/flag-large-red.glb", 100: "/Models/flag-large-blue.glb", 150: "/Models/flag-large-green.glb", 200: "/Models/flag-large-red.glb", 250: "/Models/flag-large-blue.glb" };

// Driving-range colour scheme: each yardage band has a distinct colour
const YARDAGE_COLORS = { 50: 0xff4444, 100: 0x4488ff, 150: 0xffffff, 200: 0xffcc00, 250: 0x44cc44 };

// Static minimap data for the driving range
const RANGE_TEE_XZ     = { x: 0, z: 0 };
const RANGE_WORLD_BOUNDS = { minX: -65, maxX: 65, minZ: -25, maxZ: 265 };
const RANGE_FEATURES   = [
  { type: "fairway", points: [{ x: -32, z: -5 }, { x: 32, z: -5 }, { x: 32, z: 260 }, { x: -32, z: 260 }] },
];
const RANGE_TARGETS    = YARDAGES.map(yd => ({
  z: yd * YARDS_TO_M,
  color: "#" + YARDAGE_COLORS[yd].toString(16).padStart(6, "0"),
}));


const gltfLoader = new GLTFLoader();
function loadGLTF(url) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 6000);
    gltfLoader.load(
      url,
      g  => { clearTimeout(timer); resolve(g.scene); },
      undefined,
      () => { clearTimeout(timer); resolve(null); }
    );
  });
}

// Build a CanvasTexture displaying the given yardage number
function makeSignTexture(yd, accent) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, 128, 64);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 124, 60);
  ctx.fillStyle = accent;
  ctx.font = "bold 34px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${yd}`, 64, 34);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function DrivingRange({ onClose }) {
  const mountRef = useRef(null);
  const stateRef = useRef(null);

  const [status,          setStatus]          = useState("loading");
  const [loadingMsg,      setLoadingMsg]      = useState("Initializing physics…");
  const [ballSpeed,       setBallSpeed]       = useState(134);  // mph
  const [launchAngle,     setLaunchAngle]     = useState(16);   // degrees
  const [azimuth,         setAzimuth]         = useState(0);    // degrees
  const [backspinRpm,     setBackspinRpm]     = useState(5000); // rpm
  const [sidespinRpm,     setSidespinRpm]     = useState(0);    // rpm
  const [selectedTarget,  setSelectedTarget]  = useState(null);
  const [shotCount,       setShotCount]       = useState(0);
  const [lastLanding,     setLastLanding]     = useState(null); // { yds, x, z }

  // -------------------------------------------------------------------------
  // Scene setup
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!mountRef.current) return;
    let destroyed = false;
    let animId;
    let rapierWorld = null;
    let renderer    = null;
    let controls    = null;

    (async () => {
      try {
      setLoadingMsg("Initializing physics…");
      await RAPIER.init();
      if (destroyed) return;
      setLoadingMsg("Physics ready ✓");
      await Promise.resolve();

      // -- Physics --
      rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
      rapierWorld.timestep = 1 / 60;
      // Effectively-infinite flat ground — 10 km half-extents means the ball
      // can never reach an edge and get a bad collision normal.
      rapierWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(10000, 0.5, 10000)
          .setTranslation(0, -0.5, 0)
          .setRestitution(0.1)
          .setFriction(0.8)
      );

      // -- Renderer --
      setLoadingMsg("Creating renderer…");
      await Promise.resolve();
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(w, h);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mountRef.current.appendChild(renderer.domElement);

      // -- Scene --
      setLoadingMsg("Building scene…");
      await Promise.resolve();
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x7ab8e8);
      scene.fog = new THREE.FogExp2(0xb8d8f0, 0.006);

      // Sky gradient dome
      const skyDome = new THREE.Mesh(
        new THREE.SphereGeometry(900, 16, 8),
        new THREE.ShaderMaterial({
          uniforms: {
            topColor:    { value: new THREE.Color(0x3a7fcf) },
            bottomColor: { value: new THREE.Color(0xb8d9f0) },
          },
          vertexShader: `
            varying float vY;
            void main() { vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
          `,
          fragmentShader: `
            uniform vec3 topColor; uniform vec3 bottomColor; varying float vY;
            void main() { float t = clamp(vY * 1.4 + 0.1, 0.0, 1.0); gl_FragColor = vec4(mix(bottomColor, topColor, pow(t, 0.6)), 1.0); }
          `,
          side: THREE.BackSide,
        })
      );
      scene.add(skyDome);

      scene.add(new THREE.HemisphereLight(0x9ecfef, 0x3a6e20, 0.7));
      const sun = new THREE.DirectionalLight(0xfff5e0, 1.4);
      sun.position.set(150, 400, 100);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far  = 800;
      sun.shadow.camera.left = sun.shadow.camera.bottom = -250;
      sun.shadow.camera.right = sun.shadow.camera.top   =  250;
      scene.add(sun);

      setLoadingMsg("Building ground…");
      await Promise.resolve();
      // -- Ground layers --
      // Outer rough (full width, dark)
      const roughGeo = new THREE.PlaneGeometry(400, 700);
      roughGeo.rotateX(-Math.PI / 2);
      const rough = new THREE.Mesh(roughGeo, new THREE.MeshLambertMaterial({ color: 0x2e5e18 }));
      rough.position.set(0, 0, 160);
      rough.receiveShadow = true;
      scene.add(rough);

      // Inner rough strips (between fairway and treeline)
      for (const sx of [-1, 1]) {
        const irGeo = new THREE.PlaneGeometry(30, 620);
        irGeo.rotateX(-Math.PI / 2);
        const ir = new THREE.Mesh(irGeo, new THREE.MeshLambertMaterial({ color: 0x3a7220 }));
        ir.position.set(sx * 48, 0.005, 160);
        ir.receiveShadow = true;
        scene.add(ir);
      }

      // Rolling back hill — gives depth and closes off the horizon naturally
      const hillGeo = new THREE.SphereGeometry(120, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.38);
      const hill = new THREE.Mesh(hillGeo, new THREE.MeshLambertMaterial({ color: 0x2e5e18 }));
      hill.rotation.x = Math.PI;
      hill.position.set(0, -102, 310);
      hill.receiveShadow = true;
      scene.add(hill);

      // Fairway (bright centre strip)
      const fwGeo = new THREE.PlaneGeometry(66, 580);
      fwGeo.rotateX(-Math.PI / 2);
      const fairway = new THREE.Mesh(fwGeo, new THREE.MeshLambertMaterial({ color: 0x52b030 }));
      fairway.position.set(0, 0.01, 165);
      fairway.receiveShadow = true;
      scene.add(fairway);

      // Alternating mow-stripe tint (every 18 m)
      for (let z = 0; z < 280; z += 18) {
        const stripeGeo = new THREE.PlaneGeometry(66, 9);
        stripeGeo.rotateX(-Math.PI / 2);
        const stripe = new THREE.Mesh(stripeGeo, new THREE.MeshLambertMaterial({ color: 0x5abb35, transparent: true, opacity: 0.55 }));
        stripe.position.set(0, 0.012, z + 4.5);
        scene.add(stripe);
      }

      // Tee mat (hitting area)
      const matGeo = new THREE.PlaneGeometry(14, 7);
      matGeo.rotateX(-Math.PI / 2);
      const teeMat2 = new THREE.Mesh(matGeo, new THREE.MeshLambertMaterial({ color: 0x7ad44a }));
      teeMat2.position.set(0, 0.015, -1.5);
      teeMat2.receiveShadow = true;
      scene.add(teeMat2);

      // Tee peg area (slightly raised bright patch)
      const teeBox = new THREE.Mesh(
        new THREE.BoxGeometry(3, 0.06, 2),
        new THREE.MeshLambertMaterial({ color: 0x9ee060 })
      );
      teeBox.position.set(0, 0.03, 0);
      teeBox.receiveShadow = true;
      scene.add(teeBox);

      setLoadingMsg("Drawing yardage lines…");
      await Promise.resolve();
      // -- Yardage arc lines on fairway --
      const HALF_ARC = 30; // half-width of arcs in metres
      function addArc(yd, major) {
        const R = yd * YARDS_TO_M;
        const maxA = Math.min(Math.PI * 0.45, Math.asin(Math.min(HALF_ARC / R, 1)));
        const N = 56;
        const pts = [];
        for (let i = 0; i <= N; i++) {
          const a = -maxA + (2 * maxA * i / N);
          pts.push(new THREE.Vector3(R * Math.sin(a), 0.025, R * Math.cos(a)));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineDashedMaterial({
          color: major ? 0xffffff : 0x88cc66,
          dashSize: major ? 1.8 : 0.9,
          gapSize:  major ? 0.9 : 1.2,
          opacity:  major ? 0.75 : 0.4,
          transparent: true,
        });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        scene.add(line);

        // Yardage label on right edge of arc
        if (major) {
          const labelX = R * Math.sin(maxA);
          const labelZ = R * Math.cos(maxA);
          const c = document.createElement("canvas"); c.width = 96; c.height = 48;
          const cx = c.getContext("2d");
          cx.fillStyle = "rgba(0,0,0,0)";
          cx.fillRect(0,0,96,48);
          cx.fillStyle = "rgba(255,255,255,0.85)";
          cx.font = "bold 26px Arial";
          cx.textAlign = "center"; cx.textBaseline = "middle";
          cx.fillText(`${yd}`, 48, 24);
          const tex = new THREE.CanvasTexture(c);
          const label = new THREE.Mesh(
            new THREE.PlaneGeometry(3, 1.5),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
          );
          label.rotation.x = -Math.PI / 2;
          label.position.set(labelX + 3, 0.03, labelZ);
          scene.add(label);
        }
      }
      // Minor arcs at every 25 yd
      for (let yd = 25; yd <= 250; yd += 25) addArc(yd, YARDAGES.includes(yd));
      // Extra minor arcs at 10 yd
      for (let yd = 10; yd <= 250; yd += 10) {
        if (yd % 25 !== 0) addArc(yd, false);
      }

      setLoadingMsg("Placing markers…");
      await Promise.resolve();
      // -- Yardage markers + target discs --
      const targetMeshes = {}; // yardage → disc mesh
      for (const yd of YARDAGES) {
        const z     = yd * YARDS_TO_M;
        const color = YARDAGE_COLORS[yd];
        const hex   = "#" + color.toString(16).padStart(6, "0");

        // Pole (left side at X=-38)
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05, 0.07, 2.5, 6),
          new THREE.MeshLambertMaterial({ color })
        );
        pole.position.set(-38, 1.25, z);
        pole.castShadow = true;
        scene.add(pole);

        // Sign face
        const signTex  = makeSignTexture(yd, hex);
        const signMesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1.6, 0.8),
          new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide })
        );
        signMesh.position.set(-38, 2.8, z);
        scene.add(signMesh);

        // Target disc on fairway
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(4, 4, 0.06, 32),
          new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.65, emissive: new THREE.Color(0x000000) })
        );
        disc.position.set(0, 0.03, z);
        disc.receiveShadow = true;
        scene.add(disc);
        targetMeshes[yd] = disc;
      }

      // -- Ball --
      const ballMesh = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_RADIUS_VIS, 16, 16),
        new THREE.MeshPhongMaterial({ color: 0xffffff })
      );
      ballMesh.castShadow = true;
      ballMesh.visible    = false;
      scene.add(ballMesh);

      // -- Shot tracer (Line2 for visible pixel-width line) --
      const trailPoints = [];
      const trailGeo    = new LineGeometry();
      const trailMat    = new LineMaterial({
        color: 0xffffff,
        linewidth: 3,
        transparent: true,
        opacity: 0.90,
        resolution: new THREE.Vector2(w, h),
        depthTest: true,
        depthWrite: false,
      });
      trailGeo.setPositions([0, 0, 0, 0, 0, 0]);
      const trailLine = new Line2(trailGeo, trailMat);
      trailLine.visible = false;
      trailLine.renderOrder = 3;
      scene.add(trailLine);

      // Landing marker (small sphere shown where ball stopped)
      const landingMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.4, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xff8800 })
      );
      landingMesh.visible = false;
      scene.add(landingMesh);

      // -- Trees (load one at a time so progress is visible) --
      setLoadingMsg(`Loading trees… 0 / ${TREE_MODEL_URLS.length}`);
      const treeModels = [];
      for (let i = 0; i < TREE_MODEL_URLS.length; i++) {
        const m = await loadGLTF(TREE_MODEL_URLS[i]);
        if (destroyed) return;
        if (m) treeModels.push(m);
        setLoadingMsg(`Loading trees… ${i + 1} / ${TREE_MODEL_URLS.length}`);
      }
      if (destroyed) return;

      const trunkMat  = new THREE.MeshLambertMaterial({ color: 0x6b4226 });
      const canopyMat = new THREE.MeshLambertMaterial({ color: 0x2d5e1e });

      const rng = mulberry32(42);
      function placeTree(x, z) {
        const treeH = 22 + rng() * 16;  // 22–38 m — realistic mature tree height
        let obj;
        if (treeModels.length > 0) {
          obj = treeModels[Math.floor(rng() * treeModels.length)].clone();
          obj.scale.setScalar(treeH / 10);
          obj.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        } else {
          obj = new THREE.Group();
          const trunk  = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, treeH * 0.35, 6), trunkMat);
          trunk.position.y = treeH * 0.175; trunk.castShadow = true;
          const canopy = new THREE.Mesh(new THREE.ConeGeometry(treeH * 0.28, treeH * 0.7, 7), canopyMat);
          canopy.position.y = treeH * 0.35 + treeH * 0.35; canopy.castShadow = true;
          obj.add(trunk, canopy);
        }
        obj.position.set(x, 0, z);
        scene.add(obj);
      }

      // Treeline: starts tight at tee (~10 m) and fans to ~52 m at far end
      // Two rows per side for volume and depth
      const TREE_Z_MAX = 280;
      for (let z = -12; z < TREE_Z_MAX; z += 3.5 + rng() * 2.5) {
        const frac  = Math.max(0, z / TREE_Z_MAX);
        const inner = 10 + frac * 42;            // inner edge: 10 m → 52 m
        const outer = inner + 8 + rng() * 10;    // backing row
        placeTree(-(inner + rng() * 4), z);
        placeTree(  inner + rng() * 4,  z);
        if (rng() > 0.35) placeTree(-(outer + rng() * 5), z + rng() * 3 - 1.5);
        if (rng() > 0.35) placeTree(  outer + rng() * 5,  z + rng() * 3 - 1.5);
      }
      // Back wall closing off the far end
      for (let x = -60; x <= 60; x += 4 + rng() * 4) {
        placeTree(x + rng() * 3, TREE_Z_MAX - 5 + rng() * 8);
      }

      // -- Camera (first-person at tee) --
      const camera = new THREE.PerspectiveCamera(75, w / h, 0.1, 2000);
      camera.position.set(0, 1.8, -3);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 1.5, 120);
      controls.enableDamping = true;
      controls.update();

      // -- Store state --
      stateRef.current = {
        scene, camera, renderer, controls, rapierWorld,
        ballMesh, ballBody: null,
        trailPoints, trailGeo, trailMat, trailLine,
        landingMesh, targetMeshes,
        followBall: false,
        ballSpin: null,
        // Kinematic flight state
        phase: null,       // 'flight' | 'rolling' | null
        flightPos: null,   // { x, y, z } mutated each frame
        flightVel: null,   // { x, y, z } mutated each frame
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

        // ── FLIGHT: pure kinematic JS integration ────────────────────────────
        if (ref.phase === 'flight' && ref.flightPos) {
          const pos  = ref.flightPos;
          const vel  = ref.flightVel;
          const vLen = Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2);

          // Aero forces → accelerations
          const { Fx, Fy, Fz } = computeAeroForces(vel, vLen, true, ref.ballSpin, dt);
          vel.x += (Fx / BALL_MASS) * dt;
          vel.y += (GRAVITY + Fy / BALL_MASS) * dt;
          vel.z += (Fz / BALL_MASS) * dt;
          pos.x += vel.x * dt;
          pos.y += vel.y * dt;
          pos.z += vel.z * dt;

          ref.ballMesh.position.set(pos.x, pos.y, pos.z);
          ref.trailPoints.push(new THREE.Vector3(pos.x, pos.y, pos.z));
          if (ref.trailPoints.length > 400) ref.trailPoints.shift();
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
            ref.camera.position.lerp(
              new THREE.Vector3(pos.x - vel.x * 0.15, pos.y + 4, pos.z - vel.z * 0.15), 0.04
            );
            ref.controls.target.lerp(new THREE.Vector3(pos.x, pos.y, pos.z), 0.12);
          }

          // Ground contact → hand off to Rapier for surface-aware bounce / roll
          if (pos.y <= BALL_RADIUS_PHYS) {
            pos.y = BALL_RADIUS_PHYS + 0.002;
            // Surface key determines friction/damping (range = fairway-like)
            const body = createRollingBody(ref.rapierWorld, RAPIER, pos.x, pos.y, pos.z, 'fairway');
            body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
            // Imprint actual spin onto the Rapier body so friction produces
            // natural check-up and spin-back behaviour
            applyLandingSpin(body, vel, ref.ballSpin);
            ref.ballBody = body;
            ref.phase    = 'rolling';
          }

        // ── ROLLING: Rapier handles bounce / friction / roll-out ──────────────
        } else if (ref.phase === 'rolling' && ref.ballBody) {
          ref.rapierWorld.step();

          const t     = ref.ballBody.translation();
          const rvel  = ref.ballBody.linvel();
          const speed = Math.sqrt(rvel.x ** 2 + rvel.y ** 2 + rvel.z ** 2);

          ref.ballMesh.position.set(t.x, t.y, t.z);
          ref.trailPoints.push(new THREE.Vector3(t.x, t.y, t.z));
          if (ref.trailPoints.length > 400) ref.trailPoints.shift();
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
            ref.camera.position.lerp(
              new THREE.Vector3(t.x - rvel.x * 0.15, t.y + 4, t.z - rvel.z * 0.15), 0.04
            );
            ref.controls.target.lerp(new THREE.Vector3(t.x, t.y, t.z), 0.12);

            if (speed < 0.4 || t.y < -5) {
              ref.followBall = false;
              ref.rapierWorld.removeRigidBody(ref.ballBody);
              ref.ballBody = null;
              ref.phase    = null;

              // Show landing marker at rest position
              ref.landingMesh.position.set(t.x, Math.max(t.y, 0) + 0.4, t.z);
              ref.landingMesh.visible = true;

              const distM  = Math.sqrt(t.x ** 2 + t.z ** 2);
              const distYd = distM / YARDS_TO_M;
              setLastLanding({ yds: Math.round(distYd), x: t.x.toFixed(1), z: t.z.toFixed(1) });

              ref.camera.position.set(0, 1.8, -3);
              ref.controls.target.set(0, 1.5, 120);
              setStatus("ready");
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
      stateRef.current._cleanup = () => window.removeEventListener("resize", onResize);

      setStatus("ready");

      // -- Grass + flags load in background after scene is already visible --
      Promise.all([
        Promise.all(GRASS_MODEL_URLS.map(loadGLTF)).then(r => r.filter(Boolean)),
        ...YARDAGES.map(yd => loadGLTF(FLAG_URLS[yd])),
      ]).then(([grassModels, ...flagGltfs]) => {
        if (destroyed) return;
        const flagByYd = Object.fromEntries(YARDAGES.map((yd, i) => [yd, flagGltfs[i]]));

        // Flags at target centres
        for (const yd of YARDAGES) {
          const z = yd * YARDS_TO_M;
          const gltf = flagByYd[yd];
          if (gltf) {
            const flag = gltf.clone();
            flag.scale.setScalar(1.6);
            flag.position.set(0, 0, z);
            flag.traverse(c => { if (c.isMesh) c.castShadow = true; });
            scene.add(flag);
          } else {
            const pole = new THREE.Mesh(
              new THREE.CylinderGeometry(0.04, 0.04, 2.5, 6),
              new THREE.MeshLambertMaterial({ color: 0xcccccc })
            );
            pole.position.set(0, 1.25, z);
            scene.add(pole);
          }
        }

        // Grass clusters in rough strips
        if (grassModels.length > 0) {
          const rngG = mulberry32(77);
          for (let z = -5; z < 270; z += 3 + rngG() * 4) {
            for (const sx of [-1, 1]) {
              const xOff = sx * (35 + rngG() * 22);
              const gObj = grassModels[Math.floor(rngG() * grassModels.length)].clone();
              gObj.scale.setScalar(0.8 + rngG() * 0.7);
              gObj.rotation.y = rngG() * Math.PI * 2;
              gObj.position.set(xOff, 0, z);
              gObj.traverse(c => { if (c.isMesh) c.receiveShadow = true; });
              scene.add(gObj);
            }
          }
        }
      });
      } catch (err) {
        setLoadingMsg(`ERROR: ${err?.message ?? err}`);
        console.error("DrivingRange setup error:", err);
      }
    })();

    return () => {
      destroyed = true;
      cancelAnimationFrame(animId);
      const saved = stateRef.current;
      stateRef.current = null;
      try { saved?._cleanup?.(); } catch {}
      try { controls?.dispose(); } catch {}
      try { renderer?.dispose(); } catch {}
      try { rapierWorld?.free(); } catch {}
    };
  }, []);

  // -------------------------------------------------------------------------
  // Launch ball
  // -------------------------------------------------------------------------
  const launchBall = useCallback(() => {
    const ref = stateRef.current;
    if (!ref || !ref.rapierWorld) return;

    // Clean up any Rapier body left from a previous rolling phase
    if (ref.ballBody) {
      ref.rapierWorld.removeRigidBody(ref.ballBody);
      ref.ballBody = null;
    }

    // Hide landing marker from last shot
    ref.landingMesh.visible = false;

    const startY = BALL_RADIUS_PHYS + 0.1;
    const { vx, vy, vz } = computeLaunchVelocity(ballSpeed, launchAngle, azimuth, false);

    // Kinematic flight — no Rapier body yet
    ref.flightPos = { x: 0, y: startY, z: 0 };
    ref.flightVel = { x: vx, y: vy, z: vz };
    ref.ballSpin  = { backspin: backspinRpm, sidespin: sidespinRpm };
    ref.phase     = 'flight';

    ref.ballMesh.visible = true;
    ref.ballMesh.position.set(0, startY, 0);
    ref.trailPoints.length = 0;
    ref.trailLine.visible  = false;
    ref.trailGeo.setPositions([0, startY, 0, 0, startY, 0]);
    ref.followBall = true;

    setShotCount(c => c + 1);
    setLastLanding(null);
    setStatus("flying");
  }, [ballSpeed, launchAngle, azimuth, backspinRpm, sidespinRpm]);

  // -------------------------------------------------------------------------
  // Select target — highlight disc
  // -------------------------------------------------------------------------
  const selectTarget = useCallback((yd) => {
    setSelectedTarget(prev => {
      const next = prev === yd ? null : yd;
      const ref = stateRef.current;
      if (ref) {
        for (const [y, mesh] of Object.entries(ref.targetMeshes)) {
          const sel = Number(y) === next;
          mesh.material.emissive.setHex(sel ? 0x888800 : 0x000000);
          mesh.material.emissiveIntensity = sel ? 0.6 : 0;
          mesh.material.opacity = sel ? 1.0 : 0.65;
        }
        // If a target is selected, rotate camera to face it
        if (next) {
          const z = next * YARDS_TO_M;
          ref.controls.target.set(0, 1.5, z);
          ref.camera.position.set(0, 1.8, -3);
        }
      }
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Aim change from minimap — updates azimuth state AND pivots camera
  // -------------------------------------------------------------------------
  const handleAimChange = useCallback((az) => {
    setAzimuth(az);
    const ref = stateRef.current;
    if (!ref || ref.followBall) return;
    const azRad = az * Math.PI / 180;
    const camX = 0, camY = 1.8, camZ = -3;
    const tx = camX + Math.sin(azRad) * 120;   // positive az = right (+X in range)
    const ty = camY - 1.2;
    const tz = camZ + Math.cos(azRad) * 120;
    ref.camera.position.set(camX, camY, camZ);
    ref.camera.lookAt(tx, ty, tz);
    ref.controls.target.set(tx, ty, tz);
    ref.controls.update();
  }, []);

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------
  const panelStyle = {
    position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)",
    borderRadius: 12, padding: "12px 20px", color: "#fff",
    display: "flex", flexDirection: "column", gap: 10, minWidth: 340,
    fontSize: 13, userSelect: "none", zIndex: 10,
  };

  const btn = (color = "#2ecc71") => ({
    background: color, border: "none", borderRadius: 8,
    color: "#fff", padding: "8px 16px", cursor: "pointer",
    fontWeight: 700, fontSize: 13, fontFamily: "inherit",
  });

  const sliderRow = (label, val, min, max, step, setter, unit = "") => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 68, color: "#aaa" }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={e => setter(+e.target.value)} style={{ flex: 1 }} />
      <span style={{ width: 44, textAlign: "right" }}>{val}{unit}</span>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#000", display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "8px 16px",
        background: "rgba(0,0,0,0.85)", color: "#fff", flexShrink: 0, zIndex: 20, fontSize: 13,
      }}>
        <button onClick={onClose} style={{ ...btn("#e74c3c"), padding: "4px 10px", fontSize: 12 }}>← Home</button>
        <strong style={{ fontSize: 15, fontFamily: "Outfit, sans-serif", color: "#58a6ff" }}>DRIVING RANGE</strong>
        <span style={{ color: "#8b949e" }}>Shots: {shotCount}</span>
        {lastLanding && (
          <span style={{ color: "#f1c40f", marginLeft: "auto" }}>
            ⛳ {lastLanding.yds} yds ({lastLanding.x} m, {lastLanding.z} m)
          </span>
        )}
      </div>

      {/* Viewport */}
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />

      {/* Target buttons */}
      <div style={{
        position: "absolute", top: 56, left: "50%", transform: "translateX(-50%)",
        display: "flex", gap: 8, zIndex: 10,
      }}>
        {YARDAGES.map(yd => {
          const color = "#" + YARDAGE_COLORS[yd].toString(16).padStart(6, "0");
          const sel = selectedTarget === yd;
          return (
            <button key={yd} onClick={() => selectTarget(yd)} style={{
              background: sel ? color : "rgba(0,0,0,0.7)",
              border: `2px solid ${color}`,
              borderRadius: 6, color: sel ? "#000" : color,
              padding: "4px 12px", cursor: "pointer", fontWeight: 700, fontSize: 12,
            }}>
              {yd} yd
            </button>
          );
        })}
      </div>

      {/* Shot panel */}
      {status !== "flying" && (
        <div style={panelStyle}>
          {sliderRow("Ball Speed",  ballSpeed,    40, 220,   1,  setBallSpeed,   " mph")}
          {sliderRow("Launch",      launchAngle,   2,  55,   1,  setLaunchAngle, "°")}
          {sliderRow("Direction",   azimuth,      -45, 45,   1,  setAzimuth,     "°")}
          {sliderRow("Backspin",    backspinRpm,    0, 9000, 50, setBackspinRpm, " rpm")}
          {sliderRow("Side Spin",   sidespinRpm, -3000, 3000, 50, setSidespinRpm, " rpm")}
          <button style={btn()} onClick={launchBall}>
            🏌️ Hit ({(ballSpeed * 0.44704).toFixed(0)} m/s · {launchAngle}° · {azimuth > 0 ? azimuth + "°R" : azimuth < 0 ? Math.abs(azimuth) + "°L" : "Straight"})
          </button>
        </div>
      )}

      {status === "loading" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, pointerEvents: "none" }}>
          <div style={{ color: "#fff", fontSize: 18, fontFamily: "monospace" }}>Loading range…</div>
          <div style={{ color: "#58a6ff", fontSize: 14, fontFamily: "monospace", background: "rgba(0,0,0,0.6)", padding: "6px 16px", borderRadius: 6 }}>
            {loadingMsg}
          </div>
          <div style={{ width: 260, height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 4 }}>
            <div style={{
              height: "100%", borderRadius: 4, background: "#58a6ff",
              width: (() => {
                const m = loadingMsg.match(/(\d+)\s*\/\s*(\d+)/);
                if (m) return `${Math.round(+m[1] / +m[2] * 100)}%`;
                if (loadingMsg.includes("✓")) return "30%";
                return "5%";
              })(),
              transition: "width 0.3s ease",
            }} />
          </div>
        </div>
      )}

      {/* Minimap */}
      {status !== "loading" && (
        <Minimap
          stateRef={stateRef}
          teeXZ={RANGE_TEE_XZ}
          pinXZ={selectedTarget ? { x: 0, z: selectedTarget * YARDS_TO_M } : null}
          features={RANGE_FEATURES}
          targets={RANGE_TARGETS}
          worldBounds={RANGE_WORLD_BOUNDS}
          aimAzimuth={azimuth}
          onAimChange={handleAimChange}
        />
      )}
    </div>
  );
}

// Deterministic pseudo-random (mulberry32) for consistent tree layout across renders
function mulberry32(seed) {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
