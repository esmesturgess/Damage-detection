"use client";

export type AreaLayerId = "before" | "after" | "water" | "burn" | "change";

/** Map stacking order, bottom to top. Water sits over the burn signal so it masks it. */
export const AREA_LAYERS: AreaLayerId[] = ["before", "after", "burn", "water", "change"];

type Window = { start: string; end: string };

export type AnalysisData = {
  layers: Partial<Record<AreaLayerId, { url: string }>>;
  optical: {
    product: "L2A" | "L1C" | null;
    provisional: boolean;
    pre_scenes?: number;
    post_scenes?: number;
    before_window?: Window;
    after_window?: Window;
  };
  notes: string[];
};

export type Analysis =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: AnalysisData };

// Same palettes as CHANGE_VIS and BURN_VIS in core/imagery.py, weak to strong.
const CHANGE_STEPS = ["#fbc6e2", "#f768a1", "#c51b8a", "#7a0177", "#49006a"];
const BURN_STEPS = ["#fff7bc", "#fec44f", "#f03b20", "#7f0000"];
const WATER_STEPS = ["#3b7dd8"];

export default function AreaLayers({
  analysis,
  on,
  onToggle,
  tileTrouble,
  onRetry,
}: {
  analysis: Analysis;
  on: Record<AreaLayerId, boolean>;
  onToggle: (id: AreaLayerId, value: boolean) => void;
  tileTrouble: false | "rate" | "other";
  onRetry: () => void;
}) {
  if (analysis.status === "idle" || analysis.status === "loading") {
    return (
      <p className="muted flex items-center gap-2 text-[13.5px]">
        <span className="h-2 w-2 animate-pulse bg-[var(--accent)]" />
        Loading imagery for these dates…
      </p>
    );
  }
  if (analysis.status === "error") {
    return <p className="text-[13.5px] font-semibold">{analysis.error}</p>;
  }

  const { layers, optical, notes } = analysis.data;
  const trueColour: "off" | "before" | "after" = on.after ? "after" : on.before ? "before" : "off";
  const setTrueColour = (v: "off" | "before" | "after") => {
    onToggle("before", v === "before");
    onToggle("after", v === "after");
  };
  const scenes = (w?: Window, n?: number) => (w ? `${w.start} → ${w.end} · ${n} scenes` : "");

  return (
    <div className="space-y-2.5">
      <LayerRow
        title="Radar change"
        on={on.change}
        disabled={!layers.change}
        onToggle={(v) => onToggle("change", v)}
        steps={CHANGE_STEPS}
      >
        <p>
          <a className="link" href="https://github.com/oballinger/PWTT" target="_blank" rel="noreferrer">
            Pixel-Wise T-Test (PWTT)
          </a>{" "}
          by Ollie Ballinger (MIT licence), with robustness fixes by Imogen Dexter. Method:{" "}
          <a className="link" href="https://doi.org/10.1016/j.rse.2025.115025" target="_blank" rel="noreferrer">
            Ballinger, <i>Remote Sensing of Environment</i> 331 (2025)
          </a>
          .
        </p>
        <p>
          Sentinel-1 radar, both polarisations (VV, VH), speckle-filtered and log-scaled. For each satellite orbit, a
          Welch t-test compares each pixel&apos;s images in the 12 months before the window with those inside it.
        </p>
        <p>
          Our change to the method: orbits are combined with Stouffer&apos;s method keeping the direction of change (brighter
          or darker), then the stronger polarisation is kept. The published code combines the sizes of change without
          direction, so random noise adds up wherever several orbits overlap. In Nablus, where nothing happened in
          August–September 2017, that made 95% of built-up pixels score 3 or more; combining by direction gives 53%,
          while burned villages in Rakhine are picked out as before.
        </p>
        <p>
          The result is smoothed over 10–150 m, so it is not strictly per pixel, and kept only where Dynamic World mapped
          built-up land the year before. A pixel needs at least 3 images before and 2 during.
        </p>
        <p>
          Shown from 3 (pale pink) to 5 and above (deep violet). T says how sure the test is that something changed, not how much
          changed: in cities with many satellite passes, small everyday changes still reach 3. It flags destruction, but
          also construction, demolition, flooding or crops beside buildings. Use it to find places to look, not as evidence
          of damage.
        </p>
      </LayerRow>
      <LayerRow
        title="Burn signal"
        on={on.burn}
        disabled={!layers.burn}
        onToggle={(v) => onToggle("burn", v)}
        steps={BURN_STEPS}
      >
        <p>
          Difference in Normalised Burn Ratio (dNBR), a standard fire-severity index (Key &amp; Benson, USGS). NBR compares
          near-infrared (Sentinel-2 band 8) with short-wave infrared (band 12). Burning lowers the first and raises the
          second.
        </p>
        <p>
          Before: the median of cloud-free pixels over the same months a year earlier, so seasonal drying isn&apos;t read as
          burning. If those months have no clear scene, the 12 months before are used instead and the layer says so. After:
          the median over the window, widened by up to 90 days when no clear scene exists. Clouds are removed with
          s2cloudless.
        </p>
        <p>
          Shown from 0.1 (pale yellow, low severity) to 0.66 (dark red, high), the USGS severity classes. Harvest, land
          clearing and drought also raise it. This is the raw
          index, not the trained burn classifier.
        </p>
      </LayerRow>
      <LayerRow
        title="Water mask"
        on={on.water}
        disabled={!layers.water}
        onToggle={(v) => onToggle("water", v)}
        steps={WATER_STEPS}
      >
        <p>
          Water mask used in the paper: the Modified Normalised Difference Water Index, MNDWI = (green − SWIR1) / (green +
          SWIR1), from Sentinel-2 bands 3 and 11.
        </p>
        <p>
          A pixel is water when MNDWI is above 0.12 in both the before and after composites, so it marks water that was
          there throughout, not new flooding. The scan&apos;s standing-water reading uses the same test.
        </p>
      </LayerRow>
      {optical.provisional && optical.product ? (
        <p className="muted text-[13.5px]">Burn signal from Level-1C imagery: less reliable.</p>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="flex-1">Photo</span>
        <div className="seg text-[13.5px]">
          {(["off", "before", "after"] as const).map((v) => (
            <button
              key={v}
              aria-pressed={trueColour === v}
              disabled={v !== "off" && !layers[v]}
              onClick={() => setTrueColour(v)}
              className="capitalize !px-2 !py-0.5 disabled:opacity-30"
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {trueColour !== "off" ? (
        <p className="faint num -mt-1 text-right text-[13px]">
          {trueColour === "before"
            ? scenes(optical.before_window, optical.pre_scenes)
            : scenes(optical.after_window, optical.post_scenes)}
        </p>
      ) : null}

      {tileTrouble ? (
        <div className="flex items-center justify-between gap-2 text-[13.5px] font-semibold">
          <span>
            {tileTrouble === "rate"
              ? "Earth Engine is limiting this project's requests (over its monthly quota), so some tiles are missing."
              : "Earth Engine didn't render some tiles."}
          </span>
          <button className="link shrink-0" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}

      {notes.map((n) => (
        <p key={n} className="text-[13.5px] font-semibold">
          {n}
        </p>
      ))}
    </div>
  );
}

function LayerRow({
  title,
  on,
  disabled,
  onToggle,
  steps,
  children,
}: {
  title: string;
  on: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  steps: string[];
  children: React.ReactNode;
}) {
  return (
    <div className={disabled ? "opacity-40" : ""}>
      <label className="flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        className="check"
        checked={on && !disabled}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span className="flex-1">{title}</span>
      <span className="flex gap-0.5" aria-hidden>
        {steps.map((c) => (
          <span key={c} className="h-2 w-3.5" style={{ background: c }} />
        ))}
      </span>
      </label>
      <details className="mt-0.5 pl-[21px] text-[13.5px]">
        <summary className="link cursor-pointer list-none">How it&apos;s calculated</summary>
        <div className="mt-1.5 space-y-1.5 leading-snug">{children}</div>
      </details>
    </div>
  );
}
