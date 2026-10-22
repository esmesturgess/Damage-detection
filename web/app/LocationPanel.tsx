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

export default function LocationPanel({
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

  return (
    <aside className="panel absolute bottom-4 right-4 top-[104px] w-[24rem] overflow-auto p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-semibold leading-snug">{site.name ?? site.id}</h2>
        <button className="muted -mr-1 -mt-1 px-1 text-[18px] leading-none hover:text-white" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

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

      <SatelliteReading site={site} onChanged={onChanged} />

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

      {msg ? <p className="rounded-lg bg-[var(--accent)]/10 px-3 py-2 text-[var(--accent)]">{msg}</p> : null}
      {site.is_demo ? <p className="faint mt-3 text-[12px]">Demo location: synthetic data, not a finding.</p> : null}
    </aside>
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
        <a className="break-all text-[#7cc8ff] hover:underline" href={item.url} target="_blank" rel="noopener noreferrer nofollow">
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
        <button className="mt-1.5 text-[12px] text-[var(--accent)] hover:underline" onClick={() => setOpen(!open)}>
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
