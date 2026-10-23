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
  geometry: { type: string; coordinates: number[] };
  created_at: string;
  verification: Verification;
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
  kind: "link" | "testimony";
  visibility: "public" | "reviewers";
  url: string | null;
  body: string | null;
  is_demo: boolean;
  created_at: string;
  check: EvidenceCheck | null;
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
