"use client";

import { useEffect, useState } from "react";

type Place = { name: string; kind: string; within: string; lat: number; lon: number; osm: string };

/** "20.82, 92.38" as a point, or null if the text is a place name. */
function parseCoordinates(text: string): [number, number] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const [la, lo] = parts.map(Number);
  return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [la, lo] : null;
}

/**
 * One box for a place name or coordinates. Names are looked up as you type (OpenStreetMap via
 * Photon), favouring places near where the map is looking.
 */
export default function PlaceSearch({
  text,
  onText,
  onGo,
  near,
}: {
  text: string;
  onText: (text: string) => void;
  onGo: (lat: number, lon: number) => void;
  near: () => { lat: number; lon: number } | null;
}) {
  const [hits, setHits] = useState<Place[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const query = text.trim();
  const isName = query.length >= 3 && !parseCoordinates(query) && /[^\d\s.,+-]/.test(query);

  useEffect(() => {
    if (!open || !isName) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const c = near();
      const params = new URLSearchParams({ q: query, ...(c ? { lat: String(c.lat), lon: String(c.lon) } : {}) });
      try {
        const res = await fetch(`/api/places/search?${params}`, { signal: controller.signal });
        const data = await res.json();
        setError(res.ok ? "" : (data.detail ?? "Place search failed."));
        setHits(res.ok ? data.results : []);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("API unreachable.");
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isName, open, near]);

  function pick(place: Place) {
    onText(place.name);
    setOpen(false);
    onGo(place.lat, place.lon);
  }

  return (
    <div>
      <form
        className="flex border border-[var(--rule)]"
        onSubmit={(e) => {
          e.preventDefault();
          const point = parseCoordinates(query);
          if (point) {
            setOpen(false);
            onGo(point[0], point[1]);
          } else if (hits[0]) pick(hits[0]);
        }}
      >
        <input
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[14px] outline-none placeholder:text-[var(--muted)]"
          placeholder="Search a place, or latitude, longitude"
          aria-label="Search a place or enter coordinates"
          value={text}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        />
        <button className="border-l border-[var(--rule)] px-2.5" aria-label="Go">
          →
        </button>
      </form>
      {open && isName ? (
        <div className="mt-1.5 text-[13.5px]">
          {error ? <p className="font-semibold">{error}</p> : null}
          <ul className="max-h-52 overflow-auto">
            {hits.map((h) => (
              <li key={h.osm}>
                <button
                  className="block w-full border-b border-[var(--line)] px-1 py-1.5 text-left hover:bg-[var(--accent-soft)]"
                  onClick={() => pick(h)}
                >
                  <span className="text-[14px] font-semibold">{h.name}</span>
                  <span className="muted"> · {h.kind}</span>
                  {h.within ? <span className="muted block">{h.within}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <p className="faint mt-1 text-[13px]">Photon · © OpenStreetMap contributors</p>
        </div>
      ) : null}
    </div>
  );
}
