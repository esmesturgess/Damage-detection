"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Map,
  GeoJSONSource,
  setWorkerUrl,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import { LEVELS, type Level, type Reviewer, type Site } from "@/lib/types";
import AreaLayers, { AREA_LAYERS, type AreaLayerId, type Analysis } from "./AreaLayers";
import LocationPanel from "./LocationPanel";
import TimeBar, { label, monthIndex, windows } from "./TimeBar";

// MapLibre 6 resolves its worker relative to import.meta.url, which breaks once
// Next bundles it. The predev/prebuild scripts copy the worker into public/.
setWorkerUrl("/maplibre-gl-worker.mjs");

const RAKHINE: [number, number] = [93.8, 20.8];
const API_DOWN = "API unreachable. Start uvicorn on :8000.";
const LEVEL_COLOR = Object.fromEntries(LEVELS.map((l) => [l.id, l.color])) as Record<Level, string>;
const SITE_BOX_KM = 3;

// Globe: EOX Sentinel-2 cloudless 2016 (CC BY 4.0; later years need a
// subscription), under Carto's keyless vector labels and borders. Imagery
// for the selected dates comes from Earth Engine, only for an analysed area.
const CARTO_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const EOX_2016 = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
const LABELS_ANCHOR = "labels-anchor";

function withImagery(carto: StyleSpecification): StyleSpecification {
  const overlays = carto.layers.filter(
    (l) => l.type === "symbol" || (l.type === "line" && l.id.includes("boundary")),
  );
  return {
    ...carto,
    sources: {
      ...carto.sources,
      eox: {
        type: "raster",
        tiles: [EOX_2016],
        tileSize: 256,
        maxzoom: 15,
        attribution:
          '<a href="https://s2maps.eu">Sentinel-2 cloudless 2016</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016)',
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#050506" } },
      { id: "eox", type: "raster", source: "eox" },
      // Empty marker layer: area imagery is inserted below it, so labels stay on top.
      { id: LABELS_ANCHOR, type: "background", paint: { "background-opacity": 0 } },
      ...overlays,
    ],
  };
}

async function fetchSites(): Promise<Site[]> {
  const res = await fetch("/api/sites");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function coords(site: Site): [number, number] | null {
  const c = site.geometry?.coordinates;
  if (!c || c.length < 2) return null;
  return [c[0], c[1]];
}

function boxAround(lat: number, lon: number, sizeKm: number): GeoJSON.Polygon {
  const dLat = sizeKm / 2 / 110.57;
  const dLon = sizeKm / 2 / (111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    type: "Polygon",
    coordinates: [[
      [lon - dLon, lat - dLat],
      [lon + dLon, lat - dLat],
      [lon + dLon, lat + dLat],
      [lon - dLon, lat + dLat],
      [lon - dLon, lat - dLat],
    ]],
  };
}

export default function MapApp() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetected, setShowDetected] = useState(false);
  const [range, setRange] = useState<[number, number]>([monthIndex(2017, 7), monthIndex(2017, 8)]);
  const [probeMode, setProbeMode] = useState<"draw" | "coords">("draw");
  const [lat, setLat] = useState("20.82");
  const [lon, setLon] = useState("92.38");
  const [sizeKm, setSizeKm] = useState("5");
  const [drawing, setDrawing] = useState(false);
  const drawStart = useRef<[number, number] | null>(null);
  const [aoi, setAoi] = useState<GeoJSON.Polygon | null>(null);
  const [probeMsg, setProbeMsg] = useState("");
  const [handle, setHandle] = useState("");
  const [reviewer, setReviewer] = useState<Reviewer>({ name: "", token: "", enabled: false });
  const [analysis, setAnalysis] = useState<Analysis>({ status: "idle" });
  const [layerOn, setLayerOn] = useState<Record<AreaLayerId, boolean>>({
    before: false,
    after: true,
    burn: false,
    change: true,
  });
  const [opacity, setOpacity] = useState(0.85);
  const shownLayers = useRef<Partial<Record<AreaLayerId, string>>>({});

  const selected = sites.find((s) => s.id === selectedId) ?? null;
  const win = windows(range[0], range[1]);
  const winKey = JSON.stringify(win);

  const loadSites = useCallback(async () => {
    try {
      setSites(await fetchSites());
      setError(null);
    } catch {
      setError(API_DOWN);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSites().then(
      (s) => {
        if (cancelled) return;
        setSites(s);
        setError(null);
      },
      () => {
        if (!cancelled) setError(API_DOWN);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let created: Map | null = null;
    // Fetch Carto's style first so the map starts with the final style; a
    // style swap after load would wipe the layers added below.
    fetch(CARTO_STYLE)
      .then((res) => res.json() as Promise<StyleSpecification>)
      .then((carto) => {
        if (cancelled || !container.current) return;
        const map = new Map({
          container: container.current,
          style: withImagery(carto),
          center: RAKHINE,
          zoom: 4.6,
          attributionControl: { compact: true },
        });
        created = map;
        mapRef.current = map;
        map.on("load", () => {
          try {
            map.setProjection({ type: "globe" });
          } catch {
            /* older maplibre */
          }
          map.addSource("sites", { type: "geojson", data: emptyFc() });
          map.addSource("aoi", { type: "geojson", data: emptyFc() });
          map.addLayer({
            id: "aoi-fill",
            type: "fill",
            source: "aoi",
            paint: { "fill-color": "#d4ff4a", "fill-opacity": 0.08 },
          });
          map.addLayer({
            id: "aoi-line",
            type: "line",
            source: "aoi",
            paint: { "line-color": "#d4ff4a", "line-width": 1.2, "line-dasharray": [2, 1] },
          });
          // One circle per location, coloured by verification level. Detected is
          // an outline only: a machine signal, not a claim.
          map.addLayer({
            id: "locations",
            type: "circle",
            source: "sites",
            paint: {
              "circle-radius": ["match", ["get", "level"], "verified", 8, "detected", 5, 7],
              "circle-color": [
                "match",
                ["get", "level"],
                "detected",
                "rgba(0,0,0,0)",
                ["get", "color"],
              ],
              "circle-stroke-width": ["match", ["get", "level"], "detected", 1.5, "disputed", 2.5, 1],
              "circle-stroke-color": [
                "match",
                ["get", "level"],
                "detected",
                LEVEL_COLOR.detected,
                "disputed",
                LEVEL_COLOR.explained,
                "#050506",
              ],
            },
          });
          map.on("mouseenter", "locations", () => (map.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", "locations", () => (map.getCanvas().style.cursor = ""));
          // Sites usually arrive before the style finishes loading; effects below
          // wait on this so the data and handlers land on layers that exist.
          setMapReady(true);
        });

      })
      .catch(() => setError("Couldn't load the base map."));

    return () => {
      cancelled = true;
      created?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const handler = (ev: MapLayerMouseEvent) => {
      const feature = ev.features?.[0];
      const id = feature?.properties?.id as string | undefined;
      if (!id || feature?.geometry.type !== "Point") return;
      setSelectedId(id);
      const [lon, lat] = feature.geometry.coordinates;
      setAoi(boxAround(lat, lon, SITE_BOX_KM));
    };
    map.on("click", "locations", handler);
    return () => {
      map.off("click", "locations", handler);
    };
  }, [mapReady]);

  const fc = useMemo(() => toFeatureCollection(sites), [sites]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource("sites") as GeoJSONSource | undefined;
    src?.setData(fc);
  }, [fc, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("locations")) return;
    map.setFilter("locations", showDetected ? null : ["!=", ["get", "level"], "detected"]);
  }, [showDetected, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource("aoi") as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      aoi
        ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: aoi }] }
        : emptyFc(),
    );
  }, [aoi, mapReady]);

  // Earth Engine layers for the analysed area, refetched when the area or
  // the time window changes (debounced so dragging the time bar is cheap).
  useEffect(() => {
    if (!aoi) return;
    const w = JSON.parse(winKey) as ReturnType<typeof windows>;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setAnalysis({ status: "loading" });
      try {
        const res = await fetch("/api/imagery/analysis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aoi_geojson: aoi, baseline_window: w.baseline, event_window: w.event }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setAnalysis({ status: "error", error: data.detail ?? "Couldn't load layers." });
        else setAnalysis({ status: "ready", data });
      } catch {
        if (!cancelled) setAnalysis({ status: "error", error: API_DOWN });
      }
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [aoi, winKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const urls = analysis.status === "ready" && aoi ? analysis.data.layers : {};
    // Bottom to top, all beneath the place-name labels.
    for (const id of AREA_LAYERS) {
      const layerId = `area-${id}`;
      const url = urls[id]?.url;
      if (shownLayers.current[id] !== url) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(layerId)) map.removeSource(layerId);
        if (url) {
          map.addSource(layerId, { type: "raster", tiles: [url], tileSize: 256 });
          map.addLayer({ id: layerId, type: "raster", source: layerId }, LABELS_ANCHOR);
        }
        shownLayers.current[id] = url;
      }
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", layerOn[id] ? "visible" : "none");
        map.setPaintProperty(layerId, "raster-opacity", opacity);
      }
    }
  }, [analysis, aoi, layerOn, opacity, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (drawing) map.dragPan.disable();
    else map.dragPan.enable();
    const onDown = (e: MapMouseEvent) => {
      if (!drawing) return;
      drawStart.current = [e.lngLat.lng, e.lngLat.lat];
    };
    const onUp = (e: MapMouseEvent) => {
      if (!drawing || !drawStart.current) return;
      const [x0, y0] = drawStart.current;
      const x1 = e.lngLat.lng;
      const y1 = e.lngLat.lat;
      const west = Math.min(x0, x1);
      const east = Math.max(x0, x1);
      const south = Math.min(y0, y1);
      const north = Math.max(y0, y1);
      setAoi({
        type: "Polygon",
        coordinates: [[
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ]],
      });
      setDrawing(false);
      drawStart.current = null;
    };
    map.on("mousedown", onDown);
    map.on("mouseup", onUp);
    return () => {
      map.off("mousedown", onDown);
      map.off("mouseup", onUp);
    };
  }, [drawing]);

  function applyCoordinates() {
    const la = Number(lat);
    const lo = Number(lon);
    const km = Number(sizeKm);
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180 && km > 0 && km <= 50)) {
      setProbeMsg("Latitude −90…90, longitude −180…180, box 0–50 km.");
      return;
    }
    const box = boxAround(la, lo, km);
    setAoi(box);
    setProbeMsg("");
    const [sw, , ne] = box.coordinates[0];
    mapRef.current?.fitBounds([sw as [number, number], ne as [number, number]], { padding: 160, maxZoom: 12 });
  }

  async function runCoverage() {
    if (!aoi) return setProbeMsg("Draw a box or enter coordinates first.");
    setProbeMsg("Checking coverage…");
    const res = await fetch("/api/coverage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aoi_geojson: aoi, start_date: win.event.start, end_date: win.event.end }),
    });
    const data = await res.json();
    if (!res.ok) return setProbeMsg(data.detail ?? "Coverage check failed.");
    setProbeMsg(
      data.live_gee
        ? `Radar scenes: ${data.sentinel1?.scene_count} · optical: ${data.sentinel2?.scene_count}` +
            (data.sentinel2?.mean_cloud_fraction != null
              ? ` (${Math.round(data.sentinel2.mean_cloud_fraction * 100)}% cloud)`
              : "") +
            ` · ${data.enough_for_pwtt ? "enough to scan" : "too few radar scenes"}`
        : "Earth Engine is offline here, so this is an estimate. " + (data.note ?? ""),
    );
  }

  async function runScan() {
    if (!aoi) return setProbeMsg("Draw a box or enter coordinates first.");
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aoi_geojson: aoi, baseline_window: win.baseline, event_window: win.event, z_threshold: 3.0 }),
    });
    const data = await res.json();
    if (!data.job_id) return setProbeMsg(data.detail ?? "Scan failed.");
    const period = `${label(range[0])} → ${label(range[1])}`;
    setProbeMsg(`Scanning ${period} in Earth Engine… usually under a minute.`);

    // The worker runs the scan; poll until it finishes (identical scans reuse the earlier job).
    for (let i = 0; i < 120; i++) {
      const job = await fetch(`/api/jobs/${data.job_id}`).then((r) => r.json());
      if (job.status === "succeeded") {
        const r = job.result ?? {};
        const extra = r.hotspots_found > r.sites_created ? ` (largest ${r.sites_created} kept)` : "";
        setProbeMsg(
          `${period}: ${r.hotspots_found} change hot-spot${r.hotspots_found === 1 ? "" : "s"}${extra}, added as unreviewed detections.` +
            (r.notes?.length ? " " + r.notes.join(" ") : ""),
        );
        setShowDetected(true);
        return loadSites();
      }
      if (job.status === "failed") return setProbeMsg(`Scan failed: ${job.error}`);
      if (i === 2 && job.status === "queued") setProbeMsg(`Waiting for the worker… is \`python -m api.worker\` running?`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    setProbeMsg("The scan is taking a long time. It keeps running; check back shortly.");
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of sites) c[s.verification.level] = (c[s.verification.level] ?? 0) + 1;
    return c;
  }, [sites]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      <div className="pointer-events-none absolute left-4 right-4 top-4 flex items-start gap-4">
        <div className="w-64 shrink-0 border border-[#2a2d33] bg-[#0c0d10]/92 px-3 py-2 backdrop-blur">
          <div className="font-mono text-[11px] tracking-[0.25em] text-[#d4ff4a]">BURN EVIDENCE</div>
          <div className="mt-1 font-mono text-[10px] text-[#8a8d84]">probe · scan · add evidence · verify</div>
        </div>
        <div className="min-w-0 flex-1">
          <TimeBar start={range[0]} end={range[1]} onChange={(s, e) => setRange([s, e])} />
        </div>
      </div>

      <aside className="absolute bottom-4 left-4 top-28 w-64 overflow-auto border border-[#2a2d33] bg-[#0c0d10]/92 p-3 font-mono text-[11px] backdrop-blur">
        <Section title="Probe an area">
          <div className="mb-2 grid grid-cols-2 gap-1">
            {(["draw", "coords"] as const).map((m) => (
              <button
                key={m}
                className={`border px-2 py-1 ${probeMode === m ? "border-[#d4ff4a] text-[#d4ff4a]" : "border-[#2a2d33]"}`}
                onClick={() => setProbeMode(m)}
              >
                {m === "draw" ? "Draw box" : "Coordinates"}
              </button>
            ))}
          </div>
          {probeMode === "draw" ? (
            <button
              className={`mb-2 w-full border px-2 py-1 ${drawing ? "border-[#d4ff4a] text-[#d4ff4a]" : "border-[#2a2d33]"}`}
              onClick={() => setDrawing(!drawing)}
            >
              {drawing ? "Drag a box on the map…" : aoi ? "Redraw box" : "Start drawing"}
            </button>
          ) : (
            <div className="mb-2">
              <div className="mb-1 grid grid-cols-2 gap-1">
                <Field label="lat" value={lat} onChange={setLat} />
                <Field label="lon" value={lon} onChange={setLon} />
              </div>
              <Field label="box size, km" value={sizeKm} onChange={setSizeKm} />
              <button className="mt-1 w-full border border-[#2a2d33] px-2 py-1" onClick={applyCoordinates}>
                Go
              </button>
            </div>
          )}
          <div className="mb-2 text-[10px] leading-4 text-[#8a8d84]">
            Window {win.event.start} → {win.event.end}
            <br />
            Baseline {win.baseline.start} → {win.baseline.end}
          </div>
          <button className="mb-1 w-full border border-[#2a2d33] px-2 py-1" onClick={runCoverage}>
            Check imagery
          </button>
          <button className="w-full border border-[#d4ff4a]/50 px-2 py-1 text-[#d4ff4a]" onClick={runScan}>
            Scan this area
          </button>
          {probeMsg ? <p className="mt-2 text-[10px] leading-4 text-[#b8b6aa]">{probeMsg}</p> : null}
          {error ? <p className="mt-2 text-[10px] text-[#ff4d2e]">{error}</p> : null}
        </Section>

        {aoi ? (
          <Section title="Area layers">
            <AreaLayers
              analysis={analysis}
              on={layerOn}
              opacity={opacity}
              onToggle={(id, value) => setLayerOn((prev) => ({ ...prev, [id]: value }))}
              onOpacity={setOpacity}
              onClear={() => {
                setAoi(null);
                setAnalysis({ status: "idle" });
              }}
            />
          </Section>
        ) : null}

        <Section title="Map">
          {LEVELS.map((l) => (
            <div key={l.id} className="mb-1.5 flex items-start gap-2" title={l.note}>
              <span
                className="mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={
                  l.id === "detected"
                    ? { border: `1.5px solid ${l.color}` }
                    : l.id === "disputed"
                      ? { background: l.color, border: `2px solid ${LEVEL_COLOR.explained}` }
                      : { background: l.color }
                }
              />
              <span className={l.id === "detected" && !showDetected ? "text-[#555]" : ""}>
                {l.label} <span className="text-[#8a8d84]">· {counts[l.id] ?? 0}</span>
                <span className="block text-[9px] leading-3 text-[#8a8d84]">{l.note}</span>
              </span>
            </div>
          ))}
          <label className="mt-2 flex items-start gap-2 text-[10px] leading-4">
            <input type="checkbox" checked={showDetected} onChange={(e) => setShowDetected(e.target.checked)} />
            Show unreviewed detections. Off by default: a satellite signal alone isn&apos;t a claim.
          </label>
        </Section>

        <Section title="Reviewer">
          <label className="mb-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={reviewer.enabled}
              onChange={(e) => setReviewer({ ...reviewer, enabled: e.target.checked })}
            />
            Reviewer mode
          </label>
          {reviewer.enabled ? (
            <div className="grid gap-1">
              <input
                className="border border-[#2a2d33] bg-black px-2 py-1"
                placeholder="reviewer name"
                value={reviewer.name}
                onChange={(e) => setReviewer({ ...reviewer, name: e.target.value })}
              />
              <input
                className="border border-[#2a2d33] bg-black px-2 py-1"
                placeholder="reviewer token"
                type="password"
                value={reviewer.token}
                onChange={(e) => setReviewer({ ...reviewer, token: e.target.value })}
              />
            </div>
          ) : null}
        </Section>
      </aside>

      {selected ? (
        <LocationPanel
          site={selected}
          handle={handle}
          reviewer={reviewer}
          onHandle={setHandle}
          onClose={() => setSelectedId(null)}
          onChanged={loadSites}
        />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 border-b border-[#2a2d33] pb-3">
      <div className="mb-2 tracking-[0.2em] text-[#8a8d84]">{title.toUpperCase()}</div>
      {children}
    </div>
  );
}

function Field({ label: text, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] text-[#8a8d84]">{text}</span>
      <input
        className="w-full border border-[#2a2d33] bg-black px-2 py-1"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function toFeatureCollection(sites: Site[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: sites.flatMap((s) => {
      const c = coords(s);
      if (!c) return [];
      return [
        {
          type: "Feature",
          properties: {
            id: s.id,
            level: s.verification.level,
            color: LEVEL_COLOR[s.verification.level],
          },
          geometry: { type: "Point", coordinates: c },
        },
      ];
    }),
  };
}
