export type Level = "detected" | "corroborated" | "verified" | "disputed" | "ruled_out";

export type Verification = {
  level: Level;
  why: string;
  ruled_out_reason: "explained" | "false_detection" | null;
  evidence_count: number;
  independent_sources: number;
  agreement: { agree: number; disagree: number; unsure: number };
};

export type Site = {
  id: string;
  name: string | null;
  status: string;
  calibration_status: string;
  optical_read: string;
  pwtt_z: number | null;
  burn_probability: number | null;
  burn_threshold: number;
  features: Record<string, number | null> | null;
  seismic: Record<string, unknown> | null;
  scene_ids: Record<string, unknown> | null;
  timestamps: Record<string, unknown> | null;
  region: string | null;
  is_demo: number;
  geometry: { type: "Point"; coordinates: number[] } | { type: "Polygon"; coordinates: number[][][] };
  created_at: string;
  verification: Verification;
  /** hotspot: a machine detection (point); investigation: an area people opened (polygon). */
  kind: "hotspot" | "investigation";
  parent_id: string | null;
  name_local: string | null;
  question: string | null;
  created_by: string | null;
};

export type EvidenceCheck = {
  located: "yes" | "no" | "unsure";
  dated: "yes" | "no" | "unsure";
  original: "original" | "repost" | "unsure";
  shares_source_with: string[];
  reviewer: string;
  note: string | null;
  created_at: string;
};

export type Evidence = {
  id: string;
  kind: "link" | "testimony" | "prior_report";
  visibility: "public" | "reviewers";
  url: string | null;
  body: string | null;
  /** For prior_report items: the record as the source returned it. */
  record: PriorReport | null;
  is_demo: boolean;
  created_at: string;
  check: EvidenceCheck | null;
};

export type Comment = {
  id: string;
  site_id: string;
  /** null: the site's open thread */
  evidence_id: string | null;
  author: string;
  body: string;
  created_at: string;
};

/** A documented incident from ACLED, as recorded. Never scored or judged. */
export type PriorReport = {
  source: "acled" | "acled_sample";
  source_id: string;
  event_date: string;
  days_outside_window: number;
  time_precision: number | null;
  time_precision_text: string | null;
  latitude: number;
  longitude: number;
  distance_km: number;
  geo_precision: number | null;
  geo_precision_text: string | null;
  location: string | null;
  admin: string[];
  country: string | null;
  event_type: string | null;
  sub_event_type: string | null;
  actors: string[];
  fatalities: number | null;
  notes: string | null;
  sources: string[];
};

export type FireDetection = {
  source: string;
  satellite: string | null;
  instrument: string;
  lat: number;
  lon: number;
  distance_km: number;
  acq_date: string;
  acq_time: string;
  daynight: "day" | "night" | null;
  confidence: string | null;
  frp_mw: number | null;
  brightness_k: number | null;
  type: string | null;
  pixel_m: number;
};

export type FireSearch = {
  search_id: string;
  searched: { radius_km: number; dates: [string, string]; sources: string[] };
  searched_by: string;
  searched_at: string;
  truncated: boolean;
  count: number;
  detections: FireDetection[];
};

export type PriorReportSearch = {
  search_id: string;
  searched: { source: string; radius_km: number; dates: [string, string]; dates_searched: [string, string] };
  searched_by: string;
  searched_at: string;
  truncated: boolean;
  count: number;
  reports: PriorReport[];
};

export type Job = {
  id: string;
  kind: string;
  status: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
};

const PAPER = "#f4efe6";
const BRICK = "#a8442f";

/**
 * How each level is drawn. Marks fill up as a site climbs the ladder: an empty
 * ring for a machine signal, half-strength brick once a colleague has
 * corroborated it, solid brick once verified. Disputed is a cream dot. `line` outlines investigation areas on imagery.
 */
export type LevelStyle = { id: Level; label: string; note: string; fill: string; stroke: string; strokeWidth: number; radius: number; line: string };

export const LEVELS: LevelStyle[] = [
  { id: "verified", label: "Verified", note: "signed off by a colleague, with at least one checked source (provisional standard)", fill: BRICK, stroke: PAPER, strokeWidth: 2.5, radius: 8, line: "#c4563c" },
  { id: "corroborated", label: "Corroborated", note: "evidence located and dated by a colleague", fill: "rgba(168,68,47,0.5)", stroke: PAPER, strokeWidth: 1.5, radius: 7, line: PAPER },
  { id: "disputed", label: "Disputed", note: "credible evidence on both sides", fill: PAPER, stroke: BRICK, strokeWidth: 2.5, radius: 7, line: "#c4563c" },
  { id: "detected", label: "Detected", note: "satellite signal only, not yet looked at", fill: "rgba(0,0,0,0)", stroke: PAPER, strokeWidth: 1.5, radius: 5, line: "#d8d2b8" },
  { id: "ruled_out", label: "Ruled out", note: "a non-hostile cause, or a false detection", fill: "rgba(0,0,0,0)", stroke: "#8a8d84", strokeWidth: 1, radius: 4, line: "#8a8d84" },
];

export const levelInfo = (level: Level) => LEVELS.find((l) => l.id === level) ?? LEVELS.find((l) => l.id === "detected")!;

/** Centre of a site: the point itself, or the middle of an investigation's area. */
export function siteCentre(site: Site): [number, number] {
  if (site.geometry.type === "Point") return [site.geometry.coordinates[0], site.geometry.coordinates[1]];
  const ring = site.geometry.coordinates[0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}
