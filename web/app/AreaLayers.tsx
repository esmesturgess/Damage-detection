"use client";

export type AreaLayerId = "before" | "after" | "burn" | "change";

/** Map stacking order, bottom to top. */
export const AREA_LAYERS: AreaLayerId[] = ["before", "after", "burn", "change"];

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

const CHANGE_RAMP = "linear-gradient(90deg, #ffff00, #ff0000, #800080)";
const BURN_RAMP = "linear-gradient(90deg, #fff7bc, #fec44f, #f03b20, #7f0000)";

export default function AreaLayers({
  analysis,
  on,
  opacity,
  onToggle,
  onOpacity,
  tileTrouble,
  onRetry,
}: {
  analysis: Analysis;
  on: Record<AreaLayerId, boolean>;
  opacity: number;
  onToggle: (id: AreaLayerId, value: boolean) => void;
  onOpacity: (v: number) => void;
  tileTrouble: boolean;
  onRetry: () => void;
}) {
  if (analysis.status === "idle" || analysis.status === "loading") {
    return (
      <p className="muted flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
        Loading imagery for these dates…
      </p>
    );
  }
  if (analysis.status === "error") {
    return <p className="text-[#ff6b4a]">{analysis.error}</p>;
  }

  const { layers, optical, notes } = analysis.data;
  const trueColour: "off" | "before" | "after" = on.after ? "after" : on.before ? "before" : "off";
  const setTrueColour = (v: "off" | "before" | "after") => {
    onToggle("before", v === "before");
    onToggle("after", v === "after");
  };
  const scenes = (w?: Window, n?: number) => (w ? `${w.start} → ${w.end} · ${n} scenes` : "");

  return (
    <div className="space-y-4">
      <LayerRow
        title="Radar change"
        on={on.change}
        disabled={!layers.change}
        onToggle={(v) => onToggle("change", v)}
        ramp={CHANGE_RAMP}
        rampLabels={["low", "strong"]}
      >
        Change in built-up areas. Not proof of damage on its own.
      </LayerRow>

      <LayerRow
        title="Burn signal"
        on={on.burn}
        disabled={!layers.burn}
        onToggle={(v) => onToggle("burn", v)}
        ramp={BURN_RAMP}
        rampLabels={["low", "severe"]}
      >
        Vegetation and roof loss consistent with fire.
        {optical.provisional && optical.product ? <span className="text-[#ffd36a]"> Provisional imagery.</span> : null}
      </LayerRow>

      <div>
        <div className="mb-1.5">Satellite photo</div>
        <div className="seg">
          {(["off", "before", "after"] as const).map((v) => (
            <button
              key={v}
              aria-pressed={trueColour === v}
              disabled={v !== "off" && !layers[v]}
              onClick={() => setTrueColour(v)}
              className="capitalize disabled:opacity-30"
            >
              {v}
            </button>
          ))}
        </div>
        {trueColour !== "off" ? (
          <p className="faint num mt-1 text-[11px]">
            {trueColour === "before"
              ? scenes(optical.before_window, optical.pre_scenes)
              : scenes(optical.after_window, optical.post_scenes)}
          </p>
        ) : null}
      </div>

      <label className="block">
        <div className="mb-1 flex justify-between">
          <span>Opacity</span>
          <span className="num muted">{Math.round(opacity * 100)}%</span>
        </div>
        <input
          className="w-full accent-[var(--accent)]"
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
        />
      </label>

      {tileTrouble ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-[#f5b34a]/10 px-3 py-2 text-[12px] text-[#f5b34a]">
          <span>Earth Engine didn&apos;t render some tiles (busy or timed out).</span>
          <button className="btn shrink-0 px-2.5 py-1 text-[12px]" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}

      {notes.map((n) => (
        <p key={n} className="text-[12px] text-[#f5b34a]">
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
  ramp,
  rampLabels,
  children,
}: {
  title: string;
  on: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  ramp: string;
  rampLabels: [string, string];
  children: React.ReactNode;
}) {
  return (
    <div className={disabled ? "opacity-40" : ""}>
      <label className="mb-1.5 flex cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          className="switch"
          checked={on && !disabled}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>{title}</span>
      </label>
      <div className="h-1.5 w-full rounded-full" style={{ background: ramp }} />
      <div className="faint mb-1 mt-0.5 flex justify-between text-[11px]">
        <span>{rampLabels[0]}</span>
        <span>{rampLabels[1]}</span>
      </div>
      <p className="muted text-[12px] leading-snug">{children}</p>
    </div>
  );
}
