"use client";

import { useState } from "react";
import type { Comment } from "@/lib/types";

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * The site's open thread. An investigation's question is the opening post.
 * Comments are conversation only; they never change the verification level.
 */
export default function Discussion({
  question,
  askedBy,
  askedAt,
  comments,
  handle,
  onHandle,
  onPost,
}: {
  question: string | null;
  askedBy: string | null;
  askedAt: string;
  comments: Comment[];
  handle: string;
  onHandle: (h: string) => void;
  onPost: (body: string) => Promise<boolean>;
}) {
  return (
    <section>
      <h2 className="mb-1 text-[18px] font-semibold">Discussion</h2>
      <p className="muted mb-4 text-[12px]">Open to everyone in the group. Comments don&apos;t change the verification level.</p>
      <ol className="mb-4 space-y-0">
        {question ? (
          <Post author={askedBy ?? "investigator"} at={askedAt} tag="opened with">
            <p className="text-[16px] leading-snug">{question}</p>
          </Post>
        ) : null}
        {comments.map((c) => (
          <Post key={c.id} author={c.author} at={c.created_at}>
            <p className="whitespace-pre-wrap leading-snug">{c.body}</p>
          </Post>
        ))}
      </ol>
      {!question && comments.length === 0 ? (
        <p className="muted mb-3">Nothing said yet. Start the conversation.</p>
      ) : null}
      <Composer handle={handle} onHandle={onHandle} onPost={onPost} placeholder="Add to the discussion" />
    </section>
  );
}

function Post({ author, at, tag, children }: { author: string; at: string; tag?: string; children: React.ReactNode }) {
  return (
    <li className="relative border-l-2 border-[var(--line)] pb-4 pl-4 last:pb-1">
      <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-[#f4efe6]" aria-hidden />
      <div className="mb-0.5 text-[12px]">
        <span className="font-semibold">{author}</span>
        {tag ? <span className="muted"> {tag}</span> : null}
        <span className="faint num"> · {when(at)}</span>
      </div>
      {children}
    </li>
  );
}

/** Comments under one evidence item, collapsed until opened. */
export function EvidenceComments({
  comments,
  handle,
  onHandle,
  onPost,
}: {
  comments: Comment[];
  handle: string;
  onHandle: (h: string) => void;
  onPost: (body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 border-t border-[var(--line)] pt-2">
      <button className="link text-[12px]" onClick={() => setOpen(!open)}>
        {open ? "Hide comments" : comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "Comment"}
      </button>
      {open ? (
        <div className="mt-2 space-y-2.5">
          {comments.map((c) => (
            <div key={c.id} className="text-[12px]">
              <span className="font-semibold">{c.author}</span>
              <span className="faint num"> · {when(c.created_at)}</span>
              <p className="whitespace-pre-wrap text-[13px] leading-snug">{c.body}</p>
            </div>
          ))}
          <Composer handle={handle} onHandle={onHandle} onPost={onPost} placeholder="Comment on this item" compact />
        </div>
      ) : null}
    </div>
  );
}

function Composer({
  handle,
  onHandle,
  onPost,
  placeholder,
  compact = false,
}: {
  handle: string;
  onHandle: (h: string) => void;
  onPost: (body: string) => Promise<boolean>;
  placeholder: string;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [named, setNamed] = useState(Boolean(handle.trim()));
  return (
    <div className="space-y-2">
      <textarea
        className={`field ${compact ? "h-16" : "h-20"}`}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        {named && handle.trim() ? (
          <span className="muted flex-1 text-[12px]">
            as <span className="font-semibold text-[var(--foreground)]">{handle}</span>{" "}
            <button className="link" onClick={() => setNamed(false)}>
              change
            </button>
          </span>
        ) : (
          <input
            className="field flex-1"
            placeholder="Your handle"
            value={handle}
            onChange={(e) => onHandle(e.target.value)}
            onBlur={() => handle.trim() && setNamed(true)}
          />
        )}
        <button
          className="btn btn-primary px-4"
          disabled={busy || !text.trim() || !handle.trim()}
          onClick={async () => {
            setBusy(true);
            if (await onPost(text)) setText("");
            setBusy(false);
            setNamed(true);
          }}
        >
          Post
        </button>
      </div>
    </div>
  );
}
