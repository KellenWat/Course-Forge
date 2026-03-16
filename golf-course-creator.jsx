import { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const TOOL_MODES = {
  PAN: "pan",
  TEE: "tee",
  GREEN: "green",
  FAIRWAY: "fairway",
  BUNKER: "bunker",
  WATER: "water",
  PATH: "path",
};

const TOOL_COLORS = {
  [TOOL_MODES.TEE]: "#e74c3c",
  [TOOL_MODES.GREEN]: "#2ecc71",
  [TOOL_MODES.FAIRWAY]: "#7dcea0",
  [TOOL_MODES.BUNKER]: "#f0e68c",
  [TOOL_MODES.WATER]: "#3498db",
  [TOOL_MODES.PATH]: "#bdc3c7",
};

const TOOL_LABELS = {
  [TOOL_MODES.PAN]: "Pan / Select",
  [TOOL_MODES.TEE]: "Tee Box",
  [TOOL_MODES.GREEN]: "Green",
  [TOOL_MODES.FAIRWAY]: "Fairway",
  [TOOL_MODES.BUNKER]: "Bunker",
  [TOOL_MODES.WATER]: "Water Hazard",
  [TOOL_MODES.PATH]: "Cart Path",
};

const TOOL_ICONS = {
  [TOOL_MODES.PAN]: "↔",
  [TOOL_MODES.TEE]: "⏏",
  [TOOL_MODES.GREEN]: "⚑",
  [TOOL_MODES.FAIRWAY]: "▬",
  [TOOL_MODES.BUNKER]: "◌",
  [TOOL_MODES.WATER]: "〜",
  [TOOL_MODES.PATH]: "⋯",
};

const DEFAULT_COURSES = [
  { name: "Augusta National", lat: 33.503, lng: -82.022, zoom: 16 },
  { name: "Pebble Beach", lat: 36.567, lng: -121.948, zoom: 16 },
  { name: "St Andrews Old Course", lat: 56.343, lng: -2.802, zoom: 16 },
  { name: "TPC Sawgrass", lat: 30.198, lng: -81.394, zoom: 16 },
  { name: "Pinehurst No. 2", lat: 35.192, lng: -79.468, zoom: 16 },
];

function calcDistance(p1, p2) {
  const R = 6371000;
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((p1.lat * Math.PI) / 180) *
      Math.cos((p2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.09361;
}

// Elevation colour gradient: flat green → mid green → tan → light grey
function elevationColor(t) {
  const stops = [
    [0.00, 0.11, 0.30, 0.08],
    [0.25, 0.27, 0.50, 0.15],
    [0.50, 0.55, 0.70, 0.25],
    [0.75, 0.72, 0.58, 0.32],
    [1.00, 0.82, 0.80, 0.76],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (t <= t1) {
      const s = (t - t0) / (t1 - t0);
      return [r0 + s * (r1 - r0), g0 + s * (g1 - g0), b0 + s * (b1 - b0)];
    }
  }
  return [0.82, 0.80, 0.76];
}

function TerrainPreview({ objText, courseName, onClose }) {
  const mountRef = useRef(null);

  const download = () => {
    const blob = new Blob([objText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${courseName.replace(/\s+/g, "_").toLowerCase()}_terrain.obj`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!objText || !mountRef.current) return;
    const el = mountRef.current;
    const w = el.clientWidth;
    const h = el.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.setClearColor(0x0d1117);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 50000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const obj = new OBJLoader().parse(objText);

    // Compute Y range for colour mapping
    let minY = Infinity, maxY = -Infinity;
    obj.traverse(child => {
      if (!child.isMesh) return;
      const pos = child.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    });
    const yRange = maxY - minY || 1;

    // Apply vertex colours
    obj.traverse(child => {
      if (!child.isMesh) return;
      const pos = child.geometry.attributes.position;
      const colArr = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const [r, g, b] = elevationColor((pos.getY(i) - minY) / yRange);
        colArr[i * 3] = r; colArr[i * 3 + 1] = g; colArr[i * 3 + 2] = b;
      }
      child.geometry.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
      child.material = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 10 });
    });

    scene.add(obj);

    // Frame camera on mesh
    const box = new THREE.Box3().setFromObject(obj);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z);
    camera.position.set(centre.x, centre.y + span * 0.7, centre.z + span * 1.1);
    camera.lookAt(centre);
    controls.target.copy(centre);
    controls.update();

    let animId;
    const animate = () => { animId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); };
    animate();

    const onResize = () => {
      if (!el) return;
      const nw = el.clientWidth, nh = el.clientHeight;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, [objText]);

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 30,
      display: "flex", flexDirection: "column", background: "#0d1117",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 16px", background: "#161b22", borderBottom: "1px solid #30363d",
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: "Outfit", fontWeight: 700, fontSize: 15, color: "#e8e6e3" }}>
          ⛰ Terrain Preview
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={download} style={{
            background: "linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)",
            border: "none", borderRadius: 6, color: "#fff",
            padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
          }}>
            ↓ Download OBJ
          </button>
          <button onClick={onClose} style={{
            background: "#21262d", border: "1px solid #30363d", borderRadius: 6,
            color: "#c9d1d9", padding: "6px 10px", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
          }}>
            ✕ Close
          </button>
        </div>
      </div>
      <div style={{ flex: 1, fontSize: 11, color: "#8b949e", padding: "6px 16px", background: "#161b22", borderBottom: "1px solid #21262d", flexShrink: 0 }}>
        Drag to orbit · Scroll to zoom · Right-drag to pan
      </div>
      <div ref={mountRef} style={{ flex: 1 }} />
    </div>
  );
}

function MapCanvas({ center, zoom, markers, activeHole, tool, onMapClick, onMarkerClick, onMarkerDrag, onPolyNodeDrag, onRightClick, polygons, overlay, onOverlayMove }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ dragging: false, lastPos: null, offset: { x: 0, y: 0 } });
  const spaceRef = useRef(false); // spacebar held for temp pan
  const [tileImages, setTileImages] = useState({});
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const [viewState, setViewState] = useState({ center, zoom, offset: { x: 0, y: 0 } });
  // dragState: { kind:'marker', marker, pixel } | { kind:'poly', polyIndex, pointIndex, pixel }
  const [dragState, setDragState] = useState(null);

  useEffect(() => {
    setViewState(v => ({ ...v, center, zoom }));
  }, [center, zoom]);

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setCanvasSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Spacebar = temporary pan while using any drawing tool
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === "Space" && !e.repeat && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
        e.preventDefault();
        spaceRef.current = true;
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") {
        spaceRef.current = false;
        if (canvasRef.current) canvasRef.current.style.cursor = tool === TOOL_MODES.PAN ? "grab" : "crosshair";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [tool]);

  const latlngToPixel = useCallback((lat, lng, cs, z, off) => {
    const scale = Math.pow(2, z) * 256;
    const cx = ((cs.lng + 180) / 360) * scale;
    const cy = ((1 - Math.log(Math.tan((cs.lat * Math.PI) / 180) + 1 / Math.cos((cs.lat * Math.PI) / 180)) / Math.PI) / 2) * scale;
    const px = ((lng + 180) / 360) * scale;
    const py = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * scale;
    return {
      x: canvasSize.w / 2 + (px - cx) + off.x,
      y: canvasSize.h / 2 + (py - cy) + off.y,
    };
  }, [canvasSize]);

  const pixelToLatLng = useCallback((x, y, cs, z, off) => {
    const scale = Math.pow(2, z) * 256;
    const cx = ((cs.lng + 180) / 360) * scale;
    const cy = ((1 - Math.log(Math.tan((cs.lat * Math.PI) / 180) + 1 / Math.cos((cs.lat * Math.PI) / 180)) / Math.PI) / 2) * scale;
    const worldX = cx + (x - canvasSize.w / 2) - off.x;
    const worldY = cy + (y - canvasSize.h / 2) - off.y;
    const lng = (worldX / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * worldY) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }, [canvasSize]);

  // Load tiles
  useEffect(() => {
    const z = viewState.zoom;
    const scale = Math.pow(2, z) * 256;
    const cx = ((viewState.center.lng + 180) / 360) * scale;
    const cy = ((1 - Math.log(Math.tan((viewState.center.lat * Math.PI) / 180) + 1 / Math.cos((viewState.center.lat * Math.PI) / 180)) / Math.PI) / 2) * scale;

    const tileSize = 256;
    const startTileX = Math.floor((cx - canvasSize.w / 2 - viewState.offset.x) / tileSize);
    const endTileX = Math.ceil((cx + canvasSize.w / 2 - viewState.offset.x) / tileSize);
    const startTileY = Math.floor((cy - canvasSize.h / 2 - viewState.offset.y) / tileSize);
    const endTileY = Math.ceil((cy + canvasSize.h / 2 - viewState.offset.y) / tileSize);

    const newTiles = {};
    for (let tx = startTileX; tx <= endTileX; tx++) {
      for (let ty = startTileY; ty <= endTileY; ty++) {
        if (ty < 0 || ty >= Math.pow(2, z)) continue;
        const wrappedTx = ((tx % Math.pow(2, z)) + Math.pow(2, z)) % Math.pow(2, z);
        const key = `${z}/${wrappedTx}/${ty}`;
        if (tileImages[key]) {
          newTiles[key] = tileImages[key];
        } else {
          const img = new Image();
          // Use local Vite proxy → ArcGIS World Imagery satellite tiles (avoids CORS)
          img.src = `/tiles/${z}/${ty}/${wrappedTx}`;
          img.onload = () => {
            setTileImages(prev => ({ ...prev, [key]: { img, tx, ty, z: z } }));
          };
          img.onerror = () => {
            // Direct fallback if proxy is unavailable
            const img2 = new Image();
            img2.crossOrigin = "anonymous";
            img2.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${wrappedTx}`;
            img2.onload = () => {
              setTileImages(prev => ({ ...prev, [key]: { img: img2, tx, ty, z: z } }));
            };
          };
        }
      }
    }
  }, [viewState, canvasSize]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = canvasSize.w;
    canvas.height = canvasSize.h;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#1a2332";
    ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);

    const z = viewState.zoom;
    const scale = Math.pow(2, z) * 256;
    const cx = ((viewState.center.lng + 180) / 360) * scale;
    const cy = ((1 - Math.log(Math.tan((viewState.center.lat * Math.PI) / 180) + 1 / Math.cos((viewState.center.lat * Math.PI) / 180)) / Math.PI) / 2) * scale;

    Object.values(tileImages).forEach(({ img, tx, ty, z: tz }) => {
      if (tz !== z) return;
      const px = tx * 256 - cx + canvasSize.w / 2 + viewState.offset.x;
      const py = ty * 256 - cy + canvasSize.h / 2 + viewState.offset.y;
      ctx.drawImage(img, px, py, 256, 256);
    });

    // Draw course map overlay
    if (overlay?.img?.complete) {
      const metersPerCanvasPx = (2 * Math.PI * 6371000) / (Math.pow(2, z) * 256);
      const imgScale = (overlay.baseMetersPerImagePx * overlay.scale) / metersPerCanvasPx;
      const cp = latlngToPixel(overlay.centerLat, overlay.centerLng, viewState.center, viewState.zoom, viewState.offset);
      ctx.save();
      ctx.globalAlpha = overlay.opacity;
      ctx.translate(cp.x, cp.y);
      ctx.rotate((overlay.rotation * Math.PI) / 180);
      ctx.drawImage(
        overlay.img,
        -overlay.img.naturalWidth * imgScale / 2,
        -overlay.img.naturalHeight * imgScale / 2,
        overlay.img.naturalWidth * imgScale,
        overlay.img.naturalHeight * imgScale
      );
      ctx.restore();
    }

    // Draw polygons (fairways, bunkers, water)
    polygons.forEach((poly, pi) => {
      if (poly.points.length < 2) return;
      ctx.beginPath();
      const pts = poly.points.map((p, ni) => {
        if (dragState?.kind === "poly" && dragState.polyIndex === pi && dragState.pointIndex === ni) {
          return dragState.pixel;
        }
        return latlngToPixel(p.lat, p.lng, viewState.center, viewState.zoom, viewState.offset);
      });
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      if (poly.closed) ctx.closePath();
      const color = TOOL_COLORS[poly.type] || "#fff";
      ctx.fillStyle = color + "44";
      ctx.fill();
      ctx.strokeStyle = color + "cc";
      ctx.lineWidth = 2;
      ctx.stroke();

      pts.forEach((p, ni) => {
        const isBeingDragged = dragState?.kind === "poly" && dragState.polyIndex === pi && dragState.pointIndex === ni;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isBeingDragged ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isBeingDragged ? "#fff" : color;
        ctx.fill();
        if (isBeingDragged) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      });
    });

    // Draw markers (tees, greens)
    markers.forEach((m, i) => {
      const isDragged = dragState?.kind === "marker" && dragState.marker.hole === m.hole && dragState.marker.type === m.type;
      const p = isDragged
        ? dragState.pixel
        : latlngToPixel(m.lat, m.lng, viewState.center, viewState.zoom, viewState.offset);
      const isActive = m.hole === activeHole;
      const r = isActive ? 12 : 9;
      const color = TOOL_COLORS[m.type] || "#fff";

      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = isActive ? 3 : 2;
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.font = `bold ${isActive ? 11 : 9}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(m.label || m.hole, p.x, p.y);

      if (isActive) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = color + "88";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // Draw lines between tee and green for each hole
    const holeNums = [...new Set(markers.map(m => m.hole))];
    holeNums.forEach(h => {
      const tee = markers.find(m => m.hole === h && m.type === TOOL_MODES.TEE);
      const green = markers.find(m => m.hole === h && m.type === TOOL_MODES.GREEN);
      if (tee && green) {
        const teeDragged = dragState && dragState.marker.hole === h && dragState.marker.type === TOOL_MODES.TEE;
        const greenDragged = dragState && dragState.marker.hole === h && dragState.marker.type === TOOL_MODES.GREEN;
        const p1 = teeDragged ? dragState.pixel : latlngToPixel(tee.lat, tee.lng, viewState.center, viewState.zoom, viewState.offset);
        const p2 = greenDragged ? dragState.pixel : latlngToPixel(green.lat, green.lng, viewState.center, viewState.zoom, viewState.offset);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = h === activeHole ? "#fff" : "rgba(255,255,255,0.3)";
        ctx.lineWidth = h === activeHole ? 2 : 1;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        const dist = calcDistance(tee, green);
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(mx - 30, my - 10, 60, 20);
        ctx.fillStyle = "#f1c40f";
        ctx.font = "bold 11px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${Math.round(dist)}y`, mx, my);
      }
    });

    // Crosshair
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(canvasSize.w / 2, 0);
    ctx.lineTo(canvasSize.w / 2, canvasSize.h);
    ctx.moveTo(0, canvasSize.h / 2);
    ctx.lineTo(canvasSize.w, canvasSize.h / 2);
    ctx.stroke();
  }, [viewState, tileImages, markers, activeHole, canvasSize, polygons, latlngToPixel, dragState, overlay]);

  const wheelAccum = useRef(0);
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    // Normalise delta across trackpad vs mouse wheel
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
    wheelAccum.current += delta;
    const STEP = 180; // pixels of scroll per zoom level
    if (Math.abs(wheelAccum.current) >= STEP) {
      const steps = Math.trunc(wheelAccum.current / STEP);
      wheelAccum.current -= steps * STEP;
      setViewState(v => ({
        ...v,
        zoom: Math.max(12, Math.min(20, v.zoom - steps)),
        offset: { x: 0, y: 0 },
      }));
    }
  }, []);

  const findMarkerAt = useCallback((x, y) => {
    return markers.find(m => {
      const p = latlngToPixel(m.lat, m.lng, viewState.center, viewState.zoom, viewState.offset);
      return Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2) <= 14;
    });
  }, [markers, latlngToPixel, viewState]);

  const findPolyNodeAt = useCallback((x, y) => {
    for (let pi = 0; pi < polygons.length; pi++) {
      const poly = polygons[pi];
      for (let ni = 0; ni < poly.points.length; ni++) {
        const p = latlngToPixel(poly.points[ni].lat, poly.points[ni].lng, viewState.center, viewState.zoom, viewState.offset);
        if (Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2) <= 10) {
          return { polyIndex: pi, pointIndex: ni };
        }
      }
    }
    return null;
  }, [polygons, latlngToPixel, viewState]);

  const isOnOverlay = useCallback((x, y) => {
    if (!overlay?.img?.complete || overlay.locked) return false;
    const metersPerCanvasPx = (2 * Math.PI * 6371000) / (Math.pow(2, viewState.zoom) * 256);
    const cp = latlngToPixel(overlay.centerLat, overlay.centerLng, viewState.center, viewState.zoom, viewState.offset);
    const imgScale = (overlay.baseMetersPerImagePx * overlay.scale) / metersPerCanvasPx;
    const hw = overlay.img.naturalWidth * imgScale / 2;
    const hh = overlay.img.naturalHeight * imgScale / 2;
    // Rotate click point back by negative rotation for correct hit detection
    const angle = -(overlay.rotation * Math.PI) / 180;
    const dx = x - cp.x;
    const dy = y - cp.y;
    const rotX = dx * Math.cos(angle) - dy * Math.sin(angle);
    const rotY = dx * Math.sin(angle) + dy * Math.cos(angle);
    return Math.abs(rotX) <= hw && Math.abs(rotY) <= hh;
  }, [overlay, viewState, latlngToPixel]);

  const handleMouseDown = useCallback((e) => {
    if (e.button === 2) return; // right-click handled by onContextMenu
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const isPanGesture = tool === TOOL_MODES.PAN || e.button === 1 || spaceRef.current;

    const hitMarker = findMarkerAt(x, y);
    if (hitMarker && !spaceRef.current) {
      stateRef.current = { kind: "marker", draggingMarker: hitMarker, lastPos: { x: e.clientX, y: e.clientY }, moved: false };
      return;
    }

    const hitNode = !spaceRef.current ? findPolyNodeAt(x, y) : null;
    if (hitNode) {
      stateRef.current = { kind: "poly", ...hitNode, lastPos: { x: e.clientX, y: e.clientY }, moved: false };
      return;
    }

    const hitOverlay = !spaceRef.current && !isPanGesture ? false : false; // overlay drag only in pan mode or explicit
    if (!spaceRef.current && overlay && isOnOverlay(x, y) && (tool === TOOL_MODES.PAN || e.button === 1)) {
      const cp = latlngToPixel(overlay.centerLat, overlay.centerLng, viewState.center, viewState.zoom, viewState.offset);
      stateRef.current = { kind: "overlay", dragStart: { x, y }, origCenterPx: { x: cp.x, y: cp.y }, moved: false };
      return;
    }

    if (isPanGesture) {
      stateRef.current = { kind: "pan", dragging: true, lastPos: { x: e.clientX, y: e.clientY }, offset: { ...viewState.offset }, moved: false };
    } else {
      stateRef.current = { kind: "draw", clickPos: { x, y } };
    }
  }, [tool, viewState, findMarkerAt, findPolyNodeAt, isOnOverlay, overlay, latlngToPixel]);

  const handleMouseMove = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { kind } = stateRef.current;

    if (kind === "marker") {
      const dx = e.clientX - stateRef.current.lastPos.x;
      const dy = e.clientY - stateRef.current.lastPos.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) stateRef.current.moved = true;
      setDragState({ kind: "marker", marker: stateRef.current.draggingMarker, pixel: { x, y } });
      canvasRef.current.style.cursor = "grabbing";
    } else if (kind === "poly") {
      const dx = e.clientX - stateRef.current.lastPos.x;
      const dy = e.clientY - stateRef.current.lastPos.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) stateRef.current.moved = true;
      setDragState({ kind: "poly", polyIndex: stateRef.current.polyIndex, pointIndex: stateRef.current.pointIndex, pixel: { x, y } });
      canvasRef.current.style.cursor = "grabbing";
    } else if (kind === "overlay") {
      stateRef.current.moved = true;
      const newCenterPx = {
        x: stateRef.current.origCenterPx.x + (x - stateRef.current.dragStart.x),
        y: stateRef.current.origCenterPx.y + (y - stateRef.current.dragStart.y),
      };
      const newCenter = pixelToLatLng(newCenterPx.x, newCenterPx.y, viewState.center, viewState.zoom, viewState.offset);
      onOverlayMove?.(newCenter.lat, newCenter.lng);
      canvasRef.current.style.cursor = "grabbing";
    } else if (kind === "pan") {
      const dx = e.clientX - stateRef.current.lastPos.x;
      const dy = e.clientY - stateRef.current.lastPos.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) stateRef.current.moved = true;
      setViewState(v => ({
        ...v,
        offset: { x: stateRef.current.offset.x + dx, y: stateRef.current.offset.y + dy },
      }));
      canvasRef.current.style.cursor = "grabbing";
    } else {
      // Hover: show grab cursor over draggable nodes or overlay
      const hitMarker = findMarkerAt(x, y);
      const hitNode = !hitMarker ? findPolyNodeAt(x, y) : null;
      const hitOvl = !hitMarker && !hitNode && tool === TOOL_MODES.PAN ? isOnOverlay(x, y) : false;
      if (spaceRef.current) {
        canvasRef.current.style.cursor = "grab";
      } else if (hitMarker || hitNode || hitOvl) {
        canvasRef.current.style.cursor = "grab";
      } else {
        canvasRef.current.style.cursor = tool === TOOL_MODES.PAN ? "grab" : "crosshair";
      }
    }
  }, [tool, findMarkerAt, findPolyNodeAt, isOnOverlay, viewState, onOverlayMove, pixelToLatLng]);

  const handleMouseUp = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { kind } = stateRef.current;

    if (kind === "marker") {
      if (stateRef.current.moved) {
        const newLatLng = pixelToLatLng(x, y, viewState.center, viewState.zoom, viewState.offset);
        onMarkerDrag?.(stateRef.current.draggingMarker, newLatLng);
      }
      setDragState(null);
    } else if (kind === "poly") {
      if (stateRef.current.moved) {
        const newLatLng = pixelToLatLng(x, y, viewState.center, viewState.zoom, viewState.offset);
        onPolyNodeDrag?.(stateRef.current.polyIndex, stateRef.current.pointIndex, newLatLng);
      }
      setDragState(null);
    } else if (kind === "overlay") {
      // move committed live — nothing extra needed
    } else if (kind === "pan") {
      if (stateRef.current.moved) {
        const newCenter = pixelToLatLng(canvasSize.w / 2, canvasSize.h / 2, viewState.center, viewState.zoom, viewState.offset);
        setViewState(v => ({ ...v, center: newCenter, offset: { x: 0, y: 0 } }));
      } else {
        // Stationary click in pan mode — select hole by nearest marker
        const ll = pixelToLatLng(x, y, viewState.center, viewState.zoom, viewState.offset);
        onMarkerClick?.(ll);
      }
    } else if (kind === "draw") {
      const ll = pixelToLatLng(x, y, viewState.center, viewState.zoom, viewState.offset);
      onMapClick?.(ll);
    }
    stateRef.current = { kind: null };
    // Restore cursor after space-pan
    if (spaceRef.current && canvasRef.current) canvasRef.current.style.cursor = "grab";
  }, [viewState, canvasSize, tool, onMapClick, onMarkerClick, onMarkerDrag, onPolyNodeDrag, pixelToLatLng]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", cursor: tool === TOOL_MODES.PAN ? "grab" : "crosshair", display: "block" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={e => { e.preventDefault(); onRightClick?.(); }}
    />
  );
}

export default function GolfCourseCreator() {
  const [courseName, setCourseName] = useState("New Course");
  const [center, setCenter] = useState({ lat: 33.503, lng: -82.022 });
  const [zoom, setZoom] = useState(16);
  const [tool, setTool] = useState(TOOL_MODES.PAN);
  const [activeHole, setActiveHole] = useState(1);
  const [holes, setHoles] = useState(
    Array.from({ length: 18 }, (_, i) => ({
      number: i + 1,
      par: 4,
      yardage: 0,
      handicap: i + 1,
      notes: "",
    }))
  );
  const [markers, setMarkers] = useState([]);
  const [polygons, setPolygons] = useState([]);
  const [activePolygon, setActivePolygon] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showHolePanel, setShowHolePanel] = useState(true);
  const [notification, setNotification] = useState(null);
  const [osmQuery, setOsmQuery] = useState("");
  const [osmResults, setOsmResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchDebounceRef = useRef(null);
  const [overlay, setOverlay] = useState(null);
  // overlay: { img, centerLat, centerLng, baseMetersPerImagePx, scale, rotation, opacity }
  const fileInputRef = useRef(null);
  const [terrainLoading, setTerrainLoading] = useState(false);
  const [terrainObjText, setTerrainObjText] = useState(null);

  const notify = (msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const handleMapClick = useCallback((latlng) => {
    if (tool === TOOL_MODES.TEE || tool === TOOL_MODES.GREEN) {
      setMarkers(prev => {
        const filtered = prev.filter(m => !(m.hole === activeHole && m.type === tool));
        return [
          ...filtered,
          {
            lat: latlng.lat,
            lng: latlng.lng,
            type: tool,
            hole: activeHole,
            label: `${activeHole}`,
          },
        ];
      });

      // Compute yardage if both tee and green exist
      setTimeout(() => {
        setMarkers(curr => {
          const tee = curr.find(m => m.hole === activeHole && m.type === TOOL_MODES.TEE);
          const green = curr.find(m => m.hole === activeHole && m.type === TOOL_MODES.GREEN);
          if (tee && green) {
            const dist = Math.round(calcDistance(tee, green));
            setHoles(h =>
              h.map(hole => (hole.number === activeHole ? { ...hole, yardage: dist } : hole))
            );
            notify(`Hole ${activeHole}: ${dist} yards`);
          }
          return curr;
        });
      }, 50);
    } else if ([TOOL_MODES.FAIRWAY, TOOL_MODES.BUNKER, TOOL_MODES.WATER, TOOL_MODES.PATH].includes(tool)) {
      if (activePolygon !== null) {
        setPolygons(prev =>
          prev.map((p, i) =>
            i === activePolygon ? { ...p, points: [...p.points, latlng] } : p
          )
        );
      } else {
        setPolygons(prev => [...prev, { type: tool, hole: activeHole, points: [latlng], closed: tool !== TOOL_MODES.PATH }]);
        setActivePolygon(polygons.length);
      }
    }
  }, [tool, activeHole, activePolygon, polygons.length]);

  const handleMarkerClick = useCallback((latlng) => {
    let minDist = Infinity;
    let nearest = null;
    markers.forEach(m => {
      const d = Math.sqrt((m.lat - latlng.lat) ** 2 + (m.lng - latlng.lng) ** 2);
      if (d < minDist) { minDist = d; nearest = m; }
    });
    if (nearest && minDist < 0.001) {
      setActiveHole(nearest.hole);
    }
  }, [markers]);

  const handleMarkerDrag = useCallback((marker, newLatLng) => {
    setMarkers(prev =>
      prev.map(m =>
        m.hole === marker.hole && m.type === marker.type
          ? { ...m, lat: newLatLng.lat, lng: newLatLng.lng }
          : m
      )
    );
    // Recalculate yardage for affected hole
    setMarkers(curr => {
      const tee = curr.find(m => m.hole === marker.hole && m.type === TOOL_MODES.TEE);
      const green = curr.find(m => m.hole === marker.hole && m.type === TOOL_MODES.GREEN);
      if (tee && green) {
        const dist = Math.round(calcDistance(tee, green));
        setHoles(h =>
          h.map(hole => hole.number === marker.hole ? { ...hole, yardage: dist } : hole)
        );
      }
      return curr;
    });
  }, []);

  const handlePolyNodeDrag = useCallback((polyIndex, pointIndex, newLatLng) => {
    setPolygons(prev =>
      prev.map((poly, pi) =>
        pi !== polyIndex ? poly : {
          ...poly,
          points: poly.points.map((pt, ni) => ni === pointIndex ? newLatLng : pt),
        }
      )
    );
  }, []);

  const loadOverlayImage = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setOverlay({
        img,
        centerLat: center.lat,
        centerLng: center.lng,
        // Assume course is ~1.5 km wide as a starting point
        baseMetersPerImagePx: 1500 / img.naturalWidth,
        scale: 1,
        rotation: 0,
        opacity: 0.55,
        locked: false,
      });
      notify("Course map loaded — drag to position, use controls to scale and rotate");
    };
    img.src = url;
  };

  const handleOverlayMove = useCallback((lat, lng) => {
    setOverlay(prev => prev ? { ...prev, centerLat: lat, centerLng: lng } : prev);
  }, []);

  const handleRightClick = useCallback(() => {
    setTool(TOOL_MODES.PAN);
    setActivePolygon(null);
  }, []);

  const finishPolygon = () => {
    setActivePolygon(null);
    notify("Shape completed");
  };

  const undoLastPoint = () => {
    if (activePolygon !== null) {
      setPolygons(prev =>
        prev.map((p, i) =>
          i === activePolygon ? { ...p, points: p.points.slice(0, -1) } : p
        ).filter(p => p.points.length > 0)
      );
    }
  };

  const deleteHoleFeatures = (holeNum) => {
    setMarkers(prev => prev.filter(m => m.hole !== holeNum));
    setPolygons(prev => prev.filter(p => p.hole !== holeNum));
    setHoles(h => h.map(hole => hole.number === holeNum ? { ...hole, yardage: 0 } : hole));
    notify(`Hole ${holeNum} cleared`);
  };

  const updateHole = (num, field, value) => {
    setHoles(h => h.map(hole => hole.number === num ? { ...hole, [field]: value } : hole));
  };

  const totalYardage = holes.reduce((s, h) => s + h.yardage, 0);
  const totalPar = holes.reduce((s, h) => s + h.par, 0);
  const frontNine = holes.filter(h => h.number <= 9);
  const backNine = holes.filter(h => h.number > 9);

  const exportData = () => {
    const data = {
      name: courseName,
      totalPar,
      totalYardage,
      holes: holes.map(h => ({
        ...h,
        tee: markers.find(m => m.hole === h.number && m.type === TOOL_MODES.TEE) || null,
        green: markers.find(m => m.hole === h.number && m.type === TOOL_MODES.GREEN) || null,
        features: polygons.filter(p => p.hole === h.number),
      })),
      metadata: {
        exportedAt: new Date().toISOString(),
        version: "1.0.0",
        format: "golf-course-sim",
      },
    };
    return JSON.stringify(data, null, 2);
  };

  const handleExport = () => {
    const json = exportData();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${courseName.replace(/\s+/g, "_").toLowerCase()}_course.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Course exported!");
  };

  const handleExportTerrain = async () => {
    // Build bounding box from all placed markers and polygon points
    const lats = [];
    const lngs = [];
    markers.forEach(m => { lats.push(m.lat); lngs.push(m.lng); });
    polygons.forEach(p => p.points.forEach(pt => { lats.push(pt.lat); lngs.push(pt.lng); }));

    let bounds;
    if (lats.length > 0) {
      const pad = 0.001; // ~100 m padding around mapped features
      bounds = {
        north: Math.max(...lats) + pad,
        south: Math.min(...lats) - pad,
        east:  Math.max(...lngs) + pad,
        west:  Math.min(...lngs) - pad,
      };
    } else {
      // Fall back to a ~3 km box around the current map centre
      bounds = {
        north: center.lat + 0.015,
        south: center.lat - 0.015,
        east:  center.lng + 0.02,
        west:  center.lng - 0.02,
      };
    }

    setTerrainLoading(true);
    try {
      const r = await fetch("/api/terrain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bounds, resolution: 128, courseName }),
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Terrain generation failed");
      }
      const text = await r.text();
      setTerrainObjText(text);
      notify("Terrain ready!");
    } catch (err) {
      notify(`Terrain error: ${err.message}`);
    } finally {
      setTerrainLoading(false);
    }
  };

  const handleCourseSelect = (course) => {
    setCenter({ lat: course.lat, lng: course.lng });
    setZoom(course.zoom || 17);
    setCourseName(course.name);
    setShowSearch(false);
    setOsmResults([]);
    setOsmQuery("");
    notify(`Navigated to ${course.name}`);
  };

  const doSearch = async (query) => {
    if (!query.trim()) return;
    setIsSearching(true);
    setOsmResults([]);
    setShowDropdown(true);
    try {
      const params = new URLSearchParams({
        q: query + " golf course",
        format: "json",
        limit: "12",
        addressdetails: "1",
        "accept-language": "en",
      });
      const res = await fetch(`/nominatim/search?${params}`);
      if (!res.ok) throw new Error("Search request failed");
      const data = await res.json();
      const results = data
        .filter(r => r.lat && r.lon)
        .map(r => {
          const parts = r.display_name.split(",");
          return {
            name: parts[0].trim(),
            address: parts.slice(1, 3).join(",").trim(),
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            zoom: 17,
          };
        });
      setOsmResults(results);
      if (results.length === 0) notify("No courses found — try a different name");
    } catch {
      notify("Search failed — check your connection");
    } finally {
      setIsSearching(false);
    }
  };

  const searchOSM = (e) => {
    e?.preventDefault();
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    doSearch(osmQuery);
  };

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (osmQuery.trim().length < 3) {
      setOsmResults([]);
      setShowDropdown(false);
      return;
    }
    searchDebounceRef.current = setTimeout(() => doSearch(osmQuery), 350);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [osmQuery]);

  const holeData = holes.find(h => h.number === activeHole);
  const hasTee = markers.some(m => m.hole === activeHole && m.type === TOOL_MODES.TEE);
  const hasGreen = markers.some(m => m.hole === activeHole && m.type === TOOL_MODES.GREEN);

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "#0c1117",
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      color: "#e8e6e3",
      overflow: "hidden",
      position: "relative",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Outfit:wght@300;400;600;700;800&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        height: 52,
        background: "linear-gradient(180deg, #161b22 0%, #0d1117 100%)",
        borderBottom: "1px solid #21262d",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 12,
        flexShrink: 0,
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 20 }}>⛳</span>
          <span style={{ fontFamily: "Outfit", fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em", color: "#58a6ff" }}>
            COURSE FORGE
          </span>
        </div>

        <div style={{
          background: "#0d1117",
          border: "1px solid #30363d",
          borderRadius: 6,
          padding: "4px 10px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginLeft: 8,
        }}>
          <input
            value={courseName}
            onChange={e => setCourseName(e.target.value)}
            style={{
              background: "transparent",
              border: "none",
              color: "#e8e6e3",
              fontFamily: "Outfit",
              fontWeight: 600,
              fontSize: 14,
              outline: "none",
              width: 180,
            }}
          />
          <span style={{ color: "#484f58", fontSize: 11 }}>✎</span>
        </div>

        <button
          onClick={() => setShowSearch(!showSearch)}
          style={{
            background: "#21262d",
            border: "1px solid #30363d",
            borderRadius: 6,
            color: "#c9d1d9",
            padding: "5px 12px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          🔍 Load Course
        </button>

        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={e => { if (e.target.files[0]) { loadOverlayImage(e.target.files[0]); e.target.value = ""; } }} />
        <button
          onClick={() => fileInputRef.current.click()}
          style={{
            background: "#21262d",
            border: "1px solid #30363d",
            borderRadius: 6,
            color: "#c9d1d9",
            padding: "5px 12px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          🗺 Import Map
        </button>

        <div style={{ flex: 1 }} />

        <div style={{
          display: "flex",
          gap: 16,
          fontSize: 12,
          color: "#8b949e",
          alignItems: "center",
        }}>
          <span>PAR <b style={{ color: "#58a6ff" }}>{totalPar}</b></span>
          <span style={{ color: "#30363d" }}>|</span>
          <span>YDS <b style={{ color: "#f0e68c" }}>{totalYardage.toLocaleString()}</b></span>
          <span style={{ color: "#30363d" }}>|</span>
          <span>HOLES <b style={{ color: "#2ecc71" }}>{markers.filter(m => m.type === TOOL_MODES.TEE).length}</b>/18</span>
        </div>

        <button
          onClick={handleExport}
          style={{
            background: "linear-gradient(135deg, #238636 0%, #2ea043 100%)",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            padding: "6px 16px",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
          }}
        >
          ↓ Export JSON
        </button>
        <button
          onClick={handleExportTerrain}
          disabled={terrainLoading}
          style={{
            background: terrainLoading
              ? "#21262d"
              : "linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)",
            border: "none",
            borderRadius: 6,
            color: terrainLoading ? "#8b949e" : "#fff",
            padding: "6px 16px",
            cursor: terrainLoading ? "default" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
          }}
        >
          {terrainLoading ? "⏳ Fetching…" : "⛰ Export OBJ"}
        </button>
        <button
          onClick={() => setShowExport(!showExport)}
          style={{
            background: "#21262d",
            border: "1px solid #30363d",
            borderRadius: 6,
            color: "#c9d1d9",
            padding: "5px 10px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "inherit",
          }}
        >
          { } Preview
        </button>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {/* Left toolbar */}
        <div style={{
          width: 56,
          background: "#161b22",
          borderRight: "1px solid #21262d",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "8px 0",
          gap: 4,
          flexShrink: 0,
        }}>
          {Object.entries(TOOL_MODES).map(([key, mode]) => (
            <button
              key={mode}
              onClick={() => {
                setTool(mode);
                if (activePolygon !== null && ![TOOL_MODES.FAIRWAY, TOOL_MODES.BUNKER, TOOL_MODES.WATER, TOOL_MODES.PATH].includes(mode)) {
                  finishPolygon();
                }
              }}
              title={TOOL_LABELS[mode]}
              style={{
                width: 40,
                height: 40,
                border: tool === mode ? "2px solid #58a6ff" : "1px solid transparent",
                borderRadius: 8,
                background: tool === mode ? "#1f2937" : "transparent",
                color: tool === mode ? (TOOL_COLORS[mode] || "#58a6ff") : "#8b949e",
                cursor: "pointer",
                fontSize: 18,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s",
              }}
            >
              {TOOL_ICONS[mode]}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {activePolygon !== null && (
            <>
              <button
                onClick={undoLastPoint}
                title="Undo last point"
                style={{
                  width: 40, height: 32, border: "1px solid #30363d", borderRadius: 6,
                  background: "#21262d", color: "#f85149", cursor: "pointer", fontSize: 14,
                }}
              >↩</button>
              <button
                onClick={finishPolygon}
                title="Finish shape"
                style={{
                  width: 40, height: 32, border: "1px solid #238636", borderRadius: 6,
                  background: "#238636", color: "#fff", cursor: "pointer", fontSize: 14,
                  fontWeight: 700,
                }}
              >✓</button>
            </>
          )}
        </div>

        {/* Map */}
        <div style={{ flex: 1, position: "relative" }}>
          <MapCanvas
            center={center}
            zoom={zoom}
            markers={markers}
            polygons={polygons}
            activeHole={activeHole}
            tool={tool}
            onMapClick={handleMapClick}
            onMarkerClick={handleMarkerClick}
            onMarkerDrag={handleMarkerDrag}
            onPolyNodeDrag={handlePolyNodeDrag}
            onRightClick={handleRightClick}
            overlay={overlay}
            onOverlayMove={handleOverlayMove}
          />

          {/* Tool info overlay */}
          <div style={{
            position: "absolute",
            top: 12,
            left: 12,
            background: "rgba(13,17,23,0.9)",
            backdropFilter: "blur(8px)",
            border: "1px solid #21262d",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span style={{ color: TOOL_COLORS[tool] || "#58a6ff", fontSize: 16 }}>{TOOL_ICONS[tool]}</span>
            <span style={{ color: "#c9d1d9" }}>{TOOL_LABELS[tool]}</span>
            <span style={{ color: "#484f58" }}>•</span>
            <span style={{ color: "#8b949e" }}>
              Hole {activeHole}
              {tool === TOOL_MODES.TEE && " — Click to place tee"}
              {tool === TOOL_MODES.GREEN && " — Click to place green"}
              {[TOOL_MODES.FAIRWAY, TOOL_MODES.BUNKER, TOOL_MODES.WATER, TOOL_MODES.PATH].includes(tool) && (activePolygon !== null ? " — Click to add points · Hold Space to pan · ✓ to finish" : " — Click to start drawing · Hold Space to pan")}
              {tool === TOOL_MODES.PAN && " — Drag to pan · Scroll to zoom · Drag nodes to move"}
            </span>
          </div>

          {/* Zoom controls */}
          <div style={{
            position: "absolute",
            bottom: 16,
            right: showHolePanel ? 340 : 16,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            transition: "right 0.2s",
          }}>
            <button onClick={() => setZoom(z => Math.min(20, z + 1))} style={{
              width: 36, height: 36, background: "rgba(22,27,34,0.9)", border: "1px solid #30363d",
              borderRadius: "6px 6px 0 0", color: "#c9d1d9", cursor: "pointer", fontSize: 18,
            }}>+</button>
            <button onClick={() => setZoom(z => Math.max(12, z - 1))} style={{
              width: 36, height: 36, background: "rgba(22,27,34,0.9)", border: "1px solid #30363d",
              borderRadius: "0 0 6px 6px", color: "#c9d1d9", cursor: "pointer", fontSize: 18,
            }}>−</button>
          </div>

          {/* Notification */}
          {notification && (
            <div style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(35,134,54,0.95)",
              color: "#fff",
              padding: "8px 20px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              animation: "fadeIn 0.2s ease",
            }}>
              {notification}
            </div>
          )}
        </div>

        {/* Right panel — Hole editor */}
        <div style={{
          width: showHolePanel ? 320 : 0,
          overflow: "hidden",
          background: "#161b22",
          borderLeft: showHolePanel ? "1px solid #21262d" : "none",
          transition: "width 0.2s",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
        }}>
          {/* Toggle */}
          <button
            onClick={() => setShowHolePanel(!showHolePanel)}
            style={{
              position: "absolute",
              right: showHolePanel ? 320 : 0,
              top: "50%",
              transform: "translateY(-50%)",
              width: 20,
              height: 60,
              background: "#21262d",
              border: "1px solid #30363d",
              borderRight: "none",
              borderRadius: "6px 0 0 6px",
              color: "#8b949e",
              cursor: "pointer",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 5,
              transition: "right 0.2s",
            }}
          >{showHolePanel ? "›" : "‹"}</button>

          {showHolePanel && (
            <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>
              {/* Hole selector */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  SELECT HOLE
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: 3 }}>
                  {holes.map(h => {
                    const hasT = markers.some(m => m.hole === h.number && m.type === TOOL_MODES.TEE);
                    const hasG = markers.some(m => m.hole === h.number && m.type === TOOL_MODES.GREEN);
                    const isComplete = hasT && hasG;
                    return (
                      <button
                        key={h.number}
                        onClick={() => setActiveHole(h.number)}
                        style={{
                          width: "100%",
                          aspectRatio: "1",
                          border: activeHole === h.number ? "2px solid #58a6ff" : "1px solid #30363d",
                          borderRadius: 4,
                          background: isComplete
                            ? "rgba(46,160,67,0.2)"
                            : activeHole === h.number
                              ? "#1f2937"
                              : "#0d1117",
                          color: isComplete ? "#2ecc71" : activeHole === h.number ? "#58a6ff" : "#8b949e",
                          cursor: "pointer",
                          fontSize: 11,
                          fontWeight: 600,
                          fontFamily: "inherit",
                          padding: 0,
                        }}
                      >
                        {h.number}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Active hole details */}
              <div style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                borderRadius: 8,
                padding: 14,
                marginBottom: 12,
              }}>
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                }}>
                  <span style={{ fontFamily: "Outfit", fontWeight: 700, fontSize: 18, color: "#58a6ff" }}>
                    Hole {activeHole}
                  </span>
                  <button
                    onClick={() => deleteHoleFeatures(activeHole)}
                    style={{
                      background: "rgba(248,81,73,0.1)",
                      border: "1px solid rgba(248,81,73,0.3)",
                      borderRadius: 4,
                      color: "#f85149",
                      padding: "3px 8px",
                      cursor: "pointer",
                      fontSize: 11,
                      fontFamily: "inherit",
                    }}
                  >Clear</button>
                </div>

                {/* Status indicators */}
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <div style={{
                    flex: 1,
                    padding: "6px 8px",
                    borderRadius: 4,
                    background: hasTee ? "rgba(231,76,60,0.15)" : "rgba(139,148,158,0.1)",
                    border: `1px solid ${hasTee ? "rgba(231,76,60,0.3)" : "#21262d"}`,
                    fontSize: 11,
                    textAlign: "center",
                    color: hasTee ? "#e74c3c" : "#484f58",
                  }}>
                    {hasTee ? "✓ " : "○ "}Tee
                  </div>
                  <div style={{
                    flex: 1,
                    padding: "6px 8px",
                    borderRadius: 4,
                    background: hasGreen ? "rgba(46,204,113,0.15)" : "rgba(139,148,158,0.1)",
                    border: `1px solid ${hasGreen ? "rgba(46,204,113,0.3)" : "#21262d"}`,
                    fontSize: 11,
                    textAlign: "center",
                    color: hasGreen ? "#2ecc71" : "#484f58",
                  }}>
                    {hasGreen ? "✓ " : "○ "}Green
                  </div>
                </div>

                {/* Par */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>PAR</label>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[3, 4, 5].map(p => (
                      <button
                        key={p}
                        onClick={() => updateHole(activeHole, "par", p)}
                        style={{
                          flex: 1,
                          padding: "6px 0",
                          border: holeData.par === p ? "2px solid #58a6ff" : "1px solid #30363d",
                          borderRadius: 4,
                          background: holeData.par === p ? "#1f2937" : "transparent",
                          color: holeData.par === p ? "#58a6ff" : "#8b949e",
                          cursor: "pointer",
                          fontSize: 14,
                          fontWeight: 700,
                          fontFamily: "inherit",
                        }}
                      >{p}</button>
                    ))}
                  </div>
                </div>

                {/* Yardage */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>YARDAGE</label>
                  <input
                    type="number"
                    value={holeData.yardage || ""}
                    onChange={e => updateHole(activeHole, "yardage", parseInt(e.target.value) || 0)}
                    placeholder="Auto-calculated or manual"
                    style={{
                      width: "100%",
                      background: "#0d1117",
                      border: "1px solid #30363d",
                      borderRadius: 4,
                      color: "#f0e68c",
                      padding: "6px 10px",
                      fontSize: 16,
                      fontWeight: 700,
                      fontFamily: "inherit",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>
                    {hasTee && hasGreen ? "Calculated from tee-to-green" : "Place tee & green to auto-calc"}
                  </div>
                </div>

                {/* Handicap */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>HANDICAP INDEX</label>
                  <input
                    type="number"
                    min={1}
                    max={18}
                    value={holeData.handicap}
                    onChange={e => updateHole(activeHole, "handicap", parseInt(e.target.value) || 1)}
                    style={{
                      width: "100%",
                      background: "#0d1117",
                      border: "1px solid #30363d",
                      borderRadius: 4,
                      color: "#c9d1d9",
                      padding: "6px 10px",
                      fontSize: 13,
                      fontFamily: "inherit",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                </div>

                {/* Notes */}
                <div>
                  <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>NOTES</label>
                  <textarea
                    value={holeData.notes}
                    onChange={e => updateHole(activeHole, "notes", e.target.value)}
                    placeholder="Dogleg right, water left..."
                    rows={2}
                    style={{
                      width: "100%",
                      background: "#0d1117",
                      border: "1px solid #30363d",
                      borderRadius: 4,
                      color: "#c9d1d9",
                      padding: "6px 10px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      outline: "none",
                      resize: "vertical",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              </div>

              {/* Scorecard summary */}
              <div style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                borderRadius: 8,
                padding: 12,
                fontSize: 11,
              }}>
                <div style={{ color: "#8b949e", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  SCORECARD
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "#484f58" }}>
                      <td></td>
                      <td style={{ textAlign: "right", padding: "2px 4px" }}>Par</td>
                      <td style={{ textAlign: "right", padding: "2px 4px" }}>Yds</td>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ color: "#c9d1d9" }}>
                      <td style={{ fontWeight: 600 }}>OUT</td>
                      <td style={{ textAlign: "right", padding: "2px 4px", color: "#58a6ff" }}>{frontNine.reduce((s, h) => s + h.par, 0)}</td>
                      <td style={{ textAlign: "right", padding: "2px 4px", color: "#f0e68c" }}>{frontNine.reduce((s, h) => s + h.yardage, 0).toLocaleString()}</td>
                    </tr>
                    <tr style={{ color: "#c9d1d9" }}>
                      <td style={{ fontWeight: 600 }}>IN</td>
                      <td style={{ textAlign: "right", padding: "2px 4px", color: "#58a6ff" }}>{backNine.reduce((s, h) => s + h.par, 0)}</td>
                      <td style={{ textAlign: "right", padding: "2px 4px", color: "#f0e68c" }}>{backNine.reduce((s, h) => s + h.yardage, 0).toLocaleString()}</td>
                    </tr>
                    <tr style={{ color: "#fff", borderTop: "1px solid #21262d" }}>
                      <td style={{ fontWeight: 700, paddingTop: 4 }}>TOT</td>
                      <td style={{ textAlign: "right", padding: "4px 4px 2px", color: "#58a6ff", fontWeight: 700 }}>{totalPar}</td>
                      <td style={{ textAlign: "right", padding: "4px 4px 2px", color: "#f0e68c", fontWeight: 700 }}>{totalYardage.toLocaleString()}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Overlay controls bar (unlocked) ── */}
      {overlay && !overlay.locked && (
        <div style={{ position:"absolute", bottom:60, left:"50%", transform:"translateX(-50%)", background:"rgba(13,17,23,0.96)", backdropFilter:"blur(8px)", border:"1px solid #30363d", borderRadius:10, padding:"10px 16px", display:"flex", alignItems:"center", gap:20, zIndex:10, whiteSpace:"nowrap", userSelect:"none" }}>
          <span style={{ fontSize:12, color:"#8b949e", fontWeight:600 }}>🗺 Overlay</span>

          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:11, color:"#8b949e" }}>
            Opacity
            <input type="range" min={0.05} max={1} step={0.05} value={overlay.opacity}
              onChange={e => setOverlay(o => ({ ...o, opacity: +e.target.value }))}
              style={{ width:80, accentColor:"#58a6ff" }} />
            <span style={{ color:"#c9d1d9", minWidth:32 }}>{Math.round(overlay.opacity * 100)}%</span>
          </label>

          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:11, color:"#8b949e" }}>
            Scale
            <input type="range" min={0.1} max={5} step={0.05} value={overlay.scale}
              onChange={e => setOverlay(o => ({ ...o, scale: +e.target.value }))}
              style={{ width:90, accentColor:"#58a6ff" }} />
            <span style={{ color:"#c9d1d9", minWidth:36 }}>{overlay.scale.toFixed(2)}×</span>
          </label>

          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:11, color:"#8b949e" }}>
            Rotate
            <input type="range" min={-180} max={180} step={1} value={overlay.rotation}
              onChange={e => setOverlay(o => ({ ...o, rotation: +e.target.value }))}
              style={{ width:80, accentColor:"#58a6ff" }} />
            <span style={{ color:"#c9d1d9", minWidth:36 }}>{overlay.rotation}°</span>
          </label>

          <button onClick={() => setOverlay(o => ({ ...o, locked: true }))}
            style={{ background:"rgba(88,166,255,0.12)", border:"1px solid rgba(88,166,255,0.4)", borderRadius:5, color:"#58a6ff", padding:"4px 12px", cursor:"pointer", fontSize:11, fontWeight:600, fontFamily:"inherit" }}>
            🔒 Lock
          </button>

          <button onClick={() => setOverlay(null)}
            style={{ background:"rgba(248,81,73,0.12)", border:"1px solid rgba(248,81,73,0.3)", borderRadius:5, color:"#f85149", padding:"4px 10px", cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
            ✕ Remove
          </button>
        </div>
      )}

      {/* ── Overlay locked pill ── */}
      {overlay?.locked && (
        <div style={{ position:"absolute", bottom:16, left:72, display:"flex", gap:6, zIndex:10 }}>
          <button onClick={() => setOverlay(o => ({ ...o, locked: false }))}
            style={{ background:"rgba(13,17,23,0.85)", backdropFilter:"blur(6px)", border:"1px solid #30363d", borderRadius:6, color:"#8b949e", padding:"5px 10px", cursor:"pointer", fontSize:11, fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}>
            🔒 <span>Unlock overlay</span>
          </button>
          <button onClick={() => setOverlay(null)}
            style={{ background:"rgba(13,17,23,0.85)", backdropFilter:"blur(6px)", border:"1px solid #30363d", borderRadius:6, color:"#484f58", padding:"5px 8px", cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
            ✕
          </button>
        </div>
      )}

      {/* Search modal */}
      {showSearch && (
        <div style={{
          position: "absolute",
          top: 52,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.7)",
          zIndex: 20,
          display: "flex",
          justifyContent: "center",
          paddingTop: 40,
        }}
          onClick={() => { setShowSearch(false); setOsmResults([]); setOsmQuery(""); }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: 12,
              width: 480,
              maxHeight: 560,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 0,
            }}
          >
            <div style={{ fontFamily: "Outfit", fontWeight: 700, fontSize: 16, marginBottom: 14, color: "#e8e6e3" }}>
              Find a Golf Course
            </div>

            {/* OSM search bar with live dropdown */}
            <div style={{ position: "relative", marginBottom: 14 }}>
              <form onSubmit={searchOSM} style={{ display: "flex", gap: 8 }}>
                <input
                  autoFocus
                  value={osmQuery}
                  onChange={e => setOsmQuery(e.target.value)}
                  placeholder="Search — e.g. Indian, Torrey Pines…"
                  style={{
                    flex: 1,
                    background: "#0d1117",
                    border: "1px solid #30363d",
                    borderRadius: 6,
                    color: "#e8e6e3",
                    padding: "8px 12px",
                    fontSize: 13,
                    fontFamily: "inherit",
                    outline: "none",
                  }}
                  onFocus={e => { e.target.style.borderColor = "#58a6ff"; if (osmResults.length > 0) setShowDropdown(true); }}
                  onBlur={e => { e.target.style.borderColor = "#30363d"; setTimeout(() => setShowDropdown(false), 150); }}
                />
                <button
                  type="submit"
                  disabled={isSearching}
                  style={{
                    background: isSearching ? "#21262d" : "linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)",
                    border: "none",
                    borderRadius: 6,
                    color: "#fff",
                    padding: "8px 16px",
                    cursor: isSearching ? "default" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    whiteSpace: "nowrap",
                  }}
                >
                  {isSearching ? "…" : "🔍"}
                </button>
              </form>

              {/* Live dropdown */}
              {showDropdown && (osmResults.length > 0 || isSearching) && (
                <div style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 999,
                  background: "#161b22",
                  border: "1px solid #30363d",
                  borderRadius: 8,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                  maxHeight: 280,
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                }}>
                  {isSearching && osmResults.length === 0 && (
                    <div style={{ padding: "10px 14px", fontSize: 12, color: "#8b949e" }}>Searching…</div>
                  )}
                  {osmResults.map((c, i) => (
                    <button
                      key={i}
                      onMouseDown={() => { handleCourseSelect(c); setShowDropdown(false); setOsmQuery(""); setOsmResults([]); }}
                      style={{
                        background: "transparent",
                        border: "none",
                        borderBottom: i < osmResults.length - 1 ? "1px solid #21262d" : "none",
                        padding: "10px 14px",
                        cursor: "pointer",
                        textAlign: "left",
                        color: "#c9d1d9",
                        fontFamily: "inherit",
                        fontSize: 13,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                        flexShrink: 0,
                      }}
                      onMouseOver={e => e.currentTarget.style.background = "#21262d"}
                      onMouseOut={e => e.currentTarget.style.background = "transparent"}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                        {c.address && (
                          <span style={{ fontSize: 11, color: "#8b949e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.address}</span>
                        )}
                      </div>
                      <span style={{ color: "#484f58", fontSize: 11, flexShrink: 0 }}>{c.lat.toFixed(3)}, {c.lng.toFixed(3)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Featured courses */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 10, color: "#484f58", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
                Featured Courses
              </div>
              {DEFAULT_COURSES.map(c => (
                <button
                  key={c.name}
                  onClick={() => handleCourseSelect(c)}
                  style={{
                    background: "#0d1117",
                    border: "1px solid #21262d",
                    borderRadius: 8,
                    padding: "10px 14px",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "#c9d1d9",
                    fontFamily: "inherit",
                    fontSize: 13,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    transition: "border-color 0.15s",
                  }}
                  onMouseOver={e => e.currentTarget.style.borderColor = "#58a6ff"}
                  onMouseOut={e => e.currentTarget.style.borderColor = "#21262d"}
                >
                  <span style={{ fontWeight: 600 }}>{c.name}</span>
                  <span style={{ color: "#484f58", fontSize: 11 }}>{c.lat.toFixed(3)}, {c.lng.toFixed(3)}</span>
                </button>
              ))}
            </div>

            <div style={{ marginTop: 12, fontSize: 11, color: "#484f58" }}>
              Powered by OpenStreetMap · Tip: pan and zoom the map to any location
            </div>
          </div>
        </div>
      )}

      {/* Terrain 3D preview */}
      {terrainObjText && (
        <TerrainPreview
          objText={terrainObjText}
          courseName={courseName}
          onClose={() => setTerrainObjText(null)}
        />
      )}

      {/* Export preview modal */}
      {showExport && (
        <div style={{
          position: "absolute",
          top: 52,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.7)",
          zIndex: 20,
          display: "flex",
          justifyContent: "center",
          paddingTop: 20,
        }}
          onClick={() => setShowExport(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: 12,
              width: 600,
              maxHeight: "calc(100vh - 120px)",
              padding: 20,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontFamily: "Outfit", fontWeight: 700, fontSize: 16, color: "#e8e6e3" }}>
                Export Preview
              </span>
              <button onClick={handleExport} style={{
                background: "#238636", border: "none", borderRadius: 6, color: "#fff",
                padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
              }}>
                ↓ Download JSON
              </button>
            </div>
            <pre style={{
              flex: 1,
              overflowY: "auto",
              background: "#0d1117",
              border: "1px solid #21262d",
              borderRadius: 8,
              padding: 14,
              fontSize: 11,
              lineHeight: 1.5,
              color: "#7ee787",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}>
              {exportData()}
            </pre>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(8px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
      `}</style>
    </div>
  );
}
