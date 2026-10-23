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

// Same palettes as CHANGE_VIS and BURN_VIS in core/imagery.py, weak to strong.
const CHANGE_STEPS = ["#ffff00", "#ff8000", "#ff0000", "#c00040", "#800080"];
const BURN_STEPS = ["#fff7bc", "#fec44f", "#f03b20", "#7f0000"];

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
  tileTrouble: boolean;
  onRetry: () => void;
}) {
  if (analysis.status === "idle" || analysis.status === "loading") {
    return (
      <p className="muted flex items-center gap-2 text-[12px]">
        <span className="h-2 w-2 animate-pulse bg-[var(--accent)]" />
        Loading imagery for these dates…
      </p>
    );
  }
  if (analysis.status === "error") {
    return <p className="text-[12px] font-semibold">{analysis.error}</p>;
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
        note="Change in built-up areas, weak to strong. Not proof of damage on its own."
        on={on.change}
        disabled={!layers.change}
        onToggle={(v) => onToggle("change", v)}
        steps={CHANGE_STEPS}
      />
      <LayerRow
        title="Burn signal"
        note="Vegetation and roof loss consistent with fire, low to severe."
        on={on.burn}
        disabled={!layers.burn}
        onToggle={(v) => onToggle("burn", v)}
        steps={BURN_STEPS}
      />
      {optical.provisional && optical.product ? <p className="muted text-[12px]">Burn signal uses provisional imagery.</p> : null}

      <div className="flex items-center gap-2">
        <span className="flex-1">Photo</span>
        <div className="seg text-[12px]">
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
        <p className="faint num -mt-1 text-right text-[11px]">
          {trueColour === "before"
            ? scenes(optical.before_window, optical.pre_scenes)
            : scenes(optical.after_window, optical.post_scenes)}
        </p>
      ) : null}

      {tileTrouble ? (
        <div className="flex items-center justify-between gap-2 text-[12px] font-semibold">
          <span>Earth Engine didn&apos;t render some tiles.</span>
          <button className="link shrink-0" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}

      {notes.map((n) => (
        <p key={n} className="text-[12px] font-semibold">
          {n}
        </p>
      ))}
    </div>
  );
}

function LayerRow({
  title,
  note,
  on,
  disabled,
  onToggle,
  steps,
}: {
  title: string;
  note: string;
  on: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  steps: string[];
}) {
  return (
    <label className={`flex cursor-pointer items-center gap-2 ${disabled ? "opacity-40" : ""}`} title={note}>
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
  );
}
