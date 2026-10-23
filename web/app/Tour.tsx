"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHROME } from "@/lib/look";

export type TourStep = {
  /** [data-tour] names to point at, first one present wins. No target: the card sits in the middle. */
  target?: string | string[];
  title: string;
  body: React.ReactNode;
  /** Runs when the step opens, e.g. to put an example area on the map so its controls exist. */
  prepare?: () => void;
};

const CARD_W = 340;
const GAP = 14;
const PAD = 6;
const WAIT_MS = 2500; // how long a step waits for its target to appear before it is skipped

function find(target?: string | string[]): HTMLElement | null {
  for (const name of target ? [target].flat() : []) {
    const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
    if (el && el.getBoundingClientRect().height > 0) return el;
  }
  return null;
}

/**
 * A guided tour: dims the page, outlines one part of it at a time, and explains it in a card
 * placed beside it. Steps whose target isn't on this page are skipped.
 */
export default function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [ready, setReady] = useState(false);
  const [direction, setDirection] = useState<1 | -1>(1);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(240);
  const step = steps[index];
  const last = index === steps.length - 1;

  const go = useCallback(
    (delta: 1 | -1) => {
      const next = index + delta;
      if (next >= steps.length) return onClose();
      setDirection(delta);
      setReady(false);
      setIndex(Math.max(0, next));
    },
    [index, steps.length, onClose],
  );

  // Open the step: prepare, wait for the target, scroll it into view, then measure.
  useEffect(() => {
    let cancelled = false;
    step.prepare?.();
    if (!step.target) {
      queueMicrotask(() => {
        if (cancelled) return;
        setRect(null);
        setReady(true);
      });
      return () => {
        cancelled = true;
      };
    }
    const started = Date.now();
    const poll = () => {
      if (cancelled) return;
      const el = find(step.target);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(() => {
          if (cancelled) return;
          setRect(el.getBoundingClientRect());
          setReady(true);
        }, 380);
      } else if (Date.now() - started > WAIT_MS) {
        if (index === 0 && direction === -1) setReady(true);
        else go(direction);
      } else {
        setTimeout(poll, 120);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Follow the target as the page scrolls or resizes, and as the target itself grows (e.g. layers loading).
  useLayoutEffect(() => {
    if (!ready || !step.target) return;
    const el = find(step.target);
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [ready, step.target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
      else if (e.key === "ArrowLeft" && index > 0) go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, index, onClose]);

  // Place the card by its real height, which varies with the step's text.
  useLayoutEffect(() => {
    if (ready && cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [ready, index]);

  const card = placeCard(rect, cardH);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Tour: ${step.title}`}>
      {/* Blocks the page while the tour is open; the outlined part is shown, not clicked. */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />
      {rect && ready ? (
        <div
          className="pointer-events-none absolute border-2 border-[var(--tour-ring)] transition-all duration-200"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.62)",
          }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/62" />
      )}

      {ready ? (
        <div
          ref={cardRef}
          className={`${CHROME} on-paper absolute border border-[var(--rule)] p-5 shadow-2xl`}
          style={{ width: CARD_W, maxWidth: "calc(100vw - 24px)", ...card }}
        >
          <div className="eyebrow mb-1.5">
            {index + 1} / {steps.length}
          </div>
          <h2 className="display mb-2 text-[22px] font-semibold leading-tight">{step.title}</h2>
          <div className="space-y-2 text-[14px] leading-snug">{step.body}</div>
          <div className="mt-4 flex items-center gap-2">
            <button className="link mr-auto text-[12px]" onClick={onClose}>
              {last ? "Close" : "Skip tour"}
            </button>
            {index > 0 ? (
              <button className="btn px-3 py-1.5" onClick={() => go(-1)}>
                Back
              </button>
            ) : null}
            <button className="btn btn-primary px-4 py-1.5" onClick={() => go(1)} autoFocus>
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Below the target if it fits, else above, else beside it; always on screen. */
function placeCard(rect: DOMRect | null, estH: number): React.CSSProperties {
  if (typeof window === "undefined" || !rect) return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(12, x), vw - CARD_W - 12);
  const clampY = (y: number) => Math.min(Math.max(12, y), vh - estH - 12);
  if (rect.bottom + GAP + estH < vh) return { left: clampX(rect.left), top: rect.bottom + GAP + PAD };
  if (rect.top - GAP - estH > 0) return { left: clampX(rect.left), bottom: vh - rect.top + GAP + PAD };
  if (rect.left - GAP - CARD_W > 0) return { left: rect.left - GAP - CARD_W - PAD, top: clampY(rect.top) };
  if (rect.right + GAP + CARD_W < vw) return { left: rect.right + GAP + PAD, top: clampY(rect.top) };
  return { right: 12, bottom: 12 };
}
