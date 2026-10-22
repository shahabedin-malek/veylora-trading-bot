"use client";

import { CircleAlert, Download, MessageSquarePlus, RefreshCw, Search, StickyNote } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

/**
 * The support desk.
 *
 * One panel, one ticket at a time: the list on the left, the thread, the internal
 * notes and the account's whole timeline on the right. It fetches the same routes
 * the API exposes, so what an operator can do here is exactly what an API caller
 * can do — there is no second, hidden rule in the component.
 *
 * Two distinctions are visible rather than merely stored: an INTERNAL message is
 * labelled and styled apart from a PUBLIC one, and the account timeline shows the
 * support events beside its sign-ins, money, trades and audit rows. Every failure
 * is a sentence that clears the loading state.
 */

type TicketRow = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  userId: string;
  accountLabel: string;
  assigneeUserId: string | null;
  assigneeLabel: string | null;
  relatedType: string | null;
  relatedId: string | null;
  messageCount: number;
  lastMessageAt: string;
  updatedAt: string;
};

type TicketDetail = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  userId: string;
  accountLabel: string;
  accountRole: string;
  assigneeUserId: string | null;
  assigneeLabel: string | null;
  relatedType: string | null;
  relatedId: string | null;
  relatedLabel: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  closedAt: string | null;
  messages: { id: string; authorType: string; authorLabel: string; visibility: string; body: string; createdAt: string }[];
  notes: { id: string; authorLabel: string; body: string; createdAt: string }[];
  counts: { public: number; internal: number };
  tickets: { id: string; subject: string; status: string }[];
};

type SavedReply = { id: string; name: string; body: string; updatedAt: string };

type TimelineItem = {
  id: string;
  category: string;
  occurredAt: string;
  title: string;
  detail: string;
  source: string;
};

type SearchPayload = {
  q: string;
  count: number;
  groups: {
    tickets: { id: string; subject: string; status: string; userId: string; accountLabel: string }[];
    messages: { id: string; ticketId: string; subject: string; visibility: string; excerpt: string; createdAt: string }[];
    notes: { id: string; userId: string; accountLabel: string; excerpt: string; createdAt: string }[];
    timeline: { id: string; action: string; objectType: string; objectId: string | null; occurredAt: string }[];
  };
  error?: string;
};

const STATUSES = ["OPEN", "PENDING", "RESOLVED", "CLOSED"];
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
const RELATED_TYPES = ["order", "withdrawal", "strategy", "deposit"];

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    if (!response.ok) {
      const reason = typeof record.error === "string" ? record.error : `The support desk answered ${response.status}.`;
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      return { error: requestId ? `${reason} (request ${requestId})` : reason } as T;
    }
    return payload as T;
  } catch {
    return { error: `The support desk could not reach ${path}.` } as T;
  }
}

function moment(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : value;
}

export function SupportDesk({ operatorLabel }: { operatorLabel: string }) {
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);

  const [messageBody, setMessageBody] = useState("");
  const [visibility, setVisibility] = useState<"PUBLIC" | "INTERNAL">("PUBLIC");
  const [noteBody, setNoteBody] = useState("");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
  const [priorityDraft, setPriorityDraft] = useState("");
  const [assigneeDraft, setAssigneeDraft] = useState("");

  const [newUserId, setNewUserId] = useState("dev-test-account");
  const [newSubject, setNewSubject] = useState("");
  const [newPriority, setNewPriority] = useState("NORMAL");
  const [newRelatedType, setNewRelatedType] = useState("");
  const [newRelatedId, setNewRelatedId] = useState("");

  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyName, setReplyName] = useState("");
  const [replyBody, setReplyBody] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState<SearchPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    if (priority) params.set("priority", priority);
    void (async () => {
      const payload = await readJson<{ tickets: TicketRow[]; error?: string }>(
        `/api/admin/support/tickets?${params.toString()}`,
      );
      if (cancelled) return;
      if (payload.error) {
        setListError(payload.error);
        return;
      }
      setListError(null);
      setTickets(payload.tickets ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [q, status, priority, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const payload = await readJson<{ replies: SavedReply[]; error?: string }>("/api/admin/support/replies");
      if (cancelled) return;
      if (payload.error) {
        setReplyError(payload.error);
        return;
      }
      setReplies(payload.replies ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const loadTicket = useCallback(async (ticketId: string) => {
    setDetailError(null);
    const payload = await readJson<{ ticket: TicketDetail; error?: string }>(`/api/admin/support/tickets/${ticketId}`);
    if (payload.error) {
      setDetailError(payload.error);
      return;
    }
    setDetail(payload.ticket);
    setStatusDraft(payload.ticket.status);
    setPriorityDraft(payload.ticket.priority);
    setAssigneeDraft(payload.ticket.assigneeUserId ?? "");
    setActionMessage(null);
    const record = await readJson<{ timeline: TimelineItem[]; error?: string }>(
      `/api/admin/console/record?type=user&id=${encodeURIComponent(payload.ticket.userId)}`,
    );
    setTimeline(record.timeline ?? []);
  }, []);

  async function createTicket() {
    setBusy(true);
    setActionMessage(null);
    const payload = await readJson<{ ticket: TicketDetail; error?: string }>("/api/admin/support/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: newUserId,
        subject: newSubject,
        priority: newPriority,
        relatedType: newRelatedType || undefined,
        relatedId: newRelatedType ? newRelatedId : undefined,
      }),
    });
    setBusy(false);
    if (payload.error) {
      setActionMessage(payload.error);
      return;
    }
    setNewSubject("");
    setNewRelatedType("");
    setNewRelatedId("");
    setRefreshKey((key) => key + 1);
    await loadTicket(payload.ticket.id);
    setActionMessage(`Created ticket ${payload.ticket.id} and audited it.`);
  }

  async function addMessage() {
    if (!detail) return;
    setBusy(true);
    setActionMessage(null);
    const payload = await readJson<{ ticket: TicketDetail; error?: string }>(
      `/api/admin/support/tickets/${detail.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: messageBody, visibility }),
      },
    );
    setBusy(false);
    if (payload.error) {
      setActionMessage(payload.error);
      return;
    }
    setMessageBody("");
    setDetail(payload.ticket);
    setRefreshKey((key) => key + 1);
    setActionMessage(visibility === "INTERNAL" ? "Added an internal message; the account cannot read it." : "Added a public message.");
  }

  async function addNote() {
    if (!detail) return;
    setBusy(true);
    const payload = await readJson<{ error?: string }>("/api/admin/support/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: detail.userId, body: noteBody }),
    });
    setBusy(false);
    if (payload.error) {
      setActionMessage(payload.error);
      return;
    }
    setNoteBody("");
    await loadTicket(detail.id);
    setActionMessage("Added an internal note on the account.");
  }

  async function saveTicket() {
    if (!detail) return;
    setBusy(true);
    const payload = await readJson<{ ticket: TicketDetail; error?: string }>(`/api/admin/support/tickets/${detail.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: statusDraft,
        priority: priorityDraft,
        assigneeUserId: assigneeDraft || null,
      }),
    });
    setBusy(false);
    if (payload.error) {
      setActionMessage(payload.error);
      return;
    }
    setDetail(payload.ticket);
    setRefreshKey((key) => key + 1);
    setActionMessage(`Saved. Status is ${payload.ticket.status}; a status change is audited with before and after.`);
  }

  async function insertReply(reply: SavedReply) {
    if (!detail) {
      setActionMessage("Open a ticket before inserting a saved reply.");
      return;
    }
    const payload = await readJson<{ rendered: string; error?: string }>(
      `/api/admin/support/replies/preview?replyId=${encodeURIComponent(reply.id)}&ticketId=${encodeURIComponent(detail.id)}`,
    );
    if (payload.error) {
      setActionMessage(payload.error);
      return;
    }
    setMessageBody(payload.rendered);
    setVisibility("PUBLIC");
    setActionMessage(`Inserted “${reply.name}” with this account's details.`);
  }

  async function saveReply() {
    setBusy(true);
    const payload = await readJson<{ reply: SavedReply; error?: string }>("/api/admin/support/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: replyName, body: replyBody }),
    });
    setBusy(false);
    if (payload.error) {
      setActionMessage(payload.error);
      return;
    }
    setReplyName("");
    setReplyBody("");
    setRefreshKey((key) => key + 1);
    setActionMessage(`Saved reply “${payload.reply.name}”.`);
  }

  async function runSearch() {
    if (searchTerm.trim().length < 2) {
      setSearchResult({ q: searchTerm, count: 0, groups: { tickets: [], messages: [], notes: [], timeline: [] }, error: "Search needs at least two characters." });
      return;
    }
    setSearchResult(await readJson<SearchPayload>(`/api/admin/support/search?q=${encodeURIComponent(searchTerm.trim())}`));
  }

  return (
    <div className="support-desk">
      <section className="data-section" aria-labelledby="support-search-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">SEARCH / TICKETS · NOTES · TIMELINE</div>
            <h2 id="support-search-title">Find a conversation or a note</h2>
          </div>
          <span className="section-state">EVERY RESULT LINKS TO ITS RECORD</span>
        </div>
        <form
          className="admin-console__search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <label className="trading-field">
            <span>Search term</span>
            <input maxLength={160} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Subject, message, note, action or wallet" value={searchTerm} />
          </label>
          <button className="section-action" type="submit">
            <Search aria-hidden="true" size={14} /> SEARCH
          </button>
        </form>
        {searchResult?.error && <p className="admin-console__error" role="alert">{searchResult.error}</p>}
        {searchResult && !searchResult.error && (
          <div className="admin-console__search-results" role="status">
            <p>{searchResult.count} result(s) for <code>{searchResult.q}</code>.</p>
            {searchResult.groups.tickets.length > 0 && (
              <div>
                <strong>Tickets</strong>
                <ul>
                  {searchResult.groups.tickets.map((ticket) => (
                    <li key={ticket.id}>
                      <button className="admin-console__link" onClick={() => void loadTicket(ticket.id)} type="button">
                        <strong>{ticket.subject}</strong>
                        <span>{ticket.status} · {ticket.accountLabel} · {ticket.id}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {searchResult.groups.messages.length > 0 && (
              <div>
                <strong>Messages</strong>
                <ul>
                  {searchResult.groups.messages.map((message) => (
                    <li key={message.id}>
                      <button className="admin-console__link" onClick={() => void loadTicket(message.ticketId)} type="button">
                        <strong>{message.subject} · {message.visibility}</strong>
                        <span>{message.excerpt}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {searchResult.groups.notes.length > 0 && (
              <div>
                <strong>Internal notes</strong>
                <ul>
                  {searchResult.groups.notes.map((note) => (
                    <li key={note.id}>
                      <strong>{note.accountLabel}</strong>
                      <span>{note.excerpt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {searchResult.groups.timeline.length > 0 && (
              <div>
                <strong>Timeline content</strong>
                <ul>
                  {searchResult.groups.timeline.map((event) => (
                    <li key={event.id}>
                      <strong>{event.action}</strong>
                      <span>{event.objectType} {event.objectId ?? ""} · {moment(event.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="support-desk__columns">
        <section className="data-section" aria-labelledby="support-tickets-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">CONVERSATIONS</div>
              <h2 id="support-tickets-title">Tickets</h2>
            </div>
            <span className="section-state">{tickets.length} LISTED</span>
          </div>
          <div className="admin-console__toolbar">
            <form className="admin-console__filters" onSubmit={(event) => event.preventDefault()}>
              <label className="trading-field">
                <span>Filter</span>
                <input maxLength={160} onChange={(event) => setQ(event.target.value)} placeholder="Subject, account, id" value={q} />
              </label>
              <label className="trading-field">
                <span>Status</span>
                <select onChange={(event) => setStatus(event.target.value)} value={status}>
                  <option value="">Any</option>
                  {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="trading-field">
                <span>Priority</span>
                <select onChange={(event) => setPriority(event.target.value)} value={priority}>
                  <option value="">Any</option>
                  {PRIORITIES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </form>
          </div>
          {listError && <p className="admin-console__error" role="alert">{listError}</p>}
          <ul className="support-desk__tickets">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <button
                  className={`support-desk__ticket${detail?.id === ticket.id ? " is-active" : ""}`}
                  onClick={() => void loadTicket(ticket.id)}
                  type="button"
                >
                  <strong>{ticket.subject}</strong>
                  <span>{ticket.status} · {ticket.priority} · {ticket.messageCount} message(s)</span>
                  <span>{ticket.accountLabel}</span>
                  <small>{moment(ticket.lastMessageAt)}{ticket.relatedType ? ` · ${ticket.relatedType} ${ticket.relatedId}` : ""}</small>
                </button>
              </li>
            ))}
          </ul>
          {tickets.length === 0 && !listError && <p className="trading-empty">No ticket matches these filters.</p>}

          <div className="support-desk__create">
            <strong>Open a ticket</strong>
            <label className="trading-field">
              <span>Account id</span>
              <input maxLength={128} onChange={(event) => setNewUserId(event.target.value)} value={newUserId} />
            </label>
            <label className="trading-field">
              <span>Subject</span>
              <input maxLength={140} onChange={(event) => setNewSubject(event.target.value)} placeholder="Deposit did not arrive" value={newSubject} />
            </label>
            <label className="trading-field">
              <span>Priority</span>
              <select onChange={(event) => setNewPriority(event.target.value)} value={newPriority}>
                {PRIORITIES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="trading-field">
              <span>Link a record (optional)</span>
              <select onChange={(event) => setNewRelatedType(event.target.value)} value={newRelatedType}>
                <option value="">No link</option>
                {RELATED_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            {newRelatedType && (
              <label className="trading-field">
                <span>{newRelatedType} id</span>
                <input maxLength={128} onChange={(event) => setNewRelatedId(event.target.value)} value={newRelatedId} />
              </label>
            )}
            <button className="section-action" disabled={busy || newSubject.trim().length < 3} onClick={() => void createTicket()} type="button">
              <MessageSquarePlus aria-hidden="true" size={14} /> OPEN TICKET
            </button>
          </div>
        </section>

        <section className="data-section" aria-labelledby="support-thread-title">
          <div className="section-heading">
            <div>
              <div className="section-kicker">CONVERSATION / ONE TICKET</div>
              <h2 id="support-thread-title">{detail?.subject ?? "No ticket open"}</h2>
              {detail && (
                <p>
                  {detail.accountLabel} · {detail.accountRole} · opened {moment(detail.createdAt)} ·{" "}
                  {detail.counts.public} public / {detail.counts.internal} internal
                </p>
              )}
            </div>
            <span className="section-state">{detail ? detail.status : "SELECT A TICKET"}</span>
          </div>
          {detailError && <p className="admin-console__error" role="alert">{detailError}</p>}
          {actionMessage && <p className="admin-console__muted" role="status">{actionMessage}</p>}
          {!detail && !detailError && <p className="trading-empty">Open a ticket from the list, or create one.</p>}

          {detail && (
            <>
              <div className="support-desk__controls">
                <label className="trading-field">
                  <span>Status</span>
                  <select onChange={(event) => setStatusDraft(event.target.value)} value={statusDraft}>
                    {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="trading-field">
                  <span>Priority</span>
                  <select onChange={(event) => setPriorityDraft(event.target.value)} value={priorityDraft}>
                    {PRIORITIES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="trading-field">
                  <span>Assignee id</span>
                  <input maxLength={128} onChange={(event) => setAssigneeDraft(event.target.value)} placeholder="unassigned" value={assigneeDraft} />
                </label>
                <button className="section-action" disabled={busy} onClick={() => void saveTicket()} type="button">
                  <RefreshCw aria-hidden="true" size={14} /> SAVE
                </button>
                <a className="section-action" download href={`/api/admin/support/tickets/${detail.id}/export`}>
                  <Download aria-hidden="true" size={14} /> EXPORT
                </a>
              </div>

              <dl className="admin-console__fields">
                <div>
                  <dt>Linked record</dt>
                  <dd>{detail.relatedType ? `${detail.relatedType} ${detail.relatedId} · ${detail.relatedLabel ?? "missing"}` : "none"}</dd>
                </div>
                <div>
                  <dt>Assignee</dt>
                  <dd>{detail.assigneeLabel ?? "unassigned"}</dd>
                </div>
                <div>
                  <dt>Last message</dt>
                  <dd>{moment(detail.lastMessageAt)}</dd>
                </div>
              </dl>

              <ol className="support-desk__thread">
                {detail.messages.map((message) => (
                  <li className={message.visibility === "INTERNAL" ? "is-internal" : undefined} key={message.id}>
                    <header>
                      <strong>{message.authorLabel}</strong>
                      <span>{message.authorType} · {message.visibility}{message.visibility === "INTERNAL" ? " · not sent to the account" : ""}</span>
                      <time dateTime={message.createdAt}>{moment(message.createdAt)}</time>
                    </header>
                    <p>{message.body}</p>
                  </li>
                ))}
                {detail.messages.length === 0 && <li className="trading-empty">No message on this ticket yet.</li>}
              </ol>

              <div className="support-desk__composer">
                <label className="trading-field">
                  <span>Message</span>
                  <textarea maxLength={4000} onChange={(event) => setMessageBody(event.target.value)} rows={4} value={messageBody} />
                </label>
                <label className="trading-field">
                  <span>Visibility</span>
                  <select onChange={(event) => setVisibility(event.target.value === "INTERNAL" ? "INTERNAL" : "PUBLIC")} value={visibility}>
                    <option value="PUBLIC">PUBLIC — the account can read it</option>
                    <option value="INTERNAL">INTERNAL — staff only</option>
                  </select>
                </label>
                <button className="section-action" disabled={busy || messageBody.trim().length === 0} onClick={() => void addMessage()} type="button">
                  <MessageSquarePlus aria-hidden="true" size={14} /> ADD MESSAGE
                </button>
              </div>

              <div className="support-desk__notes">
                <div className="admin-console__views-head">
                  <strong>Internal notes on this account</strong>
                  <span>{detail.notes.length} note(s) · never sent to the account</span>
                </div>
                <ul>
                  {detail.notes.map((note) => (
                    <li key={note.id}>
                      <span>{moment(note.createdAt)} · {note.authorLabel}</span>
                      <p>{note.body}</p>
                    </li>
                  ))}
                  {detail.notes.length === 0 && <li className="admin-console__muted">No note on this account yet.</li>}
                </ul>
                <label className="trading-field">
                  <span>New note</span>
                  <textarea maxLength={4000} onChange={(event) => setNoteBody(event.target.value)} rows={3} value={noteBody} />
                </label>
                <button className="section-action" disabled={busy || noteBody.trim().length === 0} onClick={() => void addNote()} type="button">
                  <StickyNote aria-hidden="true" size={14} /> ADD INTERNAL NOTE
                </button>
              </div>

              <div className="support-desk__timeline">
                <div className="admin-console__views-head">
                  <strong>Account timeline</strong>
                  <span>{timeline.length} event(s), newest first</span>
                </div>
                <ol>
                  {timeline.map((item) => (
                    <li className={`admin-console__timeline-item admin-console__timeline-item--${item.category}`} key={item.id}>
                      <span className="admin-console__timeline-category">{item.category}</span>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                      <time dateTime={item.occurredAt}>{moment(item.occurredAt)}</time>
                      <small>{item.source}</small>
                    </li>
                  ))}
                </ol>
                {timeline.length === 0 && <p className="trading-empty">The account has no timeline event yet.</p>}
              </div>
            </>
          )}
        </section>
      </div>

      <section className="data-section" aria-labelledby="support-replies-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">REUSABLE / PLACEHOLDERS</div>
            <h2 id="support-replies-title">Saved replies</h2>
            <p>Every value is filled from the open ticket&apos;s account, the ledger and {operatorLabel} — never from the form.</p>
          </div>
          <span className="section-state">{replies.length} SAVED</span>
        </div>
        {replyError && <p className="admin-console__error" role="alert">{replyError}</p>}
        <ul className="support-desk__replies">
          {replies.map((reply) => (
            <li key={reply.id}>
              <strong>{reply.name}</strong>
              <p>{reply.body}</p>
              <button className="section-action" disabled={!detail} onClick={() => void insertReply(reply)} type="button">
                INSERT INTO TICKET
              </button>
            </li>
          ))}
          {replies.length === 0 && <li className="admin-console__muted">No saved reply yet.</li>}
        </ul>
        <div className="support-desk__composer">
          <label className="trading-field">
            <span>Name</span>
            <input maxLength={60} onChange={(event) => setReplyName(event.target.value)} value={replyName} />
          </label>
          <label className="trading-field">
            <span>Body — use {"{{user.label}}"}, {"{{account.summary}}"}, {"{{ticket.id}}"}</span>
            <textarea maxLength={4000} onChange={(event) => setReplyBody(event.target.value)} rows={4} value={replyBody} />
          </label>
          <button className="section-action" disabled={busy || replyName.trim().length === 0 || replyBody.trim().length === 0} onClick={() => void saveReply()} type="button">
            SAVE REPLY
          </button>
        </div>
        <p className="admin-console__muted">
          <CircleAlert aria-hidden="true" size={12} /> A body that contains a key, token or password is refused when saved; an export redacts one that predates that rule.
        </p>
      </section>
    </div>
  );
}
