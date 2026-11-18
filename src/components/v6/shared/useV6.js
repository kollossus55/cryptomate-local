// The only route from V6 pages to the server. Pages never touch base44.entities.V6*
// (gui-design F1, F2): v6Control clamps, shapes and bounds everything in one place.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Expected refusals arrive as HTTP 200 with ok:false, because the server drops custom
// fields on non-2xx (F6). `code` and `fields` are what forms render.
export class V6Refusal extends Error {
  constructor(message, code, fields) {
    super(message);
    this.name = 'V6Refusal';
    this.code = code ?? 'REFUSED';
    this.fields = fields ?? null;
  }
}

export async function callV6(action, params = {}) {
  const { data } = await base44.functions.invoke('v6Control', { action, ...params });
  if (!data?.ok) throw new V6Refusal(data?.error ?? 'Request refused', data?.code, data?.fields);
  return data;
}

// Gui-design 4.3. The engine ticks every 5 minutes, so polling faster shows the same data.
export const V6_POLL_MS = {
  status: 30_000,
  exchanges: 30_000,
  equityCurve: 60_000,
  decisions: 60_000,
  strategies: 60_000,
  signalTests: 60_000,
  events: 60_000,
};

const isPermanent = (err) => err instanceof V6Refusal || [401, 403, 404].includes(err?.status);

/**
 * Query state order for every card: isPending -> skeleton; isError && !data -> error;
 * empty -> empty; otherwise data, with a stale badge when isError && data.
 * <QueryState> in StateCard.jsx implements that order. No initialData, on purpose (F7).
 */
export function useV6Query(action, params, opts = {}) {
  return useQuery({
    queryKey: ['v6', action, params ?? null],
    queryFn: () => callV6(action, params ?? {}),
    placeholderData: (prev) => prev, // keep the last data on screen during a refetch
    refetchInterval: V6_POLL_MS[action] ?? false,
    refetchIntervalInBackground: false,
    retry: (count, err) => !isPermanent(err) && count < 1,
    ...opts,
  });
}

/** Shared by the banner, Mission Control, Risk Controls and the nav dot: one query key. */
export const useV6Status = (opts) => useV6Query('status', undefined, opts);

export function useV6Mutation(action, { invalidates = ['status'], ...opts } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params) => callV6(action, params),
    onSettled: () => invalidates.forEach((a) => qc.invalidateQueries({ queryKey: ['v6', a] })),
    ...opts,
  });
}

/**
 * Turns any V6 failure into something a person can read (gui-design 9.3).
 * kind: refusal | server_down | not_installed | load_failed | signed_out | error
 */
export function describeV6Error(err) {
  if (err instanceof V6Refusal) {
    return { kind: 'refusal', title: 'Request refused', message: err.message };
  }
  const status = err?.status;
  const message = err?.message ?? 'Unknown error';
  if (status === 0) return { kind: 'server_down', title: 'Cannot reach the server', message };
  if (status === 404) {
    return {
      kind: 'not_installed',
      title: 'V6 is not installed yet',
      message: 'The API function was not found.',
    };
  }
  if (status === 401) return { kind: 'signed_out', title: 'Signed out', message };
  if (status === 500 && /failed to load/i.test(message)) {
    return { kind: 'load_failed', title: 'V6 failed to load', message: `${message} See the server log.` };
  }
  return { kind: 'error', title: 'Something went wrong', message };
}

/** Writes land on the next tick, so every write toast says when (gui-design 4.5). */
export const NEXT_TICK_NOTE = 'Applies on the next engine run (within 5 minutes).';
