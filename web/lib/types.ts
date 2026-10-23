export type Level = "detected" | "corroborated" | "verified" | "explained" | "disputed";

export type Verification = {
  level: Level;
  why: string;
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

export type Reviewer = { name: string; token: string; enabled: boolean };

export const LEVELS: { id: Level; label: string; color: string; note: string }[] = [
  // Cream with a brick ring on the map: reads as "confirmed", not as burn red.
  { id: "verified", label: "Verified", color: "#f4efe6", note: "2+ independent sources, signed off by a second investigator" },
  { id: "corroborated", label: "Corroborated", color: "#f5a623", note: "evidence located and dated by an investigator" },
  { id: "disputed", label: "Disputed", color: "#f5a623", note: "credible evidence on both sides" },
  { id: "explained", label: "Explained", color: "#6ec8ff", note: "non-hostile cause: crops, earthquake…" },
  { id: "detected", label: "Detected", color: "#8a8d84", note: "satellite signal only, unreviewed" },
];

export const levelInfo = (level: Level) => LEVELS.find((l) => l.id === level) ?? LEVELS[LEVELS.length - 1];

/** Centre of a site: the point itself, or the middle of an investigation's area. */
export function siteCentre(site: Site): [number, number] {
  if (site.geometry.type === "Point") return [site.geometry.coordinates[0], site.geometry.coordinates[1]];
  const ring = site.geometry.coordinates[0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}
