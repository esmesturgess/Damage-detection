"use client";

import { useEffect, useState } from "react";
import { levelInfo, type Evidence, type EvidenceCheck, type Reviewer, type Site } from "@/lib/types";

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
}: {
  site: Site;
  handle: string;
  reviewer: Reviewer;
  onHandle: (h: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [evidence, setEvidence] = useState<Evidence[]>([]);
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
    return () => {
      cancelled = true;
    };
  }, [site.id, reviewer, version]);

  async function act(fn: () => Promise<unknown>, done: string): Promise<boolean> {
    try {
      await fn();
      setMsg(done);
      setVersion((n) => n + 1);
      onChanged();
      return true;
    } catch (err) {
      setMsg((err as Error).message);
      return false;
    }
  }

  const [lon, lat] = site.geometry.coordinates;
  const window_ = (site.timestamps as { event_window?: string[] } | null)?.event_window;

  return (
    <div className="on-brick fixed inset-0 z-30 overflow-auto" role="dialog" aria-modal="true" aria-label={site.name ?? "Site"}>
      <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--brick-bg)] px-8 py-4">
        <div className="mx-auto flex max-w-4xl items-center gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[20px] font-semibold tracking-tight">{site.name ?? site.id}</h1>
            <p className="muted num text-[12px]">
              {lat.toFixed(4)}, {lon.toFixed(4)}
              {window_ ? ` · ${window_[0]} → ${window_[1]}` : ""}
              {" · "}
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
            </p>
          </div>
          <span className="flex items-center gap-2 rounded-full bg-black/25 px-3 py-1">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: info.color }} />
            {info.label}
          </span>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-full text-[26px] leading-none hover:bg-white/10"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-10 px-8 py-8">
      <SiteImagery siteId={site.id} />

      <section className="grid gap-6 md:grid-cols-2">
      <div>
      <div className="eyebrow mb-2">Verification</div>
      {/* Level */}
      <div className="mb-6 rounded-lg border p-3.5" style={{ borderColor: info.color + "55", background: info.color + "10" }}>
        <div className="mb-1 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: info.color }} />
          <span className="font-semibold" style={{ color: info.color }}>
            {info.label}
          </span>
        </div>
        <p className="muted mb-3 leading-snug">{v.why}</p>
        {v.level === "explained" || v.level === "disputed" ? null : (
          <div className="mb-2 flex gap-1">
            {LADDER.map((step) => {
              const reached = LADDER.indexOf(step) <= LADDER.indexOf(v.level as (typeof LADDER)[number]);
              return (
                <div key={step} className="flex-1">
                  <div
                    className="mb-1 h-1 rounded-full"
                    style={{ background: reached ? levelInfo(step).color : "rgba(255,255,255,0.1)" }}
                  />
                  <span className={`text-[11px] ${reached ? "" : "faint"}`}>{levelInfo(step).label}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="faint text-[12px]">
          {v.evidence_count} evidence item{v.evidence_count === 1 ? "" : "s"} · {v.independent_sources} independent
          source{v.independent_sources === 1 ? "" : "s"}
        </div>
      </div>

      </div>
      <SatelliteReading site={site} onChanged={onChanged} />
      </section>

      {/* Evidence */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">Evidence</span>
          {adding ? null : (
            <button className="btn px-2.5 py-1 text-[12px]" onClick={() => setAdding(true)}>
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
              const ok = await act(() => post(`/api/sites/${site.id}/evidence`, body), "Evidence added. A reviewer will check it.");
              if (ok) setAdding(false);
              return ok;
            }}
          />
        ) : null}
        {evidence.length === 0 && !adding ? <p className="muted">No evidence yet.</p> : null}
        <ul className="space-y-2">
          {evidence.map((item) => (
            <EvidenceItem
              key={item.id}
              item={item}
              others={evidence.filter((e) => e.id !== item.id)}
              reviewer={reviewer}
              onCheck={(check) =>
                act(() => post(`/api/evidence/${item.id}/check`, check, reviewerHeaders(reviewer)), "Check saved.")
              }
            />
          ))}
        </ul>
      </section>

      {/* Agreement */}
      <section className="mb-6">
        <div className="eyebrow mb-2">Do you agree?</div>
        <div className="mb-1.5 grid grid-cols-3 gap-2">
          {(["agree", "disagree", "unsure"] as const).map((stance) => (
            <button
              key={stance}
              className="btn capitalize"
              onClick={() =>
                handle.trim()
                  ? act(() => post(`/api/sites/${site.id}/assessment`, { handle, stance }), "Thanks, noted.")
                  : setMsg("Pick a handle first (any name; it's never shown). Use “Add evidence” to set one.")
              }
            >
              {stance}
              <span className="num muted">{v.agreement[stance]}</span>
            </button>
          ))}
        </div>
        <p className="faint text-[12px] leading-snug">Agreement helps reviewers prioritise. Only evidence changes the level.</p>
      </section>

      {reviewer.enabled ? (
        <section className="mb-6">
          <div className="eyebrow mb-2">Reviewer verdict</div>
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
            Sign-off counts only with 2+ independent sources, from a reviewer who checked none of them.
          </p>
        </section>
      ) : null}

      <section>
        <div className="eyebrow mb-2">Discussion</div>
        <p className="muted rounded-lg border border-dashed border-[var(--line)] px-4 py-6 text-center">
          Comments on each evidence item and an open thread for this site are coming next.
        </p>
      </section>

      <SiteHistory siteId={site.id} version={version} />

      {site.is_demo ? <p className="faint text-[12px]">Demo location: synthetic data, not a finding.</p> : null}
      </main>

      {msg ? (
        <div className="fixed bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-full bg-[#f4efe6] px-4 py-2 text-[#5a2318] shadow-lg">
          {msg}
          <button className="ml-3 opacity-60 hover:opacity-100" onClick={() => setMsg("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

const IMAGES = [
  { id: "before", label: "Before" },
  { id: "after", label: "After" },
  { id: "change", label: "After + radar change" },
  { id: "burn", label: "After + burn signal" },
] as const;

type SiteImages = {
  layers: Partial<Record<(typeof IMAGES)[number]["id"], { url: string }>>;
  optical: { before_window?: { start: string; end: string }; after_window?: { start: string; end: string } };
  notes: string[];
};

function SiteImagery({ siteId }: { siteId: string }) {
  const [state, setState] = useState<{ siteId: string; data?: SiteImages; error?: string } | null>(null);

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
  return (
    <section>
      <div className="eyebrow mb-2">Imagery</div>
      {current?.error ? <p className="muted">{current.error}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        {IMAGES.map((img) => {
          const url = current?.data?.layers[img.id]?.url;
          const w = img.id === "before" ? current?.data?.optical.before_window : current?.data?.optical.after_window;
          return (
            <figure key={img.id}>
              <div className="aspect-square overflow-hidden rounded-lg bg-black/25">
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Earth Engine thumbnails, not static assets
                  <img src={url} alt={img.label} className="h-full w-full object-cover" />
                ) : current?.error ? null : (
                  <div className="flex h-full items-center justify-center">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-white/60" />
                  </div>
                )}
              </div>
              <figcaption className="mt-1.5 flex justify-between text-[12px]">
                <span>{img.label}</span>
                {w ? <span className="faint num">{w.start} → {w.end}</span> : null}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {current?.data?.notes.map((n) => (
        <p key={n} className="muted mt-2 text-[12px]">
          {n}
        </p>
      ))}
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
    <section>
      <div className="eyebrow mb-2">History</div>
      {events.length === 0 ? <p className="muted">No recorded activity yet.</p> : null}
      <ol className="space-y-1.5">
        {events.map((e, i) => (
          <li key={i} className="flex gap-4">
            <span className="faint num w-36 shrink-0 text-[12px]">{e.at.slice(0, 16).replace("T", " ")}</span>
            <span>{e.summary}</span>
          </li>
        ))}
      </ol>
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
  onCheck,
}: {
  item: Evidence;
  others: Evidence[];
  reviewer: Reviewer;
  onCheck: (check: Omit<EvidenceCheck, "reviewer" | "created_at">) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = item.check;
  return (
    <li className="rounded-lg border border-[var(--line)] p-3">
      <div className="faint mb-1 text-[11px]">
        {item.kind === "link" ? "Link" : "Testimony"}
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
