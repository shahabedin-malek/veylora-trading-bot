"use client";

import { ExternalLink, FileSearch, LoaderCircle, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { IntegrationFeatureSettings } from "@/lib/integrations/features";

type Mode = "search" | "extract";
type Topic = "general" | "news" | "finance";
type SearchResult = { title: string; url: string; content: string; score: number | null; publishedDate: string | null };
type ExtractResult = { url: string; content: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(value: unknown, fallback: string): Error {
  return new Error(isRecord(value) && typeof value.error === "string" ? value.error : fallback);
}

function parseSearchResults(value: unknown): SearchResult[] {
  if (!isRecord(value) || !Array.isArray(value.results)) throw new Error("Search response was invalid.");
  return value.results.flatMap((item): SearchResult[] => {
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.content !== "string") return [];
    return [{
      title: item.title,
      url: item.url,
      content: item.content,
      score: typeof item.score === "number" ? item.score : null,
      publishedDate: typeof item.publishedDate === "string" ? item.publishedDate : null,
    }];
  });
}

function parseExtractResults(value: unknown): { results: ExtractResult[]; failed: string[] } {
  if (!isRecord(value) || !Array.isArray(value.results)) throw new Error("Extract response was invalid.");
  return {
    results: value.results.flatMap((item): ExtractResult[] => {
      if (!isRecord(item) || typeof item.url !== "string" || typeof item.content !== "string") return [];
      return [{ url: item.url, content: item.content }];
    }),
    failed: Array.isArray(value.failed) ? value.failed.filter((item): item is string => typeof item === "string") : [],
  };
}

export function ResearchDesk({ settings }: { settings: IntegrationFeatureSettings | null }) {
  const [mode, setMode] = useState<Mode>("search");
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<Topic>("general");
  const [urlText, setUrlText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [extractResults, setExtractResults] = useState<ExtractResult[]>([]);
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const searchEnabled = settings?.tavilySearchEnabled === true;
  const extractEnabled = settings?.tavilyExtractEnabled === true;
  const modeEnabled = mode === "search" ? searchEnabled : extractEnabled;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modeEnabled || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setSearchResults([]);
    setExtractResults([]);
    setFailedUrls([]);

    try {
      const isSearch = mode === "search";
      const urls = urlText.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
      const response = await fetch(`/api/research/tavily/${mode}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSearch ? { query, topic } : { urls }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw responseError(payload, "Tavily request failed.");

      if (isSearch) {
        const results = parseSearchResults(payload);
        setSearchResults(results);
        setNotice(`${results.length} sources found.`);
      } else {
        const result = parseExtractResults(payload);
        setExtractResults(result.results);
        setFailedUrls(result.failed);
        setNotice(`${result.results.length} pages extracted.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tavily request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="research-workbench">
      <div className="research-toolbar">
        <div className="research-mode" role="group" aria-label="Research operation">
          <button aria-pressed={mode === "search"} className={mode === "search" ? "is-selected" : undefined} onClick={() => setMode("search")} type="button">
            <Search aria-hidden="true" size={14} /> SEARCH
          </button>
          <button aria-pressed={mode === "extract"} className={mode === "extract" ? "is-selected" : undefined} onClick={() => setMode("extract")} type="button">
            <FileSearch aria-hidden="true" size={14} /> EXTRACT
          </button>
        </div>
        <span className="section-state">KEYLESS / RATE-LIMITED</span>
      </div>

      <form className="research-form" onSubmit={submit}>
        {mode === "search" ? (
          <>
            <label className="risk-policy-field" htmlFor="tavily-query">
              <span>SEARCH THE WEB</span>
              <input id="tavily-query" maxLength={400} onChange={(event) => setQuery(event.target.value)} required value={query} />
              <small>Up to 400 characters · basic depth · 5 results</small>
            </label>
            <label className="risk-policy-field" htmlFor="tavily-topic">
              <span>TOPIC</span>
              <select id="tavily-topic" onChange={(event) => setTopic(event.target.value as Topic)} value={topic}>
                <option value="general">General</option>
                <option value="news">News</option>
                <option value="finance">Finance</option>
              </select>
            </label>
          </>
        ) : (
          <label className="risk-policy-field research-url-field" htmlFor="tavily-urls">
            <span>PUBLIC HTTPS URLS</span>
            <textarea id="tavily-urls" maxLength={6_200} onChange={(event) => setUrlText(event.target.value)} required rows={3} value={urlText} />
            <small>One URL per line · up to 3 public URLs · local, credentialed, and HTTP URLs are refused</small>
          </label>
        )}
        <button className="section-action" disabled={!modeEnabled || busy} type="submit">
          {busy ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : mode === "search" ? <Search aria-hidden="true" size={14} /> : <FileSearch aria-hidden="true" size={14} />}
          {busy ? "WORKING" : mode === "search" ? "SEARCH" : "EXTRACT"}
        </button>
      </form>

      {!settings ? (
        <div className="market-chart-empty" role="status"><strong>Integration settings unavailable</strong><span>Research functions remain off until settings storage is available.</span></div>
      ) : !modeEnabled ? (
        <div className="market-chart-empty" role="status"><strong>{mode === "search" ? "Search" : "Extract"} is off</strong><span>Turn it on in Access &amp; Integrations to use it here.</span></div>
      ) : error ? (
        <div className="market-chart-empty" role="alert"><strong>Request failed</strong><span>{error}</span></div>
      ) : notice ? (
        <div className="research-results" aria-live="polite">
          <p className="section-state">{notice}</p>
          {mode === "search" ? searchResults.map((result) => (
            <article className="research-result" key={result.url}>
              <div className="research-result-heading">
                <h2>{result.title}</h2>
                <a aria-label={`Open source: ${result.title}`} href={result.url} rel="noopener noreferrer" target="_blank"><ExternalLink aria-hidden="true" size={13} /></a>
              </div>
              <p>{result.content}</p>
              <small>{new URL(result.url).hostname}{result.publishedDate ? ` · ${result.publishedDate}` : ""}</small>
            </article>
          )) : (
            <>
              {extractResults.map((result) => (
                <article className="research-result" key={result.url}>
                  <div className="research-result-heading">
                    <h2>{new URL(result.url).hostname}</h2>
                    <a aria-label={`Open source: ${result.url}`} href={result.url} rel="noopener noreferrer" target="_blank"><ExternalLink aria-hidden="true" size={13} /></a>
                  </div>
                  <pre>{result.content}</pre>
                </article>
              ))}
              {failedUrls.map((url) => <p className="login-error" key={url}>Could not extract {url}</p>)}
            </>
          )}
        </div>
      ) : (
        <div className="market-chart-empty" role="status"><strong>Ready</strong><span>No request is sent until you submit a query or URL.</span></div>
      )}

      <p className="research-disclosure">Keyless Tavily Search and Extract are free and rate-limited. Results are external source material, may be incomplete, and are not trading signals; Veylora never forwards them to order or risk systems.</p>
    </div>
  );
}