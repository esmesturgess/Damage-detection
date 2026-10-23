"use client";

import { CHROME } from "@/lib/look";

import { useEffect, useState } from "react";
import Discussion, { EvidenceComments } from "./Discussion";
import FireDetections from "./FireDetections";
import PriorReports from "./PriorReports";
import { levelInfo, siteCentre, type Comment, type Evidence, type EvidenceCheck, type Site } from "@/lib/types";

const LADDER = ["detected", "corroborated", "verified"] as const;

const FEATURE_LABELS: Record<string, string> = {
  hotspot_area_ha: "Hot-spot area (ha)",
  max_t: "Peak radar change (T)",
  mean_dnbr: "Burn signal, average",
  p95_dnbr: "Burn signal, strongest 5%",
  nbr2_change: "Moisture loss",
  stable_water_fraction: "Standing water",
};

async function fetchEvidence(siteId: string): Promise<Evidence[]> {
  const res = await fetch(`/api/sites/${siteId}/evidence`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Request failed");
  return data;
}

export default function SiteOverlay({
  site,
  handle,
  onHandle,
  onClose,
  onChanged,
  parent,
  onOpenSite,
  onStartHere,
  onTour,
}: {
  site: Site;
  handle: string;
  onHandle: (h: string) => void;
  onClose: () => void;
  onChanged: () => void;
  /** The investigation a hot-spot belongs to, if any. */
  parent: Site | null;
  onOpenSite: (id: string) => void;
  onStartHere: (site: Site) => void;
  onTour: () => void;
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
    fetchEvidence(site.id).then(
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
  }, [site.id, version]);

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
  ];
  const stampNote =
    v.level === "verified"
      ? "signed off"
      : v.level === "ruled_out"
        ? v.ruled_out_reason === "explained"
          ? "non-hostile cause"
          : "false detection"
        : v.level === "disputed"
          ? "evidence on both sides"
        : `${v.independent_sources} of 2 independent sources`;
  const needHandle = () => setMsg("Pick a handle first (any name). You can set it in the discussion box.");

  return (
    <div
      className="fixed inset-0 z-30 bg-black/55 p-3 md:p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={site.name ?? "Site"}
    >
      <div className={`${CHROME} on-paper relative h-full overflow-auto border border-[var(--rule)] shadow-2xl`}>
        {/* Case-file tab strip */}
        <div className="num flex flex-wrap items-stretch border-b-2 border-[var(--rule)] text-[14px] tracking-[0.04em]">
          <span className="bg-[var(--accent)] px-5 py-3 font-bold uppercase text-[var(--paper)]">
            {isInvestigation ? "Investigation" : "Hot-spot"}
          </span>
          <span className="border-r border-[var(--rule)] px-5 py-3 uppercase">{site.region ?? "unassigned region"}</span>
          <span className="border-r border-[var(--rule)] px-5 py-3">
            {lat.toFixed(4)}°N {lon.toFixed(4)}°E
          </span>
          <span className="flex flex-1 gap-5 px-5 py-3">
            <button className="link" onClick={onTour} data-tour="tour-help">
              tour
            </button>
            <button
              className="link"
              onClick={() => {
                navigator.clipboard?.writeText(window.location.href).then(
                  () => setMsg("Link copied."),
                  () => setMsg(window.location.href),
                );
              }}
            >
              copy link
            </button>
          </span>
          <button
            className="w-14 border-l border-[var(--rule)] text-[26px] leading-none text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Case-file cover */}
        <header className="px-8 pb-7 pt-8 lg:px-12">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="max-w-3xl">
              <h1 className="display text-[44px] font-semibold leading-none lg:text-[60px]">{site.name ?? site.id}</h1>
              {site.name_local ? <p className="display mt-1.5 text-[26px] text-[var(--foreground)]">{site.name_local}</p> : null}
              {site.question ? (
                <>
                  <p className="display mt-5 text-[21px] italic leading-snug text-[var(--foreground)]">“{site.question}”</p>
                  {site.created_by ? <p className="muted mt-1 text-[14px]">asked by {site.created_by}</p> : null}
                </>
              ) : null}
            </div>
            <div className="stamp mt-2" title={v.why} data-tour="stamp">
              {info.label}
              <div className="text-[13px] font-normal tracking-[0.06em] normal-case">{stampNote}</div>
            </div>
          </div>
          <dl className="mt-7 grid grid-cols-2 border border-[var(--rule)] sm:grid-cols-4" data-tour="facts">
            {facts.map((fact) => (
              <div key={fact.label} className="border-[var(--rule)] px-4 py-3 [&:not(:last-child)]:border-r">
                <dt className="eyebrow">{fact.label}</dt>
                <dd className="mt-0.5 whitespace-nowrap text-[19px] font-medium leading-tight">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </header>

        <div className="grid gap-10 px-8 pb-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)] lg:px-12">
          {/* Left: what the satellite saw, then what people have found */}
          <div className="min-w-0 space-y-10">
            <div data-tour="imagery">
              <SiteImagery siteId={site.id} />
            </div>

            {isInvestigation ? <HotspotList hotspots={hotspots} onOpen={onOpenSite} /> : null}

            <div data-tour="prior">
            <PriorReports
              siteId={site.id}
              handle={handle}
              addedIds={evidence.flatMap((e) => (e.record ? [e.record.source_id] : []))}
              onAdd={(searchId, sourceId) =>
                act(
                  () => post(`/api/sites/${site.id}/prior-reports/evidence`, { search_id: searchId, source_id: sourceId, handle }),
                  "Added as evidence.",
                )
              }
              onSearched={() => setVersion((n) => n + 1)}
              onMessage={setMsg}
            />
            </div>

            <div data-tour="fires">
              <FireDetections
                siteId={site.id}
                handle={handle}
                onSearched={() => setVersion((n) => n + 1)}
                onMessage={setMsg}
              />
            </div>

            <section data-tour="evidence">
              <h2 className="section-title flex items-end justify-between">
                Evidence
                {adding ? null : (
                  <button className="btn btn-primary mb-1.5 px-3 py-1.5 font-sans text-[14px]" onClick={() => setAdding(true)}>
                    + Add evidence
                  </button>
                )}
              </h2>
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
                <p className="muted border border-dashed border-[var(--line)] px-4 py-6 text-center">
                  No evidence yet.
                </p>
              ) : null}
              <ul>
                {evidence.map((item, i) => (
                  <EvidenceItem
                    key={item.id}
                    n={i + 1}
                    item={item}
                    others={evidence.filter((e) => e.id !== item.id)}
                    comments={comments.filter((c) => c.evidence_id === item.id)}
                    handle={handle}
                    onHandle={onHandle}
                    onComment={(body) => act(() => post(`/api/sites/${site.id}/comments`, { body, handle, evidence_id: item.id }), "")}
                    onCheck={(check) =>
                      handle.trim()
                        ? act(() => post(`/api/evidence/${item.id}/check`, { ...check, handle }), "Check saved.")
                        : (needHandle(), Promise.resolve(false))
                    }
                  />
                ))}
              </ul>
            </section>

            <div data-tour="discussion">
            <Discussion
              comments={comments.filter((c) => c.evidence_id === null)}
              handle={handle}
              onHandle={onHandle}
              onPost={(body) => act(() => post(`/api/sites/${site.id}/comments`, { body, handle }), "")}
            />
            </div>
          </div>

          {/* Right rail: the verdict so far, readings and actions */}
          <aside className="space-y-8 lg:sticky lg:top-6 lg:self-start">
            {isInvestigation ? null : parent ? (
              <section className="border border-[var(--rule)] p-5" data-tour="parent">
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
              <section className="border border-[var(--rule)] p-5" data-tour="parent">
                <div className="eyebrow mb-3">Not part of an investigation</div>
                <button className="btn btn-primary w-full" onClick={() => onStartHere(site)}>
                  Start investigation here
                </button>
              </section>
            )}

            <section className="border border-[var(--rule)] p-5" data-tour="ladder">
              <div className="eyebrow mb-3">Verification</div>
              <div className="mb-2 flex gap-1.5">
                {LADDER.map((step) => {
                  const reached =
                    v.level !== "ruled_out" &&
                    v.level !== "disputed" &&
                    LADDER.indexOf(step) <= LADDER.indexOf(v.level as (typeof LADDER)[number]);
                  return (
                    <div key={step} className="flex-1">
                      <div className={`mb-1.5 h-2.5 border border-[var(--rule)] ${reached ? "bg-[var(--accent)]" : ""}`} />
                      <span className="text-[13.5px]">{levelInfo(step).label}</span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 leading-snug">{v.why}</p>
            </section>

            {isInvestigation ? null : <SatelliteReading site={site} />}

            <EarthquakeCheck site={site} onChanged={onChanged} />

            <section data-tour="verdict">
                <div className="eyebrow mb-2">Your verdict</div>
                <div className="mb-1.5 grid grid-cols-2 gap-2">
                  {(
                    [
                      ["confirm", "Sign off as verified"],
                      ["disputed", "Disputed"],
                      ["explained", "Rule out: non-hostile cause"],
                      ["reject", "Rule out: false detection"],
                    ] as const
                  ).map(([verdict, text]) => (
                    <button
                      key={verdict}
                      className="btn"
                      onClick={() =>
                        handle.trim()
                          ? act(() => post(`/api/sites/${site.id}/verdict`, { verdict, handle }), "Verdict saved.")
                          : needHandle()
                      }
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </section>

            {site.is_demo ? <p className="faint text-[13.5px]">Demo data</p> : null}
          </aside>
        </div>

        <div data-tour="history">
          <SiteHistory siteId={site.id} version={version} />
        </div>
      </div>

      {msg ? (
        <div className="fixed bottom-8 left-1/2 z-40 -translate-x-1/2 bg-[var(--accent)] px-4 py-2 text-[var(--paper)] shadow-lg">
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
      <div className="relative aspect-[16/10] max-h-[460px] w-full overflow-hidden bg-[#2b2a24]">
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
            <span className="absolute left-3 top-3 rounded bg-black/60 px-2 py-0.5 text-[13.5px] text-[#f1e9cf]">Before</span>
            <span className="absolute right-3 top-3 rounded bg-black/60 px-2 py-0.5 text-[13.5px] text-[#f1e9cf]">After</span>
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
          <span className="num absolute bottom-3 left-3 rounded bg-black/60 px-2 py-0.5 text-[13.5px] text-[#f1e9cf]">
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
        <p key={n} className="muted mt-2 text-[13.5px]">
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
    <section data-tour="hotspots">
      <h2 className="section-title">Radar hot-spots in this area</h2>
      {hotspots.length === 0 ? (
        <p className="muted border border-dashed border-[var(--line)] px-4 py-5 text-center">
          None yet. Scan this area from the map.
        </p>
      ) : (
        <ol className="divide-y divide-[var(--line)] border-b border-[var(--line)]">
          {hotspots.slice(0, 12).map((h, i) => {
            const feat = h.features ?? {};
            return (
              <li key={h.id}>
                <button className="flex w-full items-center gap-4 px-1 py-2.5 text-left hover:bg-[var(--accent-soft)]" onClick={() => onOpen(h.id)}>
                  <span className="num w-6 font-bold text-[var(--accent)]">{String(i + 1).padStart(2, "0")}</span>
                  <span className="flex-1">
                    Radar change <span className="num">{h.pwtt_z?.toFixed(1) ?? "—"}</span>
                    <span className="muted"> · {levelInfo(h.verification.level).label.toLowerCase()}</span>
                  </span>
                  <span className="muted num text-[13.5px]">
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
      {hotspots.length > 12 ? <p className="faint mt-2 text-[13.5px]">and {hotspots.length - 12} more on the map</p> : null}
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
    <section className="border-t-2 border-[var(--rule)] px-8 py-7 lg:px-12">
      <h2 className="section-title">History</h2>
      {events.length === 0 ? (
        <p className="muted">No recorded activity yet.</p>
      ) : (
        <ol className="relative flex gap-8 overflow-x-auto pb-2">
          <span className="absolute left-0 right-0 top-[5px] h-px bg-[var(--line)]" aria-hidden />
          {events.map((e, i) => (
            <li key={i} className="relative w-48 shrink-0">
              <span className="relative mb-3 block h-[11px] w-[11px] rounded-full border-2 border-[var(--paper)] bg-[var(--accent)]" />
              <div className="faint num text-[13.5px]">{e.at.slice(0, 16).replace("T", " ")}</div>
              <div className="leading-snug">{e.summary}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SatelliteReading({ site }: { site: Site }) {
  const features = Object.entries(site.features ?? {}).filter(([, value]) => value != null);
  return (
    <section data-tour="readings">
      <div className="eyebrow mb-2">Satellite readings</div>
      <dl className="divide-y divide-[var(--line)] border-y border-[var(--rule)]">
        <div className="flex justify-between gap-3 py-1.5">
          <dt className="muted">Radar change strength</dt>
          <dd className="num">{site.pwtt_z != null ? site.pwtt_z.toFixed(1) : "—"}</dd>
        </div>
        {features.map(([k, value]) => (
          <div key={k} className="flex justify-between gap-3 py-1.5">
            <dt className="muted">{FEATURE_LABELS[k] ?? k}</dt>
            <dd className="num">{Number(value).toFixed(k === "hotspot_area_ha" ? 1 : 2)}</dd>
          </div>
        ))}
      </dl>
      {site.optical_read === "cloud_gap" ? <p className="muted mt-2 text-[13.5px]">No clear optical image: no burn readings.</p> : null}
      {site.calibration_status === "provisional" ? (
        <p className="muted mt-2 text-[13.5px]">Burn readings provisional outside Rakhine.</p>
      ) : null}
    </section>
  );
}

/** USGS earthquakes near the site in its window. Not run on burn-positive sites, so shaking can't explain burning away. */
function EarthquakeCheck({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const seismic = site.seismic as {
    flag?: string;
    events?: { magnitude?: number; place?: string; modelled_mmi?: number | null }[];
  } | null;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const top = seismic?.events?.[0];

  return (
    <section data-tour="earthquakes">
      <div className="eyebrow mb-2">Earthquakes</div>
      {seismic?.flag ? (
        <p className="leading-snug">
          <span className={seismic.flag === "possible_seismic" ? "font-semibold" : "muted"}>
            {seismic.flag === "possible_seismic" ? "Damaging earthquake nearby" : "No damaging earthquake found"}
          </span>
          {top?.magnitude ? (
            <span className="muted">
              {" "}
              · M{top.magnitude} {top.place}
              {top.modelled_mmi ? ` · shaking MMI ${top.modelled_mmi} here` : ""}
            </span>
          ) : null}
        </p>
      ) : note ? (
        <p className="muted">{note}</p>
      ) : (
        <button
          className="btn w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await fetch("/api/seismic", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ site_ids: [site.id] }),
            });
            const [result] = res.ok ? await res.json() : [{ note: "Couldn't reach USGS. Try again." }];
            setBusy(false);
            if (result?.consulted === false) setNote("Not checked: the burn classifier marked this site burn-positive.");
            else if (result?.note && !result.consulted) setNote(result.note);
            onChanged();
          }}
        >
          {busy ? "Checking USGS…" : "Check for earthquakes"}
        </button>
      )}
    </section>
  );
}

const MARK: Record<string, string> = { yes: "✓", no: "✗", unsure: "?" };

function EvidenceItem({
  n,
  item,
  others,
  comments,
  handle,
  onHandle,
  onComment,
  onCheck,
}: {
  n: number;
  item: Evidence;
  others: Evidence[];
  comments: Comment[];
  handle: string;
  onHandle: (h: string) => void;
  onComment: (body: string) => Promise<boolean>;
  onCheck: (check: Omit<EvidenceCheck, "reviewer" | "created_at">) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = item.check;
  return (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] border-b border-[var(--line)] py-3">
      <span className="num pt-0.5 font-bold text-[var(--accent)]">E{n}</span>
      <div className="min-w-0">
      <div className="eyebrow mb-1 flex items-center justify-between gap-2">
        <span>
          {item.kind === "link" ? "Link" : item.kind === "prior_report" ? `Prior report · ${item.record?.source === "acled_sample" ? "sample" : "ACLED"}` : "Testimony"}
          {item.is_demo ? " · demo" : ""}
        </span>
        <span className={`border border-[var(--rule)] px-1.5 text-[13px] text-[var(--accent)] ${c ? "" : "border-dashed"}`}>
          {c ? "Checked" : "Unchecked"}
        </span>
      </div>
      {item.url ? (
        <a className="link break-all" href={item.url} target="_blank" rel="noopener noreferrer nofollow">
          {item.url}
        </a>
      ) : null}
      {item.body ? <p className="whitespace-pre-wrap leading-snug">{item.body}</p> : null}
      <div className="mt-1.5 text-[13.5px]">
        {c ? (
          <span className="muted">
            Located {MARK[c.located]} · Dated {MARK[c.dated]} · {c.original}
            {c.shares_source_with.length ? ` · same source as ${c.shares_source_with.length} other` : ""}
            <span className="faint"> · checked by {c.reviewer}</span>
          </span>
        ) : (
          <span className="muted">Awaiting a colleague&apos;s check</span>
        )}
      </div>
      <button className="link mt-1.5 text-[13.5px]" onClick={() => setOpen(!open)}>
        {open ? "Cancel" : c ? "Re-check" : "Check this item"}
      </button>
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
      </div>
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
    <div className="mt-3 space-y-2.5 border-t border-[var(--line)] pt-3 text-[13.5px]">
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
  return (
    <div className="mb-3 space-y-2.5 border border-[var(--line)] p-3">
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
        placeholder="Your handle"
        value={handle}
        onChange={(e) => onHandle(e.target.value)}
      />
      <p className="muted text-[13.5px] leading-snug">
        No names or faces of people at risk.
      </p>
      <div className="flex gap-2">
        <button
          className="btn btn-primary flex-1"
          disabled={!text.trim()}
          onClick={async () => {
            const ok = await onSubmit({
              kind,
              ...(kind === "link" ? { url: text } : { body: text }),
              visibility: "public",
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
