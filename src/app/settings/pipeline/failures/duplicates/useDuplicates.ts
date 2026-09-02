"use client";

// The deduplication listing's own data layer. Deliberately NOT the shared
// useFailures() poll: that payload carries every failure family and refetches
// every 5 s, which is exactly wrong for a list of thousands of grouped rows the
// user is reading and selecting in. Here the query (scope, search, sort, page)
// is the state, one request per change, and a reload only when the user acts.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import type {
  DuplicateListResult,
  DuplicateScope,
  DuplicateSort,
} from "@/lib/duplicateTypes";

export type DuplicateQuery = {
  scope: DuplicateScope | "all";
  q: string;
  rawInGallery: boolean;
  sort: DuplicateSort;
  offset: number;
};

export const PAGE_SIZE = 40;

export const EMPTY_QUERY: DuplicateQuery = {
  scope: "all",
  q: "",
  rawInGallery: false,
  sort: "size",
  offset: 0,
};

export function queryParams(query: DuplicateQuery, limit = PAGE_SIZE): string {
  const p = new URLSearchParams({
    scope: query.scope,
    sort: query.sort,
    limit: String(limit),
    offset: String(query.offset),
  });
  if (query.q.trim()) p.set("q", query.q.trim());
  if (query.rawInGallery) p.set("rawInGallery", "true");
  return p.toString();
}

export function useDuplicates(query: DuplicateQuery) {
  const [data, setData] = useState<DuplicateListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A slow request for a filter the user already left must never overwrite the
  // one they are looking at: only the newest reload is allowed to land.
  const latest = useRef(0);

  const params = queryParams(query);
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const d = await fetchJson<DuplicateListResult>(
        `/api/failures/duplicates?${params}`,
      );
      if (ticket !== latest.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (ticket !== latest.current) return;
      setError((e as Error).message);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, load };
}
