export const TOOL_MODES = {
  PAN: "pan",
  TEE: "tee",
  GREEN: "green",
  GREEN_AREA: "green_area",
  FAIRWAY: "fairway",
  BUNKER: "bunker",
  WATER: "water",
  PATH: "path",
};

export const TOOL_COLORS = {
  [TOOL_MODES.TEE]: "#e74c3c",
  [TOOL_MODES.GREEN]: "#2ecc71",
  [TOOL_MODES.GREEN_AREA]: "#27ae60",
  [TOOL_MODES.FAIRWAY]: "#7dcea0",
  [TOOL_MODES.BUNKER]: "#f0e68c",
  [TOOL_MODES.WATER]: "#3498db",
  [TOOL_MODES.PATH]: "#bdc3c7",
};

export const TOOL_LABELS = {
  [TOOL_MODES.PAN]: "Pan / Select",
  [TOOL_MODES.TEE]: "Tee Box",
  [TOOL_MODES.GREEN]: "Pin Placement",
  [TOOL_MODES.GREEN_AREA]: "Green Area",
  [TOOL_MODES.FAIRWAY]: "Fairway",
  [TOOL_MODES.BUNKER]: "Bunker",
  [TOOL_MODES.WATER]: "Water Hazard",
  [TOOL_MODES.PATH]: "Cart Path",
};

export const TOOL_ICONS = {
  [TOOL_MODES.PAN]: "↔",
  [TOOL_MODES.TEE]: "⏏",
  [TOOL_MODES.GREEN]: "⚑",
  [TOOL_MODES.GREEN_AREA]: "⊙",
  [TOOL_MODES.FAIRWAY]: "▬",
  [TOOL_MODES.BUNKER]: "◌",
  [TOOL_MODES.WATER]: "〜",
  [TOOL_MODES.PATH]: "⋯",
};

export const DEFAULT_COURSES = [
  { name: "Augusta National", lat: 33.503, lng: -82.022, zoom: 16 },
  { name: "Pebble Beach", lat: 36.567, lng: -121.948, zoom: 16 },
  { name: "St Andrews Old Course", lat: 56.343, lng: -2.802, zoom: 16 },
  { name: "TPC Sawgrass", lat: 30.198, lng: -81.394, zoom: 16 },
  { name: "Pinehurst No. 2", lat: 35.192, lng: -79.468, zoom: 16 },
];
