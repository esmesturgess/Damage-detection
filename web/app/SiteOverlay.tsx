"use client";

import { useEffect, useState } from "react";
import Discussion, { EvidenceComments } from "./Discussion";
import PriorReports from "./PriorReports";
import { levelInfo, siteCentre, type Comment, type Evidence, type EvidenceCheck, type Reviewer, type Site } from "@/lib/types";

const LADDER = ["detected", "corroborated", "verified"] as const;

const FEATURE_LABELS: Record<string, string> = {
  hotspot_area_ha: "Hot-spot area (ha)",
  max_t: "Peak radar change (T)",
  mean_dnbr: "Burn signal, average",
  p95_dnbr: "Burn signal, strongest 5%",
  nbr2_change: "Moisture loss",
  stable_water_fraction: "Standing water",
};

function reviewerHeaders(reviewer: Reviewer): Record<string, string> {
  return reviewer.enabled ? { "x-analyst-token": reviewer.token, "x-analyst": reviewer.name } : {};
}

async function fetchEvidence(siteId: string, reviewer: Reviewer): Promise<Evidence[]> {
  const res = await fetch(`/api/sites/${siteId}/evidence`, { headers: reviewerHeaders(reviewer) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Request failed");
  return data;
}

export default function SiteOverlay({
  site,
  handle,
  reviewer,
  onHandle,
  onClose,
  onChanged,
  parent,
  onOpenSite,
  onStartHere,
}: {
  site: Site;
  handle: string;
  reviewer: Reviewer;
  onHandle: (h: string) => void;
  onClose: () => void;
  onChanged: () => void;
  /** The investigation a hot-spot belongs to, if any. */
  parent: Site | null;
  onOpenSite: (id: string) => void;
  onStartHere: (site: Site) => void;
}) {
  const isInvestigation = site.kind === "investigation";
  const hotspots = useHotspots(isInvestigation ? site.id : null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [msg, setMsg] = useState("");
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const v = site.verification;
  const info = levelInfo(v.level);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    fetchEvidence(site.id, reviewer).then(
      (items) => !cancelled && setEvidence(items),
      () => !cancelled && setEvidence([]),
    );
    fetch(`/api/sites/${site.id}/comments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((items) => !cancelled && setComments(items))
      .catch(() => !cancelled && setComments([]));
    return () => {
      cancelled = true;
    };
  }, [site.id, reviewer, version]);

  async function act(fn: () => Promise<unknown>, done: string): Promise<boolean> {
    try {
      await fn();
      if (done) setMsg(done);
      setVersion((n) => n + 1);
      onChanged();
      return true;
    } catch (err) {
      setMsg((err as Error).message);
      return false;
    }
  }

  const [lon, lat] = siteCentre(site);
  const window_ = (site.timestamps as { event_window?: string[] } | null)?.event_window;
  const f = site.features ?? {};
  const strongest = hotspots.length ? Math.max(...hotspots.map((h) => h.pwtt_z ?? 0)) : null;
  const facts: { label: string; value: string }[] = [
    { label: "Window", value: window_ ? dateRange(window_[0], window_[1]) : "—" },
    ...(isInvestigation
      ? [
          { label: "Hot-spots", value: String(hotspots.length) },
          { label: "Strongest change", value: strongest != null ? strongest.toFixed(1) : "—" },
        ]
      : [
          { label: "Radar change", value: site.pwtt_z != null ? site.pwtt_z.toFixed(1) : "—" },
          { label: "Burn, strongest 5%", value: f.p95_dnbr != null ? Number(f.p95_dnbr).toFixed(2) : "—" },
        ]),
    { label: "Evidence", value: String(v.evidence_count) },
    { label: "Independent sources", value: String(v.independent_sources) },
  ];

  return (
    <div
      className="fixed inset-0 z-30 bg-black/55 p-3 md:p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={site.name ?? "Site"}
    >
      <div className="on-brick overlay-brick relative h-full overflow-auto rounded-2xl border border-[var(--line)] shadow-2xl">
        <button
          className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/20 text-[24px] leading-none hover:bg-black/35"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>

        {/* Case-file cover */}
        <header className="border-b border-[var(--line)] px-8 pb-6 pt-7 lg:px-10">
          <div className="eyebrow mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[var(--foreground)]">{isInvestigation ? "Investigation" : "Hot-spot"}</span>
            <span>{site.region ?? "unassigned region"}</span>
            <span className="num">
              {lat.toFixed(4)}°N {lon.toFixed(4)}°E
            </span>
            <button
              className="link normal-case tracking-normal"
              onClick={() => {
                navigator.clipboard?.writeText(window.location.href).then(
                  () => setMsg("Link copied."),
                  () => setMsg(window.location.href),
                );
              }}
            >
              copy link
            </button>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4 pr-14">
            <div className="max-w-3xl">
              <h1 className="text-[30px] font-semibold leading-[1.1] tracking-tight lg:text-[36px]">{site.name ?? site.id}</h1>
              {site.name_local ? <p className="mt-1 text-[22px] opacity-80">{site.name_local}</p> : null}
            </div>
            <span className="flex items-center gap-2 rounded-full border border-[var(--line)] bg-black/20 px-3.5 py-1.5 text-[14px]">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: info.color }} />
              {info.label}
            </span>
          </div>
          {site.question ? (
            <blockquote className="mt-5 max-w-3xl border-l-4 border-[#f4efe6]/60 pl-4 text-[16px] leading-snug">
              {site.question}
              {site.created_by ? <span className="muted block text-[12px]">asked by {site.created_by}</span> : null}
            </blockquote>
          ) : null}
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
            {facts.map((fact) => (
              <div key={fact.label} className="border-l-2 border-[var(--line)] pl-3">
                <dt className="faint text-[11px] uppercase tracking-[0.12em]">{fact.label}</dt>
                <dd className="mt-0.5 whitespace-nowrap text-[20px] font-medium leading-tight">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </header>

        <div className="grid gap-8 px-8 py-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)] lg:px-10">
          {/* Left: what the satellite saw, then what people have found */}
          <div className="min-w-0 space-y-10">
            <SiteImagery siteId={site.id} />

            {isInvestigation ? <HotspotList hotspots={hotspots} onOpen={onOpenSite} /> : null}

            <PriorReports
              siteId={site.id}
              handle={handle}
              addedIds={evidence.flatMap((e) => (e.record ? [e.record.source_id] : []))}
              onAdd={(searchId, sourceId) =>
                act(
                  () => post(`/api/sites/${site.id}/prior-reports/evidence`, { search_id: searchId, source_id: sourceId, handle }),
                  "Added as evidence. A colleague will check it.",
                )
              }
              onSearched={() => setVersion((n) => n + 1)}
              onMessage={setMsg}
            />

            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[18px] font-semibold">Evidence</h2>
                {adding ? null : (
                  <button className="btn btn-primary px-3 py-1.5" onClick={() => setAdding(true)}>
                    + Add evidence
                  </button>
                )}
              </div>
              {adding ? (
                <AddEvidence
                  handle={handle}
                  onHandle={onHandle}
                  onCancel={() => setAdding(false)}
                  onSubmit={async (body) => {
                    const ok = await act(() => post(`/api/sites/${site.id}/evidence`, body), "Evidence added. A colleague will check it.");
                    if (ok) setAdding(false);
                    return ok;
                  }}
                />
              ) : null}
              {evidence.length === 0 && !adding ? (
                <p className="muted rounded-xl border border-dashed border-[var(--line)] px-4 py-6 text-center">
                  No evidence yet. Links, testimony, photos and video all help.
                </p>
              ) : null}
              <ul className="grid gap-3 xl:grid-cols-2">
                {evidence.map((item) => (
                  <EvidenceItem
                    key={item.id}
                    item={item}
                    others={evidence.filter((e) => e.id !== item.id)}
                    reviewer={reviewer}
                    comments={comments.filter((c) => c.evidence_id === item.id)}
                    handle={handle}
                    onHandle={onHandle}
                    onComment={(body) => act(() => post(`/api/sites/${site.id}/comments`, { body, handle, evidence_id: item.id }), "")}
                    onCheck={(check) =>
                      act(() => post(`/api/evidence/${item.id}/check`, check, reviewerHeaders(reviewer)), "Check saved.")
                    }
                  />
                ))}
              </ul>
            </section>

            <Discussion
              question={site.question}
              askedBy={site.created_by}
              askedAt={site.created_at}
              comments={comments.filter((c) => c.evidence_id === null)}
              handle={handle}
              onHandle={onHandle}
              onPost={(body) => act(() => post(`/api/sites/${site.id}/comments`, { body, handle }), "")}
            />
          </div>

          {/* Right rail: the verdict so far, readings and actions */}
          <aside className="space-y-8 lg:sticky lg:top-6 lg:self-start">
            {isInvestigation ? null : parent ? (
              <section className="rounded-xl border border-[var(--line)] p-5">
                <div className="eyebrow mb-1.5">Part of investigation</div>
                <p className="mb-3 text-[15px] font-semibold">
                  {parent.name}
                  {parent.name_local ? <span className="muted font-normal"> · {parent.name_local}</span> : null}
                </p>
                <button className="btn w-full" onClick={() => onOpenSite(parent.id)}>
                  Open the investigation
                </button>
              </section>
            ) : (
              <section className="rounded-xl border border-[var(--line)] p-5">
                <div className="eyebrow mb-1.5">Not part of an investigation</div>
                <p className="muted mb-3 leading-snug">
                  Start one for this area to gather evidence and discuss it with colleagues.
                </p>
                <button className="btn btn-primary w-full" onClick={() => onStartHere(site)}>
                  Start investigation here
                </button>
              </section>
            )}

            <section className="rounded-xl bg-black/20 p-5">
              <div className="eyebrow mb-3">Verification</div>
              <div className="mb-4 flex gap-1.5">
                {LADDER.map((step) => {
                  const reached =
                    v.level !== "explained" &&
                    v.level !== "disputed" &&
                    LADDER.indexOf(step) <= LADDER.indexOf(v.level as (typeof LADDER)[number]);
                  return (
                    <div key={step} className="flex-1">
                      <div
                        className="mb-1.5 h-1.5 rounded-full"
                        style={{ background: reached ? levelInfo(step).color : "rgba(255,255,255,0.14)" }}
                      />
                      <span className={`text-[12px] ${reached ? "" : "faint"}`}>{levelInfo(step).label}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[15px] font-semibold" style={{ color: info.color }}>
                {info.label}
              </p>
              <p className="muted mt-1 leading-snug">{v.why}</p>
            </section>

            {isInvestigation ? null : <SatelliteReading site={site} onChanged={onChanged} />}

            <section>
              <div className="eyebrow mb-2">Do you agree?</div>
              <div className="mb-1.5 grid grid-cols-3 gap-2">
                {(["agree", "disagree", "unsure"] as const).map((stance) => (
                  <button
                    key={stance}
                    className="btn flex-col gap-0 py-2 capitalize"
                    onClick={() =>
                      handle.trim()
                        ? act(() => post(`/api/sites/${site.id}/assessment`, { handle, stance }), "Thanks, noted.")
                        : setMsg("Pick a handle first (any name; it's never shown). Use “Add evidence” to set one.")
                    }
                  >
                    <span className="num text-[18px] leading-tight">{v.agreement[stance]}</span>
                    <span className="muted text-[12px]">{stance}</span>
                  </button>
                ))}
              </div>
              <p className="faint text-[12px] leading-snug">Agreement helps prioritise. Only evidence changes the level.</p>
            </section>

            {reviewer.enabled ? (
              <section>
                <div className="eyebrow mb-2">Your verdict</div>
                <div className="mb-1.5 grid grid-cols-2 gap-2">
                  {(
                    [
                      ["confirm", "Sign off as verified"],
                      ["explained", "Explained"],
                      ["disputed", "Disputed"],
                      ["reject", "False detection"],
                    ] as const
                  ).map(([verdict, text]) => (
                    <button
                      key={verdict}
                      className="btn"
                      onClick={() =>
                        act(() => post(`/api/sites/${site.id}/verdict`, { verdict }, reviewerHeaders(reviewer)), "Verdict saved.")
                      }
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <p className="faint text-[12px] leading-snug">
                  Sign-off counts only with 2+ independent sources, from someone who checked none of them.
                </p>
              </section>
            ) : null}

            {site.is_demo ? <p className="faint text-[12px]">Demo location: synthetic data, not a finding.</p> : null}
          </aside>
        </div>

        <SiteHistory siteId={site.id} version={version} />
      </div>

      {msg ? (
        <div className="fixed bottom-8 left-1/2 z-40 -translate-x-1/2 rounded-full bg-[#f4efe6] px-4 py-2 text-[#5a2318] shadow-lg">
          {msg}
          <button className="ml-3 opacity-60 hover:opacity-100" onClick={() => setMsg("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "25 Aug – 15 Sep 2017", or with both years when they differ. */
function dateRange(startIso: string, endIso: string): string {
  const [y1, m1, d1] = startIso.split("-").map(Number);
  const [y2, m2, d2] = endIso.split("-").map(Number);
  const start = `${d1} ${MONTHS[m1 - 1]}${y1 === y2 ? "" : ` ${y1}`}`;
  return `${start} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

const IMAGES = [
  { id: "before", label: "Before" },
  { id: "after", label: "After" },
  { id: "change", label: "Radar change" },
  { id: "burn", label: "Burn signal" },
] as const;
type ImageId = (typeof IMAGES)[number]["id"];

type SiteImages = {
  layers: Partial<Record<ImageId, { url: string }>>;
  optical: { before_window?: { start: string; end: string }; after_window?: { start: string; end: string } };
  notes: string[];
};

function SiteImagery({ siteId }: { siteId: string }) {
  const [state, setState] = useState<{ siteId: string; data?: SiteImages; error?: string } | null>(null);
  const [view, setView] = useState<ImageId | "compare">("after");
  const [split, setSplit] = useState(50);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sites/${siteId}/imagery`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        setState(res.ok ? { siteId, data } : { siteId, error: data.detail ?? "Couldn't load imagery." });
      })
      .catch(() => !cancelled && setState({ siteId, error: "Couldn't load imagery." }));
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const current = state?.siteId === siteId ? state : null;
  const layers = current?.data?.layers ?? {};
  const optical = current?.data?.optical;
  const caption =
    view === "before"
      ? optical?.before_window
      : view === "compare"
        ? undefined
        : optical?.after_window;

  return (
    <section>
      <div className="relative aspect-[16/10] max-h-[460px] w-full overflow-hidden rounded-xl bg-black/30">
        {current?.error ? (
          <p className="muted absolute inset-0 flex items-center justify-center p-6 text-center">{current.error}</p>
        ) : view === "compare" && layers.before && layers.after ? (
          <>
            {/* eslint-disable @next/next/no-img-element -- Earth Engine thumbnails, not static assets */}
            <img src={layers.after.url} alt="After" className="absolute inset-0 h-full w-full object-cover" />
            <img
              src={layers.before.url}
              alt="Before"
              className="absolute inset-0 h-full w-full object-cover"
              style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
            />
            {/* eslint-enable @next/next/no-img-element */}
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${split}%` }} />
            <span className="absolute left-3 top-3 rounded bg-black/50 px-2 py-0.5 text-[12px]">Before</span>
            <span className="absolute right-3 top-3 rounded bg-black/50 px-2 py-0.5 text-[12px]">After</span>
            <input
              aria-label="Compare before and after"
              type="range"
              min={0}
              max={100}
              value={split}
              onChange={(e) => setSplit(Number(e.target.value))}
              className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
            />
          </>
        ) : view !== "compare" && layers[view] ? (
          // eslint-disable-next-line @next/next/no-img-element -- Earth Engine thumbnails, not static assets
          <img src={layers[view]!.url} alt={view} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white/70" />
            <span className="muted">Loading imagery from Earth Engine…</span>
          </div>
        )}
        {caption ? (
          <span className="num absolute bottom-3 left-3 rounded bg-black/50 px-2 py-0.5 text-[12px]">
            {caption.start} → {caption.end}
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {[...IMAGES, { id: "compare" as const, label: "Compare" }].map((img) => (
          <button
            key={img.id}
            className={`btn px-3 py-1.5 ${view === img.id ? "btn-primary" : ""}`}
            onClick={() => setView(img.id)}
          >
            {img.label}
          </button>
        ))}
      </div>
      {current?.data?.notes.map((n) => (
        <p key={n} className="muted mt-2 text-[12px]">
          {n}
        </p>
      ))}
    </section>
  );
}

function useHotspots(investigationId: string | null): Site[] {
  const [state, setState] = useState<{ id: string; items: Site[] } | null>(null);
  useEffect(() => {
    if (!investigationId) return;
    let cancelled = false;
    fetch(`/api/sites/${investigationId}/hotspots`)
      .then((r) => (r.ok ? r.json() : []))
      .then((items) => !cancelled && setState({ id: investigationId, items }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [investigationId]);
  return state && state.id === investigationId ? state.items : [];
}

function HotspotList({ hotspots, onOpen }: { hotspots: Site[]; onOpen: (id: string) => void }) {
  return (
    <section>
      <h2 className="mb-1 text-[18px] font-semibold">Hot-spots in this area</h2>
      <p className="muted mb-3 text-[12px]">
        Radar change clusters found by scans, strongest first. Scan the area again to add more.
      </p>
      {hotspots.length === 0 ? (
        <p className="muted rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
          No hot-spots yet. Close this page and press “Scan for change”.
        </p>
      ) : (
        <ol className="divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)]">
          {hotspots.slice(0, 12).map((h, i) => {
            const feat = h.features ?? {};
            return (
              <li key={h.id}>
                <button className="flex w-full items-center gap-4 px-4 py-2.5 text-left hover:bg-white/5" onClick={() => onOpen(h.id)}>
                  <span className="faint num w-5 text-[12px]">{i + 1}</span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: levelInfo(h.verification.level).color }} />
                  <span className="num flex-1">change {h.pwtt_z?.toFixed(1) ?? "—"}</span>
                  <span className="muted num text-[12px]">
                    {feat.hotspot_area_ha != null ? `${Number(feat.hotspot_area_ha).toFixed(1)} ha` : ""}
                    {feat.p95_dnbr != null ? ` · burn ${Number(feat.p95_dnbr).toFixed(2)}` : ""}
                  </span>
                  <span className="muted">→</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {hotspots.length > 12 ? <p className="faint mt-2 text-[12px]">and {hotspots.length - 12} more on the map</p> : null}
    </section>
  );
}

function SiteHistory({ siteId, version }: { siteId: string; version: number }) {
  const [events, setEvents] = useState<{ at: string; summary: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sites/${siteId}/history`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => !cancelled && setEvents(data))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [siteId, version]);

  return (
    <section className="border-t border-[var(--line)] px-8 py-7 lg:px-10">
      <h2 className="mb-4 text-[18px] font-semibold">History</h2>
      {events.length === 0 ? (
        <p className="muted">No recorded activity yet.</p>
      ) : (
        <ol className="relative flex gap-8 overflow-x-auto pb-2">
          <span className="absolute left-0 right-0 top-[5px] h-px bg-[var(--line)]" aria-hidden />
          {events.map((e, i) => (
            <li key={i} className="relative w-48 shrink-0">
              <span className="relative mb-3 block h-[11px] w-[11px] rounded-full border-2 border-[var(--brick-bg)] bg-[#f4efe6]" />
              <div className="faint num text-[12px]">{e.at.slice(0, 16).replace("T", " ")}</div>
              <div className="leading-snug">{e.summary}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SatelliteReading({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const features = Object.entries(site.features ?? {}).filter(([, value]) => value != null);
  const seismic = site.seismic as {
    flag?: string;
    events?: { magnitude?: number; place?: string; modelled_mmi?: number | null }[];
  } | null;
  const [busy, setBusy] = useState(false);
  const top = seismic?.events?.[0];

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">Satellite reading</span>
        <span className="rounded-full bg-[#f5b34a]/15 px-2 py-0.5 text-[11px] text-[#f5b34a]">machine detection</span>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Radar change" value={site.pwtt_z != null ? site.pwtt_z.toFixed(1) : "—"} />
        <Stat label="Optical" value={site.optical_read === "cloud_gap" ? "cloud" : "clear"} />
        <Stat label="Calibration" value={site.calibration_status === "validated" ? "validated" : "provisional"} />
      </div>
      {site.calibration_status === "provisional" ? (
        <p className="mb-2 text-[12px] leading-snug text-[#ffd36a]">
          Burn readings are calibrated on Rakhine imagery; here they are provisional.
        </p>
      ) : null}
      {site.optical_read === "cloud_gap" ? (
        <p className="mb-2 text-[12px] leading-snug text-[#6ec8ff]">
          No clear optical image: radar change still ran, burn readings didn&apos;t.
        </p>
      ) : null}
      {features.length ? (
        <dl className="mb-3 divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
          {features.map(([k, value]) => (
            <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
              <dt className="muted">{FEATURE_LABELS[k] ?? k}</dt>
              <dd className="num">{Number(value).toFixed(k === "hotspot_area_ha" ? 1 : 2)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {seismic?.flag ? (
        <p className="leading-snug">
          <span className={seismic.flag === "possible_seismic" ? "text-[#e0b84a]" : "muted"}>
            {seismic.flag === "possible_seismic" ? "Possible earthquake cause" : "No damaging earthquake found"}
          </span>
          {top?.magnitude ? (
            <span className="muted">
              {" "}
              · M{top.magnitude} {top.place}
              {top.modelled_mmi ? ` · shaking MMI ${top.modelled_mmi} here` : ""}
            </span>
          ) : null}
        </p>
      ) : (
        <button
          className="btn w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await fetch("/api/seismic", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ site_ids: [site.id] }),
            });
            setBusy(false);
            onChanged();
          }}
        >
          {busy ? "Checking USGS…" : "Check for earthquakes"}
        </button>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.04] px-2.5 py-2">
      <div className="faint text-[11px]">{label}</div>
      <div className="num">{value}</div>
    </div>
  );
}

const MARK: Record<string, string> = { yes: "✓", no: "✗", unsure: "?" };

function EvidenceItem({
  item,
  others,
  reviewer,
  comments,
  handle,
  onHandle,
  onComment,
  onCheck,
}: {
  item: Evidence;
  others: Evidence[];
  reviewer: Reviewer;
  comments: Comment[];
  handle: string;
  onHandle: (h: string) => void;
  onComment: (body: string) => Promise<boolean>;
  onCheck: (check: Omit<EvidenceCheck, "reviewer" | "created_at">) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = item.check;
  return (
    <li className="rounded-lg border border-[var(--line)] p-3">
      <div className="faint mb-1 text-[11px]">
        {item.kind === "link" ? "Link" : item.kind === "prior_report" ? `Prior report · ${item.record?.source === "acled_sample" ? "sample" : "ACLED"}` : "Testimony"}
        {item.visibility === "reviewers" ? " · reviewers only" : ""}
        {item.is_demo ? " · demo" : ""}
      </div>
      {item.url ? (
        <a className="link break-all" href={item.url} target="_blank" rel="noopener noreferrer nofollow">
          {item.url}
        </a>
      ) : null}
      {item.body ? <p className="whitespace-pre-wrap leading-snug">{item.body}</p> : null}
      {!item.url && !item.body ? <p className="muted">Shared with reviewers only.</p> : null}
      <div className="mt-1.5 text-[12px]">
        {c ? (
          <span className="muted">
            Located {MARK[c.located]} · Dated {MARK[c.dated]} · {c.original}
            {c.shares_source_with.length ? ` · same source as ${c.shares_source_with.length} other` : ""}
            <span className="faint"> · checked by {c.reviewer}</span>
          </span>
        ) : (
          <span className="text-[#f5b34a]">Awaiting a reviewer check</span>
        )}
      </div>
      {reviewer.enabled ? (
        <button className="link mt-1.5 text-[12px]" onClick={() => setOpen(!open)}>
          {open ? "Cancel" : c ? "Re-check" : "Check this item"}
        </button>
      ) : null}
      {open ? (
        <CheckForm
          others={others}
          onSubmit={(check) => {
            onCheck(check);
            setOpen(false);
          }}
        />
      ) : null}
      <EvidenceComments comments={comments} handle={handle} onHandle={onHandle} onPost={onComment} />
    </li>
  );
}

function CheckForm({
  others,
  onSubmit,
}: {
  others: Evidence[];
  onSubmit: (check: Omit<EvidenceCheck, "reviewer" | "created_at">) => void;
}) {
  const [located, setLocated] = useState<"yes" | "no" | "unsure">("unsure");
  const [dated, setDated] = useState<"yes" | "no" | "unsure">("unsure");
  const [original, setOriginal] = useState<"original" | "repost" | "unsure">("unsure");
  const [shares, setShares] = useState<string[]>([]);
  const [note, setNote] = useState("");
  return (
    <div className="mt-3 space-y-2.5 border-t border-[var(--line)] pt-3 text-[12px]">
      <Choice label="Located against imagery?" value={located} options={["yes", "no", "unsure"]} onChange={setLocated} />
      <Choice label="Date fits the window?" value={dated} options={["yes", "no", "unsure"]} onChange={setDated} />
      <Choice label="Source" value={original} options={["original", "repost", "unsure"]} onChange={setOriginal} />
      {others.length ? (
        <div>
          <div className="muted mb-1">Same underlying source as:</div>
          {others.map((o) => (
            <label key={o.id} className="flex items-center gap-2 truncate">
              <input
                type="checkbox"
                checked={shares.includes(o.id)}
                onChange={(e) => setShares(e.target.checked ? [...shares, o.id] : shares.filter((s) => s !== o.id))}
              />
              <span className="truncate">{o.url ?? o.body ?? o.id}</span>
            </label>
          ))}
        </div>
      ) : null}
      <input
        className="field"
        placeholder="How you located and dated it"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="btn btn-primary w-full"
        onClick={() => onSubmit({ located, dated, original, shares_source_with: shares, note: note || null })}
      >
        Save check
      </button>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <div className="muted mb-1">{label}</div>
      <div className="seg">
        {options.map((o) => (
          <button key={o} aria-pressed={value === o} className="capitalize" onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddEvidence({
  handle,
  onHandle,
  onCancel,
  onSubmit,
}: {
  handle: string;
  onHandle: (h: string) => void;
  onCancel: () => void;
  onSubmit: (body: { kind: string; url?: string; body?: string; visibility: string; handle: string }) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<"link" | "testimony">("link");
  const [text, setText] = useState("");
  const [privateItem, setPrivateItem] = useState(false);
  return (
    <div className="mb-3 space-y-2.5 rounded-lg border border-[var(--line)] p-3">
      <div className="seg">
        {(["link", "testimony"] as const).map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === "link" ? "Link" : "Testimony"}
          </button>
        ))}
      </div>
      {kind === "link" ? (
        <input
          className="field"
          placeholder="https://… (post, video, article)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <textarea
          className="field h-24"
          placeholder="What did you see, and when?"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <input
        className="field"
        placeholder="Your handle (any name, never shown)"
        value={handle}
        onChange={(e) => onHandle(e.target.value)}
      />
      <label className="flex cursor-pointer items-start gap-2.5 text-[12px] leading-snug">
        <input
          type="checkbox"
          className="switch mt-0.5"
          checked={privateItem}
          onChange={(e) => setPrivateItem(e.target.checked)}
        />
        <span>Reviewers only: it still counts, but isn&apos;t published.</span>
      </label>
      <p className="faint text-[12px] leading-snug">
        Who submitted evidence is never shown. Don&apos;t include names or faces of people who could be put at risk.
      </p>
      <div className="flex gap-2">
        <button
          className="btn btn-primary flex-1"
          disabled={!text.trim()}
          onClick={async () => {
            const ok = await onSubmit({
              kind,
              ...(kind === "link" ? { url: text } : { body: text }),
              visibility: privateItem ? "reviewers" : "public",
              handle,
            });
            if (ok) setText("");
          }}
        >
          Submit
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
