"use client";

import { useEffect, useState } from "react";
import type { PriorReport, PriorReportSearch } from "@/lib/types";

const RADII = [5, 10, 25] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function day(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Documented incidents near this site, searched on request. Shown exactly as
 * the source recorded them, with its own precision wording; nothing here says
 * whether a report matches. An investigator can add one as evidence.
 */
export default function PriorReports({
  siteId,
  handle,
  addedIds,
  onAdd,
  onSearched,
  onMessage,
}: {
  siteId: string;
  handle: string;
  /** source_ids already added as evidence on this site */
  addedIds: string[];
  onAdd: (searchId: string, sourceId: string) => Promise<boolean>;
  onSearched: () => void;
  onMessage: (msg: string) => void;
}) {
  const [state, setState] = useState<{ siteId: string; search: PriorReportSearch | null } | null>(null);
  const [radius, setRadius] = useState<number>(10);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sites/${siteId}/prior-reports`)
      .then((r) => (r.ok ? r.json() : null))
      .then((search) => !cancelled && setState({ siteId, search }))
      .catch(() => !cancelled && setState({ siteId, search: null }));
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const search = state?.siteId === siteId ? state.search : null;

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${siteId}/prior-reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ radius_km: radius, handle: handle.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Search failed");
      setState({ siteId, search: data });
      onSearched();
    } catch (err) {
      onMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="muted text-[12px]">within</span>
      <div className="seg">
        {RADII.map((km) => (
          <button key={km} aria-pressed={radius === km} onClick={() => setRadius(km)}>
            {km} km
          </button>
        ))}
      </div>
      <button className={`btn px-3 py-1.5 ${search ? "" : "btn-primary"}`} disabled={busy} onClick={run}>
        {busy ? "Searching ACLED…" : search ? "Search again" : "Search ACLED"}
      </button>
    </div>
  );

  return (
    <section>
      <h2 className="mb-1 text-[18px] font-semibold">Prior reports</h2>
      <p className="muted mb-3 text-[12px] leading-snug">
        Incidents documented by ACLED near this place and time, as ACLED recorded them. Check how precise each
        location and date is before relying on the distance.
      </p>

      {search ? (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-black/20 px-3.5 py-2.5 text-[12px]">
            <span className="muted leading-snug">
              Searched within {search.searched.radius_km} km, {day(search.searched.dates_searched[0])} –{" "}
              {day(search.searched.dates_searched[1])} (your dates and a month either side) · {search.searched_by} ·{" "}
              {search.searched_at.slice(0, 16).replace("T", " ")}
            </span>
            {controls}
          </div>
          {search.searched.source === "acled_sample" ? (
            <p className="mb-3 rounded-lg border border-[#f5b34a]/50 px-3.5 py-2 text-[12px] text-[#f5b34a]">
              Sample data: these records are fictional, for trying the interface. They are not ACLED data.
            </p>
          ) : null}
          {search.truncated ? (
            <p className="mb-3 rounded-lg border border-[#f5b34a]/50 px-3.5 py-2 text-[12px] text-[#f5b34a]">
              Too many results: some were left out. Search a smaller radius.
            </p>
          ) : null}
          {search.reports.length === 0 ? (
            <p className="muted rounded-xl border border-dashed border-[var(--line)] px-4 py-6 text-center leading-snug">
              No ACLED reports within {search.searched.radius_km} km at this time.
              <span className="faint block text-[12px]">
                That isn&apos;t evidence nothing happened: ACLED only records what was reported.
              </span>
            </p>
          ) : (
            <ul className="space-y-3">
              {search.reports.map((report) => (
                <ReportCard
                  key={report.source_id}
                  report={report}
                  added={addedIds.includes(report.source_id)}
                  onAdd={() =>
                    handle.trim()
                      ? onAdd(search.search_id, report.source_id)
                      : (onMessage("Pick a handle first (any name; it's never shown). Use “Add evidence” to set one."),
                        Promise.resolve(false))
                  }
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-[var(--line)] px-4 py-4">
          <span className="muted">Not searched yet. The place and dates are sent to ACLED.</span>
          {controls}
        </div>
      )}
    </section>
  );
}

function ReportCard({ report, added, onAdd }: { report: PriorReport; added: boolean; onAdd: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const place = [report.location, ...report.admin].filter(Boolean).join(", ");
  const kind = [report.event_type, report.sub_event_type].filter(Boolean).join(" › ");
  return (
    <li className="rounded-xl border border-[var(--line)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <span className="text-[15px] font-semibold">{day(report.event_date)}</span>
          <span className="muted"> · {place || "unnamed place"}</span>
        </div>
        <span className="num text-[13px]">
          {report.distance_km === 0 ? "inside the area" : `${report.distance_km} km away`}
        </span>
      </div>
      {kind ? <div className="eyebrow mb-1.5 normal-case tracking-normal">{kind}</div> : null}
      {report.notes ? <p className="mb-3 leading-snug">{report.notes}</p> : null}

      <dl className="mb-3 grid gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-[auto_1fr]">
        <dt className="faint">Location</dt>
        <dd>{report.geo_precision_text ?? "precision not given"}</dd>
        <dt className="faint">Date</dt>
        <dd>
          {report.time_precision_text ?? "precision not given"}
          {report.days_outside_window > 0 ? (
            <span className="text-[#f5b34a]"> · {report.days_outside_window} days outside your dates</span>
          ) : null}
        </dd>
        {report.sources.length ? (
          <>
            <dt className="faint">Sources</dt>
            <dd>{report.sources.join("; ")}</dd>
          </>
        ) : null}
        {report.actors.length ? (
          <>
            <dt className="faint">Actors</dt>
            <dd>{report.actors.join("; ")}</dd>
          </>
        ) : null}
        {report.fatalities ? (
          <>
            <dt className="faint">Fatalities</dt>
            <dd className="num">{report.fatalities}</dd>
          </>
        ) : null}
      </dl>

      <div className="flex items-center justify-between gap-3">
        <span className="faint num text-[11px]">
          {report.source === "acled_sample" ? "Sample" : "ACLED"} {report.source_id}
        </span>
        {added ? (
          <span className="muted text-[12px]">Added as evidence</span>
        ) : (
          <button
            className="btn px-3 py-1.5"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onAdd();
              setBusy(false);
            }}
          >
            Add as evidence
          </button>
        )}
      </div>
    </li>
  );
}
