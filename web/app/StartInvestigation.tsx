"use client";

import { useEffect, useState } from "react";
import { CHROME } from "@/lib/look";
import { levelInfo, type Level } from "@/lib/types";

type Window = { start: string; end: string };
type Overlap = { id: string; name: string; name_local: string | null; event_window: string[]; level: Level };

function centreAndArea(aoi: GeoJSON.Polygon): { lat: number; lon: number; km2: number } {
  const ring = aoi.coordinates[0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  const lat = (Math.min(...ys) + Math.max(...ys)) / 2;
  const lon = (Math.min(...xs) + Math.max(...xs)) / 2;
  const km2 =
    (Math.max(...xs) - Math.min(...xs)) * 111.32 * Math.cos((lat * Math.PI) / 180) * (Math.max(...ys) - Math.min(...ys)) * 110.57;
  return { lat, lon, km2 };
}

export default function StartInvestigation({
  aoi,
  win,
  author,
  onClose,
  onOpen,
}: {
  aoi: GeoJSON.Polygon;
  win: { event: Window; baseline: Window };
  author: string;
  onClose: () => void;
  onOpen: (siteId: string, created: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [nameLocal, setNameLocal] = useState("");
  const [context, setContext] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [overlaps, setOverlaps] = useState<Overlap[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { lat, lon, km2 } = centreAndArea(aoi);
  const { start: evStart, end: evEnd } = win.event;

  // Suggest the place name (English and local) and look for overlapping cases.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/places/name?lat=${lat}&lon=${lon}&area_km2=${km2}`)
      .then((r) => r.json())
      .then((p) => {
        if (cancelled) return;
        setName((n) => n || p.name_en || "");
        setNameLocal((n) => n || p.name_local || "");
        setContext(p.context ?? null);
      })
      .catch(() => {});
    fetch("/api/investigations/overlaps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aoi_geojson: aoi, event_window: { start: evStart, end: evEnd } }),
    })
      .then((r) => r.json())
      .then((o) => !cancelled && setOverlaps(Array.isArray(o) ? o : []))
      .catch(() => !cancelled && setOverlaps([]));
    return () => {
      cancelled = true;
    };
  }, [aoi, lat, lon, km2, evStart, evEnd]);

  async function start() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/investigations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aoi_geojson: aoi,
        baseline_window: win.baseline,
        event_window: win.event,
        name,
        name_local: nameLocal || null,
        question: question || null,
        created_by: author || null,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.detail ?? "Couldn't start the investigation.");
    onOpen(data.site_id, true);
  }

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${CHROME} panel on-paper w-full max-w-xl p-7`}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="display mb-1 text-[30px] font-semibold leading-none">New investigation</h2>
            <p className="muted num text-[14px]">
              {win.event.start} → {win.event.end} · {km2.toFixed(0)} km² around {lat.toFixed(3)}°N {lon.toFixed(3)}°E
            </p>
          </div>
          <button className="text-[22px] leading-none opacity-70 hover:opacity-100" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="muted mb-1 block text-[13.5px]">Place (English)</span>
            <input className="field" value={name} placeholder="Looking up…" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="muted mb-1 block text-[13.5px]">Place (local name)</span>
            <input className="field" value={nameLocal} onChange={(e) => setNameLocal(e.target.value)} />
          </label>
        </div>
        {context ? <p className="faint -mt-2 mb-4 text-[13.5px]">{context} · from OpenStreetMap</p> : null}

        <label className="mb-5 block">
          <span className="muted mb-1 block text-[13.5px]">Question (optional)</span>
          <textarea
            className="field h-20"
            placeholder="e.g. Were villages east of town burned in late August?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>

        {overlaps && overlaps.length ? (
          <div className="mb-5 border border-[var(--rule)] p-3.5">
            <p className="mb-2 font-semibold">
              {overlaps.length === 1 ? "An open investigation overlaps" : `${overlaps.length} open investigations overlap`}{" "}
              this area and these dates
            </p>
            <ul className="space-y-1.5">
              {overlaps.map((o) => (
                <li key={o.id} className="flex items-center gap-3">
                  <span className="eyebrow w-24 shrink-0">{levelInfo(o.level).label}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {o.name}
                    {o.name_local ? <span className="muted"> · {o.name_local}</span> : null}
                    <span className="faint num text-[13.5px]"> {o.event_window[0]} → {o.event_window[1]}</span>
                  </span>
                  <button className="btn px-3 py-1" onClick={() => onOpen(o.id, false)}>
                    Join
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <p className="mb-3 text-[var(--accent)]">{error}</p> : null}
        <div className="flex gap-2">
          <button className="btn btn-primary flex-1" disabled={busy || !name.trim()} onClick={start}>
            {overlaps && overlaps.length ? "Start a new one anyway" : "Start investigation"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
