"use client";

import { useEffect, useState } from "react";

export type PlaceHit = {
  geonames_id: number;
  name: string;
  matched: string | null;
  alternates: string[];
  lat: number;
  lon: number;
  kind: string;
  admin1: string | null;
  admin2: string | null;
  country: string;
};

/** "20.82, 92.38" as a point, or null if the text is a place name. */
export function parseCoordinates(text: string): [number, number] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const [la, lo] = parts.map(Number);
  return Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [la, lo] : null;
}

/**
 * One box for a place name or coordinates. Names are looked up in the local
 * gazetteer as you type, tolerating misspellings; nothing leaves the server.
 */
export default function PlaceSearch({
  text,
  onText,
  onGo,
}: {
  text: string;
  onText: (text: string) => void;
  onGo: (lat: number, lon: number) => void;
}) {
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const query = text.trim();
  const isName = query.length >= 2 && !parseCoordinates(query);

  useEffect(() => {
    if (!isName || !open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("searching");
      try {
        const res = await fetch(`/api/places/search?q=${encodeURIComponent(query)}&limit=8`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.detail ?? "Place search failed.");
          setStatus("error");
          return;
        }
        setHits(data.results);
        setStatus("done");
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError("API unreachable. Start uvicorn on :8000.");
        setStatus("error");
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isName, open]);

  function pick(hit: PlaceHit) {
    onText(hit.name);
    setOpen(false);
    onGo(hit.lat, hit.lon);
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
          } else if (hits[0] && status === "done") pick(hits[0]);
        }}
      >
        <input
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-[var(--muted)]"
          placeholder="Search a place, or lat, lon"
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
        <div className="mt-1.5 text-[12px]">
          {status === "error" ? <p className="font-semibold">{error}</p> : null}
          {status === "done" && hits.length === 0 ? (
            <p className="muted">No place by that name or spelling in the gazetteer. Try another spelling.</p>
          ) : null}
          {hits.length && status !== "error" ? (
            <ul className={`max-h-56 overflow-auto ${status === "searching" ? "opacity-60" : ""}`}>
              {hits.map((h) => (
                <li key={h.geonames_id}>
                  <button
                    className="block w-full border-b border-[var(--line)] px-1 py-1.5 text-left hover:bg-[var(--accent-soft)]"
                    onClick={() => pick(h)}
                  >
                    <span className="text-[13px] font-semibold">{h.name}</span>
                    {h.matched ? <span className="muted"> · matched &ldquo;{h.matched}&rdquo;</span> : null}
                    <span className="muted block">
                      {[h.kind, h.admin2, h.admin1].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="faint mt-1 text-[11px]">Places from GeoNames (CC BY 4.0), searched on this server.</p>
        </div>
      ) : null}
    </div>
  );
}
