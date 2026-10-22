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
  onClear,
}: {
  analysis: Analysis;
  on: Record<AreaLayerId, boolean>;
  opacity: number;
  onToggle: (id: AreaLayerId, value: boolean) => void;
  onOpacity: (v: number) => void;
  onClear: () => void;
}) {
  if (analysis.status === "idle" || analysis.status === "loading") {
    return (
      <p className="text-[10px] leading-4 text-[#8a8d84]">
        Computing layers in Earth Engine for this area and window…
      </p>
    );
  }
  if (analysis.status === "error") {
    return (
      <div className="text-[10px] leading-4">
        <p className="mb-2 text-[#ff4d2e]">{analysis.error}</p>
        <ClearButton onClear={onClear} />
      </div>
    );
  }

  const { layers, optical, notes } = analysis.data;
  const trueColour: "off" | "before" | "after" = on.after ? "after" : on.before ? "before" : "off";
  const setTrueColour = (v: "off" | "before" | "after") => {
    onToggle("before", v === "before");
    onToggle("after", v === "after");
  };

  return (
    <div className="text-[10px] leading-4">
      <LayerRow
        title="Change (radar, PWTT)"
        on={on.change}
        disabled={!layers.change}
        onToggle={(v) => onToggle("change", v)}
      >
        <Ramp gradient={CHANGE_RAMP} left="T 3" right="5+" />
        Structural change in built-up areas. Not proof of damage: construction and flooding show too.
      </LayerRow>

      <LayerRow
        title="Burn signal (dNBR)"
        on={on.burn}
        disabled={!layers.burn}
        onToggle={(v) => onToggle("burn", v)}
      >
        <Ramp gradient={BURN_RAMP} left="low 0.1" right="high 0.66" />
        Vegetation and roof loss consistent with fire.
        {optical.provisional && optical.product ? (
          <span className="text-[#ffd36a]"> Level-1C imagery: provisional.</span>
        ) : null}
      </LayerRow>

      <div className="mb-3">
        <div className="mb-1 text-[11px]">True colour (Sentinel-2)</div>
        <div className="mb-1 grid grid-cols-3 gap-1">
          {(["off", "before", "after"] as const).map((v) => (
            <button
              key={v}
              disabled={v !== "off" && !layers[v]}
              className={`border px-1 py-0.5 disabled:opacity-30 ${trueColour === v ? "border-[#d4ff4a] text-[#d4ff4a]" : "border-[#2a2d33]"}`}
              onClick={() => setTrueColour(v)}
            >
              {v}
            </button>
          ))}
        </div>
        {optical.product ? (
          <span className="text-[#8a8d84]">
            before {optical.before_window?.start} → {optical.before_window?.end} ({optical.pre_scenes} scenes)
            <br />
            after {optical.after_window?.start} → {optical.after_window?.end} ({optical.post_scenes} scenes)
          </span>
        ) : null}
      </div>

      <label className="mb-2 block">
        <span className="text-[#8a8d84]">opacity</span>
        <input
          className="w-full accent-[#d4ff4a]"
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
        />
      </label>

      {notes.map((n) => (
        <p key={n} className="mb-1 text-[#f5a623]">
          {n}
        </p>
      ))}
      <ClearButton onClear={onClear} />
    </div>
  );
}

function LayerRow({
  title,
  on,
  disabled,
  onToggle,
  children,
}: {
  title: string;
  on: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`mb-3 ${disabled ? "opacity-40" : ""}`}>
      <label className="mb-1 flex items-center gap-2 text-[11px]">
        <input type="checkbox" checked={on && !disabled} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
        {title}
      </label>
      <div className="pl-5 text-[#b8b6aa]">{children}</div>
    </div>
  );
}

function Ramp({ gradient, left, right }: { gradient: string; left: string; right: string }) {
  return (
    <div className="mb-1">
      <div className="h-2 w-full" style={{ background: gradient }} />
      <div className="flex justify-between text-[9px] text-[#8a8d84]">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

function ClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button className="mt-1 w-full border border-[#2a2d33] px-2 py-1" onClick={onClear}>
      Clear area
    </button>
  );
}
