import { useEffect, useRef, useCallback, useState } from "react";

// Feature polygon fill colors (2D canvas)
const FILL = {
  fairway:    "#5aaa4a",
  green_area: "#3d9e36",
  bunker:     "#d4c07a",
  water:      "#3a7bd5",
  path:       "#909aa0",
  rough:      "#2a4a2a",
};

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------
// Props:
//   stateRef        – Three.js scene ref; reads .ballMesh.position, .trailPoints
//   teeXZ           – { x, z }  tee world position
//   pinXZ           – { x, z } | null
//   features        – [{ type, points:[{x,z}] }]  polygons in world-XZ coords
//   targets         – [{ z, color }]  for driving-range yardage rings (optional)
//   worldBounds     – { minX, maxX, minZ, maxZ }  full course extents
//   aimAzimuth      – current aim in degrees (0=straight ahead/+Z)
//   onAimChange     – (deg) => void
//   size            – canvas px (default 200)
// ---------------------------------------------------------------------------
export default function Minimap({
  stateRef,
  teeXZ,
  pinXZ = null,
  features = [],
  targets  = [],
  worldBounds,
  aimAzimuth,
  onAimChange,
  size = 200,
  flipX = false,
}) {
  const canvasRef = useRef(null);
  const zoomRef   = useRef(1);
  const aimRef    = useRef(aimAzimuth);
  const [zoom, setZoom] = useState(1);   // only drives the label re-render

  // Keep aim ref in sync without restarting the rAF loop
  useEffect(() => { aimRef.current = aimAzimuth; }, [aimAzimuth]);

  // --- visible world bounds for current zoom ---------------------------------
  const computeBounds = useCallback((z) => {
    const rawW = worldBounds.maxX - worldBounds.minX;
    const rawH = worldBounds.maxZ - worldBounds.minZ;
    const w = rawW / z;
    const h = rawH / z;
    return {
      minX: teeXZ.x - w / 2,
      maxX: teeXZ.x + w / 2,
      minZ: teeXZ.z - h * 0.28,    // tee sits ~28% from bottom
      maxZ: teeXZ.z + h * 0.72,
    };
  }, [teeXZ, worldBounds]);

  // --- rAF draw loop --------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let animId;
    const W = size, H = size;

    const toC = (wx, wz, b) => ({
      x: flipX
        ? W - (wx - b.minX) / (b.maxX - b.minX) * W
        : (wx - b.minX) / (b.maxX - b.minX) * W,
      y: (b.maxZ - wz) / (b.maxZ - b.minZ) * H,
    });

    const draw = () => {
      animId = requestAnimationFrame(draw);
      const ctx = canvas.getContext("2d");
      const az  = aimRef.current ?? 0;
      const b   = computeBounds(zoomRef.current);

      // Background
      ctx.fillStyle = "#111e11";
      ctx.fillRect(0, 0, W, H);

      // Features
      for (const feat of features) {
        if (!feat.points || feat.points.length < 3) continue;
        const col = FILL[feat.type] || FILL.rough;
        ctx.beginPath();
        const fp = toC(feat.points[0].x, feat.points[0].z, b);
        ctx.moveTo(fp.x, fp.y);
        for (let i = 1; i < feat.points.length; i++) {
          const p = toC(feat.points[i].x, feat.points[i].z, b);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fillStyle = col + "bb";
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // Driving-range target rings
      for (const t of targets) {
        const tp = toC(0, t.z, b);
        ctx.beginPath();
        ctx.arc(tp.x, tp.y, 5, 0, Math.PI * 2);
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // small cross at centre
        ctx.beginPath();
        ctx.moveTo(tp.x - 3, tp.y); ctx.lineTo(tp.x + 3, tp.y);
        ctx.moveTo(tp.x, tp.y - 3); ctx.lineTo(tp.x, tp.y + 3);
        ctx.strokeStyle = t.color + "88";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Shot trail
      const trail = stateRef.current?.trailPoints ?? [];
      if (trail.length > 1) {
        ctx.beginPath();
        const ft = toC(trail[0].x, trail[0].z, b);
        ctx.moveTo(ft.x, ft.y);
        for (let i = 1; i < trail.length; i++) {
          const p = toC(trail[i].x, trail[i].z, b);
          ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = "rgba(255,200,0,0.65)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Ball
      const ball = stateRef.current?.ballMesh;
      if (ball?.visible) {
        const bp = toC(ball.position.x, ball.position.z, b);
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Aim indicator — project aim direction through the world→canvas transform
      const teeP  = toC(teeXZ.x, teeXZ.z, b);
      const azRad = az * Math.PI / 180;
      // positive az = first-person RIGHT; X offset sign depends on coordinate convention
      const worldDist = (b.maxZ - b.minZ) * 0.45;
      const aimWX = teeXZ.x + (flipX ? -Math.sin(azRad) : Math.sin(azRad)) * worldDist;
      const aimWZ = teeXZ.z + ( Math.cos(azRad)) * worldDist;
      const aimP  = toC(aimWX, aimWZ, b);

      ctx.beginPath();
      ctx.moveTo(teeP.x, teeP.y);
      ctx.lineTo(aimP.x, aimP.y);
      ctx.strokeStyle = "#ffff00";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 2]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrowhead
      const angle = Math.atan2(aimP.y - teeP.y, aimP.x - teeP.x);
      const al = 7;
      ctx.beginPath();
      ctx.moveTo(aimP.x, aimP.y);
      ctx.lineTo(aimP.x - al * Math.cos(angle - 0.42), aimP.y - al * Math.sin(angle - 0.42));
      ctx.lineTo(aimP.x - al * Math.cos(angle + 0.42), aimP.y - al * Math.sin(angle + 0.42));
      ctx.closePath();
      ctx.fillStyle = "#ffff00";
      ctx.fill();

      // Pin / flag
      if (pinXZ) {
        const pp = toC(pinXZ.x, pinXZ.z, b);
        // Pole
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y);
        ctx.lineTo(pp.x, pp.y - 9);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();
        // Flag triangle
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y - 9);
        ctx.lineTo(pp.x + 6, pp.y - 6);
        ctx.lineTo(pp.x, pp.y - 3);
        ctx.closePath();
        ctx.fillStyle = "#ff4444";
        ctx.fill();
        // Cup dot
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#ff4444";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Tee dot
      ctx.beginPath();
      ctx.arc(teeP.x, teeP.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "#c8f090";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();

      // North indicator (▲ = +Z = forward)
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font      = "9px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText("▲N", W - 3, 3);

      // Border
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth   = 1;
      ctx.strokeRect(0, 0, W, H);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [stateRef, teeXZ, pinXZ, features, targets, computeBounds, size, flipX]);

  // --- Click to aim ---------------------------------------------------------
  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px   = (e.clientX - rect.left) * (size / rect.width);
    const py   = (e.clientY - rect.top)  * (size / rect.height);

    const b  = computeBounds(zoomRef.current);
    const wx = flipX
      ? b.maxX - (px / size) * (b.maxX - b.minX)
      : b.minX + (px / size) * (b.maxX - b.minX);
    const wz = b.maxZ - (py / size) * (b.maxZ - b.minZ);

    const dx = wx - teeXZ.x;
    const dz = wz - teeXZ.z;
    if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return;

    // positive az = first-person RIGHT in both modes
    const az = Math.atan2(flipX ? -dx : dx, dz) * 180 / Math.PI;
    onAimChange(Math.round(Math.max(-90, Math.min(90, az))));
  }, [computeBounds, teeXZ, onAimChange, size, flipX]);

  // --- Zoom helpers ---------------------------------------------------------
  const zoomIn  = () => { const n = Math.min(5,   zoomRef.current * 1.5); zoomRef.current = n; setZoom(n); };
  const zoomOut = () => { const n = Math.max(0.3, zoomRef.current / 1.5); zoomRef.current = n; setZoom(n); };

  // --- Styles ---------------------------------------------------------------
  const btnSt = {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: 4,
    color: "#e8e6e3",
    width: 26, height: 22,
    cursor: "pointer",
    fontSize: 15,
    lineHeight: "20px",
    padding: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
  };

  return (
    <div style={{
      position: "absolute",
      bottom: 16,
      right: 16,
      zIndex: 15,
      background: "rgba(0,0,0,0.65)",
      borderRadius: 8,
      overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.15)",
      boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      userSelect: "none",
    }}>
      {/* Header */}
      <div style={{
        padding: "3px 8px",
        background: "rgba(0,0,0,0.4)",
        fontSize: 9,
        color: "#8b949e",
        letterSpacing: "0.1em",
        textAlign: "center",
        fontFamily: "monospace",
        textTransform: "uppercase",
      }}>
        Minimap · click to aim
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        style={{ display: "block", cursor: "crosshair" }}
        onClick={handleClick}
      />

      {/* Zoom row */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: "4px 8px",
        background: "rgba(0,0,0,0.4)",
      }}>
        <button style={btnSt} onClick={zoomIn}  title="Zoom in">+</button>
        <span style={{ color: "#8b949e", fontSize: 11, fontFamily: "monospace", minWidth: 36, textAlign: "center" }}>
          {zoom.toFixed(1)}×
        </span>
        <button style={btnSt} onClick={zoomOut} title="Zoom out">−</button>
      </div>
    </div>
  );
}
