"use client";

import { useEffect, useState } from "react";
import { levelInfo, type Evidence, type EvidenceCheck, type Reviewer, type Site } from "@/lib/types";

const LADDER = ["detected", "corroborated", "verified"] as const;

function reviewerHeaders(reviewer: Reviewer): Record<string, string> {
  return reviewer.enabled ? { "x-analyst-token": reviewer.token, "x-analyst": reviewer.name } : {};
}

async function fetchEvidence(siteId: string, reviewer: Reviewer): Promise<Evidence[]> {
  const res = await fetch(`/api/sites/${siteId}/evidence`, { headers: reviewerHeaders(reviewer) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Request failed");
  return data;
}

export default function LocationPanel({
  site,
  handle,
  reviewer,
  onHandle,
  onClose,
  onChanged,
}: {
  site: Site;
  handle: string;
  reviewer: Reviewer;
  onHandle: (h: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [msg, setMsg] = useState("");
  const [version, setVersion] = useState(0);
  const v = site.verification;
  const info = levelInfo(v.level);

  useEffect(() => {
    let cancelled = false;
    fetchEvidence(site.id, reviewer).then(
      (items) => !cancelled && setEvidence(items),
      () => !cancelled && setEvidence([]),
    );
    return () => {
      cancelled = true;
    };
  }, [site.id, reviewer, version]);

  async function act(fn: () => Promise<unknown>, done: string): Promise<boolean> {
    try {
      await fn();
      setMsg(done);
      setVersion((n) => n + 1);
      onChanged();
      return true;
    } catch (err) {
      setMsg((err as Error).message);
      return false;
    }
  }

  return (
    <aside className="absolute bottom-4 right-4 top-28 w-[28rem] overflow-auto border border-[#2a2d33] bg-[#0c0d10]/95 p-4 font-mono text-[11px] backdrop-blur">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-[13px] leading-5 text-[#e8e4d9]">{site.name ?? site.id}</h2>
        <button className="text-[#8a8d84]" onClick={onClose}>
          close
        </button>
      </div>

      {/* Level */}
      <div className="mb-4 border p-3" style={{ borderColor: info.color + "66" }}>
        <div className="mb-1 flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5" style={{ background: info.color }} />
          <span className="text-[12px] tracking-[0.15em]" style={{ color: info.color }}>
            {info.label.toUpperCase()}
          </span>
        </div>
        <p className="mb-2 leading-4 text-[#b8b6aa]">{v.why}</p>
        {v.level === "explained" || v.level === "disputed" ? null : (
          <div className="flex gap-1">
            {LADDER.map((step) => {
              const reached = LADDER.indexOf(step) <= LADDER.indexOf(v.level as (typeof LADDER)[number]);
              return (
                <div
                  key={step}
                  className="flex-1 border-t-2 pt-1 text-[9px] tracking-[0.1em]"
                  style={{ borderColor: reached ? levelInfo(step).color : "#2a2d33", color: reached ? "#e8e4d9" : "#555" }}
                >
                  {levelInfo(step).label.toUpperCase()}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-2 text-[10px] text-[#8a8d84]">
          {v.evidence_count} evidence item{v.evidence_count === 1 ? "" : "s"} · {v.independent_sources} independent
          source{v.independent_sources === 1 ? "" : "s"}
        </div>
      </div>

      <SatelliteReading site={site} onChanged={onChanged} />

      {/* Evidence */}
      <Heading>Evidence</Heading>
      {evidence.length === 0 ? <p className="mb-3 text-[#8a8d84]">None yet.</p> : null}
      <ul className="mb-3 space-y-2">
        {evidence.map((item) => (
          <EvidenceItem
            key={item.id}
            item={item}
            others={evidence.filter((e) => e.id !== item.id)}
            reviewer={reviewer}
            onCheck={(check) =>
              act(() => post(`/api/evidence/${item.id}/check`, check, reviewerHeaders(reviewer)), "Check saved.")
            }
          />
        ))}
      </ul>
      <AddEvidence
        handle={handle}
        onHandle={onHandle}
        onSubmit={(body) => act(() => post(`/api/sites/${site.id}/evidence`, body), "Evidence added. A reviewer will check it.")}
      />

      {/* Agreement */}
      <Heading>Do you agree?</Heading>
      <div className="mb-1 grid grid-cols-3 gap-2">
        {(["agree", "disagree", "unsure"] as const).map((stance) => (
          <button
            key={stance}
            className="border border-[#2a2d33] py-1.5 hover:border-[#8a8d84]"
            onClick={() =>
              handle.trim()
                ? act(() => post(`/api/sites/${site.id}/assessment`, { handle, stance }), "Thanks, noted.")
                : setMsg("Pick a handle first (any name; it's never shown).")
            }
          >
            {stance} · {v.agreement[stance]}
          </button>
        ))}
      </div>
      <p className="mb-4 text-[10px] leading-4 text-[#8a8d84]">
        Agreement helps reviewers decide what to look at first. It doesn&apos;t change the level: only evidence does.
      </p>

      {reviewer.enabled ? (
        <>
          <Heading>Reviewer verdict</Heading>
          <div className="mb-1 grid grid-cols-2 gap-2">
            {(
              [
                ["confirm", "Sign off as verified"],
                ["explained", "Explained"],
                ["disputed", "Disputed"],
                ["reject", "False detection"],
              ] as const
            ).map(([verdict, text]) => (
              <button
                key={verdict}
                className="border border-[#2a2d33] py-1.5 hover:border-[#d4ff4a]"
                onClick={() =>
                  act(
                    () => post(`/api/sites/${site.id}/verdict`, { verdict }, reviewerHeaders(reviewer)),
                    "Verdict saved.",
                  )
                }
              >
                {text}
              </button>
            ))}
          </div>
          <p className="mb-4 text-[10px] leading-4 text-[#8a8d84]">
            Sign-off only counts with 2+ independent sources, and only from a reviewer who checked none of them.
          </p>
        </>
      ) : null}

      {msg ? <p className="border-t border-[#2a2d33] pt-2 text-[10px] text-[#d4ff4a]">{msg}</p> : null}
      {site.is_demo ? (
        <p className="mt-2 text-[10px] text-[#8a8d84]">Demo location: synthetic data, not a finding.</p>
      ) : null}
    </aside>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 mt-1 tracking-[0.2em] text-[#8a8d84]">{String(children).toUpperCase()}</div>;
}

function SatelliteReading({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const features = Object.entries(site.features ?? {}).filter(([, value]) => value != null);
  const seismic = site.seismic as { flag?: string; events?: { magnitude?: number; place?: string; modelled_mmi?: number | null; days_before_event_window?: number | null }[] } | null;
  const [busy, setBusy] = useState(false);
  const top = seismic?.events?.[0];

  return (
    <div className="mb-4">
      <Heading>Satellite reading</Heading>
      <p className="mb-2 text-[10px] text-[#f5a623]">Machine detection. Not verified.</p>
      <div className="mb-2 grid grid-cols-3 gap-2 text-[10px]">
        <Meta k="PWTT z" v={site.pwtt_z?.toFixed(2) ?? "—"} />
        <Meta k="optical" v={site.optical_read === "cloud_gap" ? "cloud gap" : site.optical_read} />
        <Meta k="calibration" v={site.calibration_status} />
      </div>
      {site.calibration_status === "provisional" ? (
        <p className="mb-2 text-[10px] leading-4 text-[#ffd36a]">
          Burn readings are calibrated on Rakhine only. Here they are provisional.
        </p>
      ) : null}
      {site.optical_read === "cloud_gap" ? (
        <p className="mb-2 text-[10px] leading-4 text-[#6ec8ff]">
          No optical read under cloud. Radar change detection still ran; burn indices didn&apos;t.
        </p>
      ) : null}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <Chip label="before" />
        <Chip label="after" />
      </div>
      {features.length ? (
        <table className="mb-2 w-full text-left text-[10px]">
          <tbody>
            {features.map(([k, value]) => (
              <tr key={k} className="border-t border-[#2a2d33]">
                <td className="py-1 text-[#8a8d84]">{k}</td>
                <td className="py-1">{Number(value).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="border-t border-[#2a2d33] pt-2 text-[10px]">
        {seismic?.flag ? (
          <p className="leading-4">
            <span className={seismic.flag === "possible_seismic" ? "text-[#c9a227]" : "text-[#8a8d84]"}>
              {seismic.flag === "possible_seismic" ? "Possible seismic cause" : "No damaging earthquake found"}
            </span>
            {top?.magnitude ? (
              <span className="text-[#b8b6aa]">
                {" "}
                · M{top.magnitude} {top.place}
                {top.modelled_mmi ? ` · shaking MMI ${top.modelled_mmi} at site` : ""}
              </span>
            ) : null}
          </p>
        ) : (
          <button
            className="border border-[#2a2d33] px-2 py-1 disabled:opacity-50"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await fetch("/api/seismic", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ site_ids: [site.id] }),
              });
              setBusy(false);
              onChanged();
            }}
          >
            {busy ? "Checking USGS…" : "Check for earthquakes"}
          </button>
        )}
      </div>
    </div>
  );
}

const MARK: Record<string, string> = { yes: "✓", no: "✗", unsure: "?" };

function EvidenceItem({
  item,
  others,
  reviewer,
  onCheck,
}: {
  item: Evidence;
  others: Evidence[];
  reviewer: Reviewer;
  onCheck: (check: Omit<EvidenceCheck, "reviewer" | "created_at">) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = item.check;
  return (
    <li className="border border-[#2a2d33] p-2">
      <div className="mb-1 text-[10px] text-[#8a8d84]">
        {item.kind === "link" ? "LINK" : "TESTIMONY"}
        {item.visibility === "reviewers" ? " · reviewers only" : ""}
        {item.is_demo ? " · demo" : ""}
      </div>
      {item.url ? (
        <a className="break-all text-[#6ec8ff] underline" href={item.url} target="_blank" rel="noopener noreferrer nofollow">
          {item.url}
        </a>
      ) : null}
      {item.body ? <p className="whitespace-pre-wrap leading-4">{item.body}</p> : null}
      {!item.url && !item.body ? <p className="text-[#8a8d84]">Shared with reviewers only.</p> : null}
      <div className="mt-1 text-[10px]">
        {c ? (
          <span className="text-[#b8b6aa]">
            Located {MARK[c.located]} · Dated {MARK[c.dated]} · {c.original}
            {c.shares_source_with.length ? ` · same source as ${c.shares_source_with.length} other` : ""}
            <span className="text-[#8a8d84]"> · checked by {c.reviewer}</span>
          </span>
        ) : (
          <span className="text-[#f5a623]">Awaiting a reviewer check</span>
        )}
      </div>
      {reviewer.enabled ? (
        <button className="mt-1 text-[10px] text-[#d4ff4a]" onClick={() => setOpen(!open)}>
          {open ? "cancel" : c ? "re-check" : "check this item"}
        </button>
      ) : null}
      {open ? (
        <CheckForm
          others={others}
          onSubmit={(check) => {
            onCheck(check);
            setOpen(false);
          }}
        />
      ) : null}
    </li>
  );
}

function CheckForm({
  others,
  onSubmit,
}: {
  others: Evidence[];
  onSubmit: (check: Omit<EvidenceCheck, "reviewer" | "created_at">) => void;
}) {
  const [located, setLocated] = useState<"yes" | "no" | "unsure">("unsure");
  const [dated, setDated] = useState<"yes" | "no" | "unsure">("unsure");
  const [original, setOriginal] = useState<"original" | "repost" | "unsure">("unsure");
  const [shares, setShares] = useState<string[]>([]);
  const [note, setNote] = useState("");
  return (
    <div className="mt-2 space-y-1 border-t border-[#2a2d33] pt-2 text-[10px]">
      <Choice label="Located against imagery?" value={located} options={["yes", "no", "unsure"]} onChange={setLocated} />
      <Choice label="Date fits the window?" value={dated} options={["yes", "no", "unsure"]} onChange={setDated} />
      <Choice label="Source" value={original} options={["original", "repost", "unsure"]} onChange={setOriginal} />
      {others.length ? (
        <div>
          <div className="text-[#8a8d84]">Same underlying source as:</div>
          {others.map((o) => (
            <label key={o.id} className="block truncate">
              <input
                type="checkbox"
                className="mr-1"
                checked={shares.includes(o.id)}
                onChange={(e) => setShares(e.target.checked ? [...shares, o.id] : shares.filter((s) => s !== o.id))}
              />
              {o.url ?? o.body ?? o.id}
            </label>
          ))}
        </div>
      ) : null}
      <input
        className="w-full border border-[#2a2d33] bg-black px-2 py-1"
        placeholder="How you located / dated it"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="w-full border border-[#d4ff4a] py-1 text-[#d4ff4a]"
        onClick={() => onSubmit({ located, dated, original, shares_source_with: shares, note: note || null })}
      >
        Save check
      </button>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[#8a8d84]">{label}</span>
      <span className="flex gap-1">
        {options.map((o) => (
          <button
            key={o}
            className={`border px-1.5 ${value === o ? "border-[#d4ff4a] text-[#d4ff4a]" : "border-[#2a2d33]"}`}
            onClick={() => onChange(o)}
          >
            {o}
          </button>
        ))}
      </span>
    </div>
  );
}

function AddEvidence({
  handle,
  onHandle,
  onSubmit,
}: {
  handle: string;
  onHandle: (h: string) => void;
  onSubmit: (body: { kind: string; url?: string; body?: string; visibility: string; handle: string }) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<"link" | "testimony">("link");
  const [text, setText] = useState("");
  const [privateItem, setPrivateItem] = useState(false);
  return (
    <div className="mb-4 border border-dashed border-[#2a2d33] p-2">
      <div className="mb-2 flex gap-2">
        {(["link", "testimony"] as const).map((k) => (
          <button
            key={k}
            className={`border px-2 py-0.5 ${kind === k ? "border-[#d4ff4a] text-[#d4ff4a]" : "border-[#2a2d33]"}`}
            onClick={() => setKind(k)}
          >
            {k === "link" ? "Add a link" : "Add testimony"}
          </button>
        ))}
      </div>
      {kind === "link" ? (
        <input
          className="mb-2 w-full border border-[#2a2d33] bg-black px-2 py-1"
          placeholder="https://… (post, video, article)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <textarea
          className="mb-2 h-20 w-full border border-[#2a2d33] bg-black px-2 py-1"
          placeholder="What did you see, and when?"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <input
        className="mb-2 w-full border border-[#2a2d33] bg-black px-2 py-1"
        placeholder="Your handle (any name; never shown publicly)"
        value={handle}
        onChange={(e) => onHandle(e.target.value)}
      />
      <label className="mb-2 flex items-start gap-2 text-[10px] leading-4">
        <input type="checkbox" checked={privateItem} onChange={(e) => setPrivateItem(e.target.checked)} />
        Share with reviewers only. It still counts towards verification, but its content isn&apos;t published.
      </label>
      <p className="mb-2 text-[10px] leading-4 text-[#8a8d84]">
        Who submitted evidence is never shown. Don&apos;t include names or faces of people who could be put at risk.
      </p>
      <button
        className="w-full border border-[#d4ff4a]/60 py-1.5 text-[#d4ff4a] disabled:opacity-40"
        disabled={!text.trim()}
        onClick={async () => {
          const ok = await onSubmit({
            kind,
            ...(kind === "link" ? { url: text } : { body: text }),
            visibility: privateItem ? "reviewers" : "public",
            handle,
          });
          if (ok) setText("");
        }}
      >
        Submit evidence
      </button>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[#8a8d84]">{k}</div>
      <div>{v}</div>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <div className="flex h-20 items-center justify-center border border-[#2a2d33] bg-black text-[10px] text-[#555]">
      {label} · imagery after first scan
    </div>
  );
}
