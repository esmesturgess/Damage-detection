"use client";

import { CHROME } from "@/lib/look";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  AttributionControl,
  Map,
  GeoJSONSource,
  Marker,
  RasterTileSource,
  setWorkerUrl,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  type FilterSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import { LEVELS, levelInfo, siteCentre, type Site } from "@/lib/types";
import AreaLayers, { AREA_LAYERS, type AreaLayerId, type Analysis } from "./AreaLayers";
import Intro from "./Intro";
import SiteOverlay from "./SiteOverlay";
import StartInvestigation from "./StartInvestigation";
import TimeBar, { label, monthIndex, windows } from "./TimeBar";

// MapLibre 6 resolves its worker relative to import.meta.url, which breaks once
// Next bundles it. The predev/prebuild scripts copy the worker into public/.
setWorkerUrl("/maplibre-gl-worker.mjs");

const RAKHINE: [number, number] = [93.8, 20.8];
const API_DOWN = "API unreachable. Start uvicorn on :8000.";
const AREA_OPACITY = 0.85;
const INTRO_SEEN = "burn-evidence:intro-seen";
const HANDLE = "burn-evidence:handle";
const EXAMPLE = { lat: 20.82, lon: 92.38, range: [monthIndex(2017, 7), monthIndex(2017, 8)] as [number, number] };
const SITE_BOX_KM = 3;
const COORD_BOX_KM = 5;

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

/** The area a site covers: an investigation's own polygon, or a box around a hot-spot. */
function siteArea(site: Site): GeoJSON.Polygon {
  if (site.geometry.type === "Polygon") return site.geometry;
  const [lon, lat] = siteCentre(site);
  return boxAround(lat, lon, SITE_BOX_KM);
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
  // The open site lives in the URL (/sites/<id>), so links can be shared and
  // the back button closes the overlay.
  const pathname = usePathname();
  const selectedId = pathname?.match(/^\/sites\/([^/]+)/)?.[1] ?? null;
  const fitOnLoad = useRef<GeoJSON.Polygon | null>(null);
  const [showDetected, setShowDetected] = useState(true);
  const [showRuledOut, setShowRuledOut] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [range, setRange] = useState<[number, number]>([monthIndex(2017, 7), monthIndex(2017, 8)]);
  const [coordText, setCoordText] = useState("");
  const [drawing, setDrawing] = useState(false);
  const drawStart = useRef<[number, number] | null>(null);
  const [aoi, setAoi] = useState<GeoJSON.Polygon | null>(null);
  const [probeMsg, setProbeMsg] = useState("");
  // Which box + dates have been scanned. Starting an investigation comes after a scan.
  const [scan, setScan] = useState<{ key: string; status: "scanning" | "done" } | null>(null);
  const [handle, setHandle] = useState("");
  const [analysis, setAnalysis] = useState<Analysis>({ status: "idle" });
  const [layerOn, setLayerOn] = useState<Record<AreaLayerId, boolean>>({
    before: false,
    after: true,
    burn: false,
    change: true,
  });
  const [tileTrouble, setTileTrouble] = useState(false);
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
    let seen = true;
    try {
      seen = localStorage.getItem(INTRO_SEEN) === "1";
    } catch {
      /* storage unavailable: don't nag */
    }
    if (!seen) queueMicrotask(() => setIntroOpen(true));
    try {
      const saved = localStorage.getItem(HANDLE);
      if (saved) queueMicrotask(() => setHandle(saved));
    } catch {
      /* storage unavailable: ask each time */
    }
  }, []);

  function rememberHandle(h: string) {
    setHandle(h);
    try {
      localStorage.setItem(HANDLE, h);
    } catch {
      /* storage unavailable */
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchSites().then(
      (s) => {
        if (cancelled) return;
        setSites(s);
        setError(null);
        const linked = s.find((site) => window.location.pathname === `/sites/${site.id}`);
        if (linked) {
          const box = siteArea(linked);
          setAoi(box);
          const map = mapRef.current;
          if (map?.loaded()) {
            const [sw, , ne] = box.coordinates[0];
            map.fitBounds([sw as [number, number], ne as [number, number]], { padding: 160, maxZoom: 12, duration: 0 });
          } else {
            fitOnLoad.current = box; // the map's load handler applies it
          }
        }
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
          attributionControl: false,
        });
        // Credits bottom left: the controls panel takes the bottom right.
        map.addControl(new AttributionControl({ compact: true }), "bottom-left");
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
            paint: { "fill-color": "#ffffff", "fill-opacity": 0.06 },
          });
          map.addLayer({
            id: "aoi-line",
            type: "line",
            source: "aoi",
            paint: { "line-color": "#f1e9cf", "line-width": 1.75, "line-dasharray": [2, 1] },
          });
          map.addSource("investigations", { type: "geojson", data: emptyFc() });
          map.addLayer({
            id: "inv-fill",
            type: "fill",
            source: "investigations",
            paint: { "fill-color": ["get", "color"], "fill-opacity": 0.1 },
          });
          map.addLayer({
            id: "inv-line",
            type: "line",
            source: "investigations",
            paint: { "line-color": ["get", "color"], "line-width": 2.5 },
          });
          map.addLayer({
            id: "inv-label",
            type: "symbol",
            source: "investigations",
            layout: {
              "text-field": ["get", "name"],
              "text-font": ["Montserrat SemiBold", "Open Sans Bold", "Noto Sans Regular"],
              "text-size": 13,
              "text-anchor": "top",
              "text-offset": [0, 0.6],
            },
            paint: { "text-color": "#f4efe6", "text-halo-color": "#3a140e", "text-halo-width": 1.6 },
          });
          // Hot-spots: one circle each, drawn by verification level (see LEVELS).
          // Detected is an outline only: a machine signal, not a claim.
          map.addLayer({
            id: "locations",
            type: "circle",
            source: "sites",
            paint: {
              "circle-radius": ["get", "radius"],
              "circle-color": ["get", "fill"],
              "circle-stroke-width": ["get", "strokeWidth"],
              "circle-stroke-color": ["get", "stroke"],
            },
          });
          for (const layer of ["locations", "inv-fill"]) {
            map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
            map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
          }
          // Earth Engine computes area tiles on demand and occasionally fails one
          // (busy or timed out). Handling errors here keeps a single bad tile from
          // surfacing as a page error; area failures get a retry in the Layers panel.
          map.on("error", (e) => {
            const sourceId = (e as { sourceId?: string }).sourceId;
            if (sourceId?.startsWith("area-")) setTileTrouble(true);
            else console.warn("Map error:", e.error?.message ?? e);
          });
          // Sites usually arrive before the style finishes loading; effects below
          // wait on this so the data and handlers land on layers that exist.
          setMapReady(true);
          if (fitOnLoad.current) {
            const [sw, , ne] = fitOnLoad.current.coordinates[0];
            map.fitBounds([sw as [number, number], ne as [number, number]], { padding: 160, maxZoom: 12, duration: 0 });
          }
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
      // Dots sit above investigation areas; take the topmost feature only once.
      if ((ev.originalEvent as MouseEvent & { handled?: boolean }).handled) return;
      (ev.originalEvent as MouseEvent & { handled?: boolean }).handled = true;
      const feature = ev.features?.[0];
      const id = feature?.properties?.id as string | undefined;
      if (!id || !feature) return;
      window.history.pushState(null, "", `/sites/${id}`);
      if (feature.geometry.type === "Polygon") setAoi(feature.geometry as GeoJSON.Polygon);
      else if (feature.geometry.type === "Point") {
        const [lon, lat] = feature.geometry.coordinates;
        setAoi(boxAround(lat, lon, SITE_BOX_KM));
      }
    };
    map.on("click", "locations", handler);
    map.on("click", "inv-fill", handler);
    return () => {
      map.off("click", "locations", handler);
      map.off("click", "inv-fill", handler);
    };
  }, [mapReady]);

  const fc = useMemo(() => toFeatureCollection(sites), [sites]);
  const invFc = useMemo(() => investigationsCollection(sites), [sites]);

  useEffect(() => {
    const map = mapRef.current;
    (map?.getSource("sites") as GeoJSONSource | undefined)?.setData(fc);
    (map?.getSource("investigations") as GeoJSONSource | undefined)?.setData(invFc);
  }, [fc, invFc, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("locations")) return;
    const hidden = [...(showDetected ? [] : ["detected"]), ...(showRuledOut ? [] : ["ruled_out"])];
    const filter = hidden.length ? (["!", ["in", ["get", "level"], ["literal", hidden]]] as FilterSpecification) : null;
    map.setFilter("locations", filter);
    for (const layer of ["inv-fill", "inv-line", "inv-label"]) map.setFilter(layer, showRuledOut ? null : ["!=", ["get", "level"], "ruled_out"]);
  }, [showDetected, showRuledOut, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource("aoi") as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      aoi
        ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: aoi }] }
        : emptyFc(),
    );
  }, [aoi, mapReady, drawing]); // drawing: restore the saved box after a cancelled drag

  const aoiIsInvestigation = useMemo(
    () =>
      !!aoi &&
      sites.some((s) => s.kind === "investigation" && JSON.stringify(s.geometry.coordinates) === JSON.stringify(aoi.coordinates)),
    [aoi, sites],
  );
  const scanKey = JSON.stringify([aoi?.coordinates, win]);
  const scanStatus = scan?.key === scanKey ? scan.status : "none";
  const startMarker = useRef<Marker | null>(null);
  const markerAction = useRef<() => void>(() => {});

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !aoi || aoiIsInvestigation || drawing) {
      startMarker.current?.remove();
      return;
    }
    if (!startMarker.current) {
      const button = document.createElement("button");
      button.className = `${CHROME} map-cta`;
      button.addEventListener("click", () => markerAction.current());
      startMarker.current = new Marker({ element: button, anchor: "top", offset: [0, 10] });
    }
    const marker = startMarker.current;
    const ring = aoi.coordinates[0];
    const xs = ring.map((c) => c[0]);
    const ys = ring.map((c) => c[1]);
    const centreLon = (Math.min(...xs) + Math.max(...xs)) / 2;
    const south = Math.min(...ys);
    const north = Math.max(...ys);
    const GAP = 10;
    // Below the box when there's room on screen, otherwise above it.
    const place = () => {
      const roomBelow = map.getContainer().clientHeight - map.project([centreLon, south]).y;
      const height = marker.getElement().offsetHeight || 36;
      if (roomBelow > GAP + height + 28) marker.setLngLat([centreLon, south]).setOffset([0, GAP]);
      else marker.setLngLat([centreLon, north]).setOffset([0, -(GAP + height)]);
    };
    marker.setLngLat([centreLon, south]).addTo(map);
    place();
    map.on("move", place);
    return () => {
      map.off("move", place);
    };
  }, [aoi, aoiIsInvestigation, drawing, mapReady]);

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
        else {
          setTileTrouble(false);
          setAnalysis({ status: "ready", data });
        }
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
        map.setPaintProperty(layerId, "raster-opacity", AREA_OPACITY);
      }
    }
  }, [analysis, aoi, layerOn, mapReady]);

  // Box drawing: press, drag (the box follows the pointer), release.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!drawing) {
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      return;
    }
    map.dragPan.disable();
    map.getCanvas().style.cursor = "crosshair";
    const preview = map.getSource("aoi") as GeoJSONSource | undefined;
    let startPoint: { x: number; y: number } | null = null;
    const onDown = (e: MapMouseEvent) => {
      drawStart.current = [e.lngLat.lng, e.lngLat.lat];
      startPoint = e.point;
    };
    const onMove = (e: MapMouseEvent) => {
      if (!drawStart.current) return;
      const box = rectangle(drawStart.current, [e.lngLat.lng, e.lngLat.lat]);
      preview?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: box }] });
    };
    const onUp = (e: MapMouseEvent) => {
      if (!drawStart.current || !startPoint) return;
      const tooSmall = Math.abs(e.point.x - startPoint.x) < 6 || Math.abs(e.point.y - startPoint.y) < 6;
      if (!tooSmall) {
        setAoi(rectangle(drawStart.current, [e.lngLat.lng, e.lngLat.lat]));
        setDrawing(false);
      }
      drawStart.current = null;
      startPoint = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      drawStart.current = null;
      setDrawing(false);
    };
    map.on("mousedown", onDown);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      map.getCanvas().style.cursor = "";
    };
  }, [drawing]);

  function closeIntro() {
    setIntroOpen(false);
    try {
      localStorage.setItem(INTRO_SEEN, "1");
    } catch {
      /* storage unavailable */
    }
  }

  function showExample() {
    closeIntro();
    setRange(EXAMPLE.range);
    setCoordText(`${EXAMPLE.lat}, ${EXAMPLE.lon}`);
    goTo(EXAMPLE.lat, EXAMPLE.lon);
  }

  function applyCoordinates() {
    const [la, lo] = coordText.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180)) {
      setProbeMsg("Type latitude, longitude, e.g. 20.82, 92.38");
      return;
    }
    goTo(la, lo);
  }

  function goTo(la: number, lo: number) {
    const box = boxAround(la, lo, COORD_BOX_KM);
    setAoi(box);
    setProbeMsg("");
    const [sw, , ne] = box.coordinates[0];
    mapRef.current?.fitBounds([sw as [number, number], ne as [number, number]], { padding: 160, maxZoom: 12 });
  }

  // The button under the box: scan first, then start an investigation.
  useEffect(() => {
    const button = startMarker.current?.getElement() as HTMLButtonElement | undefined;
    markerAction.current = scanStatus === "done" ? () => setStartOpen(true) : () => void runScan();
    if (!button) return;
    button.textContent =
      scanStatus === "done" ? "Start an investigation" : scanStatus === "scanning" ? "Scanning…" : "Scan for change";
    button.disabled = scanStatus === "scanning";
  });

  function clearArea() {
    setAoi(null);
    setAnalysis({ status: "idle" });
    setProbeMsg("");
  }

  async function runScan() {
    try {
      await scanArea();
    } catch {
      setScan(null);
      setProbeMsg(API_DOWN);
    }
  }

  async function scanArea() {
    if (!aoi) return setProbeMsg("Draw a box or enter coordinates first.");
    const key = scanKey;
    setScan({ key, status: "scanning" });
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aoi_geojson: aoi, baseline_window: win.baseline, event_window: win.event, z_threshold: 3.0 }),
    });
    const data = await res.json();
    if (!data.job_id) {
      setScan(null);
      return setProbeMsg(data.detail ?? "Scan failed.");
    }
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
        setScan({ key, status: "done" });
        return loadSites();
      }
      if (job.status === "failed") {
        setScan(null);
        return setProbeMsg(`Scan failed: ${job.error}`);
      }
      if (i === 2 && job.status === "queued") setProbeMsg(`Waiting for the worker… is \`python -m api.worker\` running?`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    setScan(null);
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

      {/* Name block, top left. Room for a logo. */}
      <div className={`${CHROME} on-paper absolute left-4 top-4 flex h-[86px] w-[248px] items-center gap-3 border border-[var(--rule)] px-4`}>
        <h1 className="display flex-1 text-[22px] font-semibold leading-[1.05]">Burn and change detection</h1>
        <button className="link self-start pt-3 text-[12px]" onClick={() => setIntroOpen(true)}>
          Help
        </button>
      </div>

      <div className="pointer-events-none absolute left-[276px] right-4 top-4">
        <TimeBar start={range[0]} end={range[1]} onChange={(s, e) => setRange([s, e])} />
      </div>

      {/* Controls, bottom right: area, layers, key. */}
      <section className={`${CHROME} on-paper absolute bottom-4 right-4 flex max-h-[calc(100%-140px)] w-[300px] flex-col overflow-auto border border-[var(--rule)]`}>
        <div className="border-b border-[var(--line)] p-3">
          <form
            className="flex border border-[var(--rule)]"
            onSubmit={(e) => {
              e.preventDefault();
              applyCoordinates();
            }}
          >
            <input
              className="num min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-[var(--muted)]"
              placeholder="lat, lon"
              aria-label="Coordinates"
              value={coordText}
              onChange={(e) => setCoordText(e.target.value)}
            />
            <button className="border-l border-[var(--rule)] px-2.5" aria-label="Go to coordinates">
              →
            </button>
          </form>
          <button
            className={`btn mt-2 w-full ${drawing ? "btn-active" : ""}`}
            onClick={() => setDrawing(!drawing)}
          >
            {drawing ? "Cancel drawing" : aoi ? "Draw a new box" : "Draw a box"}
          </button>
          {drawing ? <p className="muted mt-2 text-[12px]">Drag on the map to draw the box. Esc cancels.</p> : null}
          {aoi && !drawing ? (
            <div className="mt-2 flex justify-between text-[12px]">
              <button className="link" onClick={runScan} disabled={scanStatus === "scanning"}>
                {scanStatus === "scanning" ? "Scanning…" : scanStatus === "done" ? "Scan again" : "Scan for change"}
              </button>
              <button className="link" onClick={clearArea}>
                Clear box
              </button>
            </div>
          ) : null}
          {probeMsg ? <p className="muted mt-2 text-[12px] leading-snug">{probeMsg}</p> : null}
          {error ? <p className="mt-2 text-[12px] font-semibold">{error}</p> : null}
        </div>

        {aoi ? (
          <div className="border-b border-[var(--line)] p-3">
            <AreaLayers
              analysis={analysis}
              on={layerOn}
              onToggle={(id, value) => setLayerOn((prev) => ({ ...prev, [id]: value }))}
              tileTrouble={tileTrouble}
              onRetry={() => {
                setTileTrouble(false);
                for (const id of AREA_LAYERS) {
                  const src = mapRef.current?.getSource(`area-${id}`) as RasterTileSource | undefined;
                  const url = shownLayers.current[id];
                  if (src && url) src.setTiles([url]); // re-requests the layer's tiles
                }
              }}
            />
          </div>
        ) : null}

        <div className="p-3 text-[13px]">
          <ul className="mb-2 flex flex-wrap gap-x-3.5 gap-y-1">
            {LEVELS.filter((l) => l.id !== "ruled_out" && (l.id !== "disputed" || counts.disputed)).map((l) => (
              <li
                key={l.id}
                className={`flex items-center gap-1.5 ${l.id === "detected" && !showDetected ? "faint" : ""}`}
                title={l.note}
              >
                <LevelMark level={l} />
                {l.label}
              </li>
            ))}
          </ul>
          <div className="muted flex gap-4 text-[12px]">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                className="check"
                checked={showDetected}
                onChange={(e) => setShowDetected(e.target.checked)}
              />
              Unreviewed
            </label>
            {counts.ruled_out ? (
              <label className="flex cursor-pointer items-center gap-1.5" title={levelInfo("ruled_out").note}>
                <input
                  type="checkbox"
                  className="check"
                  checked={showRuledOut}
                  onChange={(e) => setShowRuledOut(e.target.checked)}
                />
                Ruled out
              </label>
            ) : null}
          </div>
        </div>
      </section>

      {selected ? (
        <SiteOverlay
          site={selected}
          handle={handle}
          onHandle={rememberHandle}
          onClose={() => window.history.pushState(null, "", "/")}
          onChanged={loadSites}
          parent={sites.find((x) => x.id === selected.parent_id) ?? null}
          onOpenSite={(id) => window.history.pushState(null, "", `/sites/${id}`)}
          onStartHere={(site) => {
            window.history.pushState(null, "", "/");
            const area = siteArea(site);
            setAoi(area);
            const [sw, , ne] = area.coordinates[0];
            mapRef.current?.fitBounds([sw as [number, number], ne as [number, number]], { padding: 160, maxZoom: 12 });
            setStartOpen(true);
          }}
        />
      ) : null}

      {startOpen && aoi ? (
        <StartInvestigation
          aoi={aoi}
          win={win}
          author={handle}
          onClose={() => setStartOpen(false)}
          onOpen={(id, created) => {
            setStartOpen(false);
            if (created) loadSites();
            window.history.pushState(null, "", `/sites/${id}`);
          }}
        />
      ) : null}

      {introOpen ? <Intro onClose={closeIntro} onExample={showExample} /> : null}
    </div>
  );
}

/** A legend swatch drawn like the map mark. Paper outlines take the text colour so they show on the panel. */
function LevelMark({ level }: { level: (typeof LEVELS)[number] }) {
  const stroke = level.stroke === "#f4efe6" ? "var(--foreground)" : level.stroke;
  return (
    <span
      className="inline-block h-3 w-3 shrink-0 rounded-full"
      style={{ background: level.fill, border: `1px solid ${stroke}` }}
    />
  );
}

function rectangle([x0, y0]: [number, number], [x1, y1]: [number, number]): GeoJSON.Polygon {
  const west = Math.min(x0, x1);
  const east = Math.max(x0, x1);
  const south = Math.min(y0, y1);
  const north = Math.max(y0, y1);
  return {
    type: "Polygon",
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function markStyle(s: Site) {
  const { id, fill, stroke, strokeWidth, radius } = levelInfo(s.verification.level);
  return { level: id, fill, stroke, strokeWidth, radius };
}

function toFeatureCollection(sites: Site[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: sites
      .filter((s) => s.geometry.type === "Point")
      .map((s) => ({
        type: "Feature",
        properties: { id: s.id, ...markStyle(s) },
        geometry: { type: "Point", coordinates: siteCentre(s) },
      })),
  };
}

function investigationsCollection(sites: Site[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: sites
      .filter((s) => s.kind === "investigation" && s.geometry.type === "Polygon")
      .map((s) => ({
        type: "Feature",
        properties: {
          id: s.id,
          name: s.name_local ? `${s.name}\n${s.name_local}` : (s.name ?? ""),
          level: s.verification.level,
          color: levelInfo(s.verification.level).line,
        },
        geometry: s.geometry,
      })),
  };
}
