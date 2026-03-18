export default function HomeScreen({ onSelect }) {
  const cards = [
    {
      id: "driving-range",
      icon: "🏌️",
      title: "DRIVING RANGE",
      desc: "Practice your swing on a low-poly range with yardage targets and shot tracer.",
      accent: "#2ecc71",
      bg: "linear-gradient(135deg, #0d2e1a 0%, #0c1117 100%)",
    },
    {
      id: "creator",
      icon: "🗺️",
      title: "COURSE CREATOR",
      desc: "Design a course on satellite imagery, draw features, and export to Unity.",
      accent: "#58a6ff",
      bg: "linear-gradient(135deg, #0d1f3c 0%, #0c1117 100%)",
    },
    {
      id: "play",
      icon: "⛳",
      title: "PLAY A COURSE",
      desc: "Build or load a course in the creator, then hit Play to tee off in first-person.",
      accent: "#f0ad4e",
      bg: "linear-gradient(135deg, #2e1d00 0%, #0c1117 100%)",
    },
  ];

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      background: "#0c1117",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      overflow: "hidden",
    }}>
      <link
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Outfit:wght@300;400;600;700;800&display=swap"
        rel="stylesheet"
      />

      {/* Logo */}
      <div style={{ marginBottom: 56, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>⛳</div>
        <div style={{
          fontFamily: "Outfit",
          fontWeight: 800,
          fontSize: 36,
          letterSpacing: "-0.03em",
          color: "#58a6ff",
        }}>
          COURSE FORGE
        </div>
        <div style={{ color: "#484f58", fontSize: 13, marginTop: 6, letterSpacing: "0.08em" }}>
          GOLF COURSE DESIGN &amp; PLAY
        </div>
      </div>

      {/* Cards */}
      <div style={{
        display: "flex",
        gap: 24,
        flexWrap: "wrap",
        justifyContent: "center",
        padding: "0 24px",
      }}>
        {cards.map(card => (
          <button
            key={card.id}
            onClick={() => onSelect(card.id)}
            style={{
              background: card.bg,
              border: `1px solid ${card.accent}33`,
              borderRadius: 16,
              padding: "36px 32px",
              width: 240,
              cursor: "pointer",
              textAlign: "left",
              transition: "transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease",
              outline: "none",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = "translateY(-4px)";
              e.currentTarget.style.borderColor = card.accent + "88";
              e.currentTarget.style.boxShadow = `0 8px 32px ${card.accent}22`;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.borderColor = card.accent + "33";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 16 }}>{card.icon}</div>
            <div style={{
              fontFamily: "Outfit",
              fontWeight: 700,
              fontSize: 15,
              color: card.accent,
              letterSpacing: "0.04em",
              marginBottom: 10,
            }}>
              {card.title}
            </div>
            <div style={{
              color: "#8b949e",
              fontSize: 12,
              lineHeight: 1.6,
              fontFamily: "inherit",
            }}>
              {card.desc}
            </div>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 48, color: "#30363d", fontSize: 11, letterSpacing: "0.05em" }}>
        v0.1 — USGS 3DEP · ArcGIS Imagery · Rapier Physics
      </div>
    </div>
  );
}
