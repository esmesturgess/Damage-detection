"use client";

const STEPS = [
  {
    title: "Choose when",
    body: "Drag the handles on the time bar. It's compared with the 12 months before.",
  },
  {
    title: "Choose where",
    body: "Draw a box on the map or enter coordinates.",
  },
  {
    title: "Scan and investigate",
    body: "Press Scan for change under the box, then open a dot to add evidence.",
  },
];

export default function Intro({ onClose, onExample }: { onClose: () => void; onExample: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6">
      <div className="panel on-paper w-full max-w-lg p-7">
        <div className="mb-6 flex items-center gap-2.5">
          <h1 className="display text-[34px] font-semibold leading-none">Corroborator</h1>
        </div>
        <ol className="mb-6 space-y-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3.5">
              <span className="num flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--rule)] font-bold text-[var(--accent)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <div className="font-semibold">{step.title}</div>
                <p className="muted leading-snug">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <button className="btn btn-primary flex-1" onClick={onExample}>
            Show me an example
          </button>
          <button className="btn flex-1" onClick={onClose}>
            Start exploring
          </button>
        </div>
      </div>
    </div>
  );
}
