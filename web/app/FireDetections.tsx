"use client";

import { useEffect, useState } from "react";
import type { FireSearch } from "@/lib/types";

const RADII = [1, 2, 5] as const;
const SHOW = 40;

/**
 * NASA FIRMS active-fire detections near this site in its window, searched on request.
 * Raw detections only: a hot pixel doesn't say what burned.
 */
export default function FireDetections({
  siteId,
  handle,
  onSearched,
  onMessage,
}: {
  siteId: string;
  handle: string;
  onSearched: () => void;
  onMessage: (msg: string) => void;
}) {
  const [state, setState] = useState<{ siteId: string; search: FireSearch | null } | null>(null);
  const [radius, setRadius] = useState<number>(2);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sites/${siteId}/fires`)
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
      const res = await fetch(`/api/sites/${siteId}/fires`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ radius_km: radius, handle: handle.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Search failed");
      setState({ siteId, search: data });
      setAll(false);
      onSearched();
    } catch (err) {
      onMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="muted text-[13.5px]">within</span>
      <div className="seg">
        {RADII.map((km) => (
          <button key={km} aria-pressed={radius === km} onClick={() => setRadius(km)}>
            {km} km
          </button>
        ))}
      </div>
      <button className={`btn px-3 py-1.5 ${search ? "" : "btn-primary"}`} disabled={busy} onClick={run}>
        {busy ? "Searching FIRMS…" : search ? "Search again" : "Search FIRMS"}
      </button>
    </div>
  );

  const days = search ? new Set(search.detections.map((d) => d.acq_date)).size : 0;
  const shown = search ? (all ? search.detections : search.detections.slice(0, SHOW)) : [];

  return (
    <section>
      <h2 className="section-title">
        Fire detections <span className="num text-[14px] font-normal">NASA FIRMS</span>
      </h2>
      {search ? (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 bg-[var(--accent-soft)] px-3.5 py-2.5 text-[13.5px]">
            <span className="muted leading-snug">
              {search.count} detection{search.count === 1 ? "" : "s"} on {days} day{days === 1 ? "" : "s"} · within{" "}
              {search.searched.radius_km} km, {search.searched.dates[0]} – {search.searched.dates[1]} · {search.searched_by} ·{" "}
              {search.searched_at.slice(0, 16).replace("T", " ")}
            </span>
            {controls}
          </div>
          {search.truncated ? (
            <p className="mb-3 border border-[var(--accent)] px-3.5 py-2 text-[13.5px] font-semibold">
              Some detections left out. Search a smaller radius.
            </p>
          ) : null}
          {search.count === 0 ? (
            <p className="muted border border-dashed border-[var(--line)] px-4 py-6 text-center">
              No fire detections within {search.searched.radius_km} km in this window.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="num w-full border-collapse text-[13.5px]">
                <thead>
                  <tr className="eyebrow text-left">
                    <th className="py-1.5 pr-3 font-semibold">Date</th>
                    <th className="py-1.5 pr-3 font-semibold">UTC</th>
                    <th className="py-1.5 pr-3 font-semibold">Distance</th>
                    <th className="py-1.5 pr-3 font-semibold">Sensor</th>
                    <th className="py-1.5 pr-3 font-semibold">Confidence</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">FRP MW</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((d) => (
                    <tr key={`${d.source}${d.acq_date}${d.acq_time}${d.lat}${d.lon}`} className="border-t border-[var(--line)]">
                      <td className="py-1.5 pr-3">{d.acq_date}</td>
                      <td className="py-1.5 pr-3">
                        {d.acq_time}
                        {d.daynight ? <span className="muted"> {d.daynight}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3">{d.distance_km === 0 ? "inside" : `${d.distance_km} km`}</td>
                      <td className="py-1.5 pr-3" title={`${d.source}, ${d.pixel_m} m pixel`}>
                        {d.instrument}
                        {d.satellite ? <span className="muted"> {d.satellite}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3">
                        {d.confidence ?? "—"}
                        {d.type && d.type !== "presumed vegetation fire" ? <span className="muted"> · {d.type}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 text-right">{d.frp_mw ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {search.detections.length > SHOW && !all ? (
                <button className="link mt-2 text-[13.5px]" onClick={() => setAll(true)}>
                  Show all {search.detections.length}
                </button>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-dashed border-[var(--line)] px-4 py-4">
          <span className="muted">Not searched yet.</span>
          {controls}
        </div>
      )}
    </section>
  );
}
