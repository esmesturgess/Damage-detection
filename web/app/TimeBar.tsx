"use client";

import { CHROME } from "@/lib/look";

// Sentinel-1 radar starts October 2014; Sentinel-2 optical (burn indices)
// is usable from mid-2015. Months are indexed from the radar start.
const ORIGIN = { y: 2014, m: 9 }; // month is 0-based: October
const OPTICAL_FROM = monthIndex(2015, 6); // July 2015
const LONG_RANGE_MONTHS = 6;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthIndex(y: number, m: number): number {
  return (y - ORIGIN.y) * 12 + (m - ORIGIN.m);
}

function fromIndex(i: number): { y: number; m: number } {
  const total = ORIGIN.y * 12 + ORIGIN.m + i;
  return { y: Math.floor(total / 12), m: total % 12 };
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function label(i: number): string {
  const { y, m } = fromIndex(i);
  return `${MONTHS[m]} ${y}`;
}

export function currentMonthIndex(): number {
  const now = new Date();
  return monthIndex(now.getUTCFullYear(), now.getUTCMonth());
}

/** Event window from the clamped months; baseline is the 12 months before it. */
export function windows(start: number, end: number) {
  const s = fromIndex(start);
  const e = fromIndex(end);
  const lastDay = new Date(Date.UTC(e.y, e.m + 1, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);
  const eventEnd = iso(e.y, e.m, lastDay);
  const b = fromIndex(start - 12);
  const dayBefore = new Date(Date.UTC(s.y, s.m, 0));
  return {
    event: { start: iso(s.y, s.m, 1), end: eventEnd < today ? eventEnd : today },
    baseline: { start: iso(b.y, b.m, 1), end: dayBefore.toISOString().slice(0, 10) },
  };
}

export default function TimeBar({
  start,
  end,
  onChange,
}: {
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}) {
  const max = currentMonthIndex();
  const span = end - start + 1;
  const pct = (i: number) => (i / max) * 100;
  const years: number[] = [];
  for (let y = ORIGIN.y + 1; y <= fromIndex(max).y; y++) years.push(y);
  const notes: string[] = [];
  if (span > LONG_RANGE_MONTHS)
    notes.push(`${span} months: change detection gets weaker over long ranges. Narrow it if you can.`);
  if (start < OPTICAL_FROM) notes.push("Radar only before Jul 2015: no burn indices.");
  if (start < 12) notes.push("Baseline starts before Sentinel-1 coverage; fewer prior scenes.");

  return (
    <div className={`${CHROME} on-paper pointer-events-auto flex min-h-[86px] flex-col justify-center border border-[var(--rule)] px-5 pb-2 pt-2.5`}>
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <span className="display text-[20px] font-semibold">
          {label(start)} <span className="muted font-normal">→</span> {label(end)}
        </span>
        <span className="muted text-[12px]">compared with the 12 months before</span>
      </div>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--line)]" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 bg-[repeating-linear-gradient(45deg,var(--line)_0_3px,transparent_3px_6px)]"
          style={{ left: 0, width: `${pct(OPTICAL_FROM)}%` }}
          title="Radar only (no Sentinel-2 optical yet)"
        />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]"
          style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
        />
        <input
          aria-label="Start month"
          className="range-thumb absolute inset-0 w-full"
          type="range"
          min={0}
          max={max}
          value={start}
          onChange={(e) => onChange(Math.min(Number(e.target.value), end), end)}
        />
        <input
          aria-label="End month"
          className="range-thumb absolute inset-0 w-full"
          type="range"
          min={0}
          max={max}
          value={end}
          onChange={(e) => onChange(start, Math.max(Number(e.target.value), start))}
        />
      </div>
      <div className="faint num relative h-4 text-[10.5px]">
        {years.map((y) => (
          <span key={y} className="absolute -translate-x-1/2" style={{ left: `${pct(monthIndex(y, 0))}%` }}>
            {y}
          </span>
        ))}
      </div>
      {notes.length ? <div className="mt-1 text-[12px] font-semibold">{notes.join(" · ")}</div> : null}
    </div>
  );
}
