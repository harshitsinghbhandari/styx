import { useCallback, useEffect, useRef, useState } from 'react';
import { getCommitment, getGraph, transition as apiTransition } from '../api/client';
import { subscribeToEvents } from '../api/sse';
import { EventPipeline, type FlushBatch } from '../events/pipeline';
import type { TickerRow } from '../events/rowProjection';
import type { Commitment, CommitmentEvent } from '../api/types';
import type { GraphEdgeInput } from '../graph/assemble';

const MAX_ROWS = 500;
const PULSE_MS = 900;
// Backfills full history on connect (kernel/src/api/sse.ts defaults `since`
// to "now" otherwise, which would leave the DAG empty until the next live
// transition). Fine at demo data volumes; a real deployment would want a
// bounded lookback instead of the epoch.
const BACKFILL_SINCE = '1970-01-01T00:00:00.000Z';

export function useStyxConsole() {
  const [commitments, setCommitments] = useState<Map<string, Commitment>>(new Map());
  const [edges, setEdges] = useState<GraphEdgeInput[]>([]);
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pulsing, setPulsing] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);

  // Topology (nodes reachable from a root via commitment_dependencies) only
  // needs fetching once per id ever seen; status needs refetching on every
  // transition, so the two are separate calls with separate dedup rules.
  const fetchedRoots = useRef(new Set<string>());
  // Mirrors `commitments` for reads inside async callbacks that must not
  // mutate anything from within a setState updater (see note below).
  const commitmentsRef = useRef<Map<string, Commitment>>(new Map());
  useEffect(() => {
    commitmentsRef.current = commitments;
  }, [commitments]);

  const pulse = useCallback((id: string) => {
    setPulsing((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setPulsing((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, PULSE_MS);
  }, []);

  // GET /v1/commitments/:id/graph returns the id plus everything it
  // transitively depends on or is depended on by (kernel/src/api/graph.ts),
  // i.e. one call already returns the whole connected component a
  // newly-observed commitment belongs to. There is no list-all endpoint, so
  // the "all recent commitments" view is this: call graph once per distinct
  // root witnessed over SSE and merge nodes/edges client-side.
  // Both setState updaters below are written to be pure functions of their
  // `prev` argument only. React 18 StrictMode double-invokes updater
  // functions in dev (to catch exactly this class of bug) and keeps only
  // the second call's result; an earlier version of this hook deduped
  // edges by mutating a ref *inside* the updater and called pulse() inside
  // another updater, so the discarded first invocation silently consumed
  // the dedup key (or double-fired the pulse) and the kept invocation
  // always computed zero additions. Nothing outside `prev` gets touched
  // inside either updater now.
  const mergeGraphFor = useCallback((id: string) => {
    if (fetchedRoots.current.has(id)) return;
    fetchedRoots.current.add(id);
    getGraph(id)
      .then((graph) => {
        setCommitments((prev) => {
          const next = new Map(prev);
          for (const node of graph.nodes) next.set(node.id, node);
          return next;
        });
        setEdges((prev) => {
          const existingKeys = new Set(prev.map((e) => `${e.from}->${e.to}`));
          const additions = graph.edges.filter((e) => !existingKeys.has(`${e.from}->${e.to}`));
          return additions.length ? [...prev, ...additions] : prev;
        });
      })
      .catch(() => {
        fetchedRoots.current.delete(id); // let the next event for this id retry
      });
  }, []);

  const refreshCommitment = useCallback(
    (id: string) => {
      getCommitment(id)
        .then((commitment) => {
          const existing = commitmentsRef.current.get(id);
          if (existing && existing.status !== commitment.status) pulse(id);
          setCommitments((prev) => new Map(prev).set(id, commitment));
        })
        .catch(() => {});
    },
    [pulse],
  );

  const handleFlush = useCallback(
    (batch: FlushBatch) => {
      setRows((prev) => {
        const merged = [...batch.rows].reverse().concat(prev); // newest first
        return merged.length > MAX_ROWS ? merged.slice(0, MAX_ROWS) : merged;
      });

      for (const id of batch.latestByCommitment.keys()) {
        mergeGraphFor(id);
        refreshCommitment(id);
      }
    },
    [mergeGraphFor, refreshCommitment],
  );

  useEffect(() => {
    const pipeline = new EventPipeline(handleFlush);
    pipeline.start();

    const unsubscribe = subscribeToEvents(
      (frame) => {
        if (frame.event === 'connected') {
          setConnected(true);
          return;
        }
        try {
          const event = JSON.parse(frame.data) as CommitmentEvent;
          pipeline.push(event);
        } catch {
          // malformed frame: drop it, don't crash the ticker over one bad line
        }
      },
      { since: BACKFILL_SINCE },
    );

    return () => {
      pipeline.stop();
      unsubscribe();
    };
  }, [handleFlush]);

  const breakCommitment = useCallback(async (id: string, reason: string) => {
    const commitment = commitments.get(id);
    if (!commitment) return;
    const { commitment: updated } = await apiTransition(id, 'break', commitment.version, reason);
    setCommitments((prev) => new Map(prev).set(id, updated));
    pulse(id);
  }, [commitments, pulse]);

  return {
    commitments,
    edges,
    rows,
    selectedId,
    setSelectedId,
    pulsing,
    connected,
    breakCommitment,
  };
}
