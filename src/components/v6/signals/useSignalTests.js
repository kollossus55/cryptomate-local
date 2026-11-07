import { useInfiniteQuery } from "@tanstack/react-query";
import { V6Refusal, V6_POLL_MS, callV6 } from "../shared";

const PAGE_SIZE = 50;
const isPermanent = (err) => err instanceof V6Refusal || [401, 403, 404].includes(err?.status);

// useV6Query has no cursor support, so "Load more" goes through callV6 directly,
// keeping the same query-key prefix, polling and retry rules.
export function useSignalTests(request) {
  return useInfiniteQuery({
    queryKey: ["v6", "signalTests", request],
    queryFn: ({ pageParam }) => callV6("signalTests", {
      ...request,
      limit: PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
    refetchInterval: V6_POLL_MS.signalTests,
    refetchIntervalInBackground: false,
    retry: (count, err) => !isPermanent(err) && count < 1,
  });
}
