// LOCAL CHANGE (strategy lab): side-by-side view of the two daily paper
// strategies run by the strategyLabWorker function. Each has its own virtual
// $10,000 account, separate from the main paper portfolio and its risk
// settings. Read-only apart from "Run now", which triggers one worker tick.
import React, { useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FlaskConical, RefreshCw, Info } from "lucide-react";
import { format } from "date-fns";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

// Categorical slots 1-3 (blue, orange, aqua), dark steps — validated on #0f172a.
const SERIES = [
  { key: "trend_btc_eth", label: "Trend (BTC & ETH)", color: "#3987e5", dash: undefined },
  { key: "composite_daily", label: "SP500 AI composite", color: "#d95926", dash: undefined },
  { key: "btc_hold", label: "BTC buy & hold", color: "#199e70", dash: "6 4" },
];
const RULES = {
  trend_btc_eth: "Holds BTC and ETH (half each) while the daily close is above its 100-day average; cash otherwise. One decision per day, no stop.",
  composite_daily: "20 large coins on daily candles. Buys when all 6 SP500 AI sub-indicators are bullish, sells when fewer than 3 are. Stop at 2× ATR (3% floor), 1% risk per trade, max 10% per position, max 5 positions, no fixed take-profit.",
};
const START = 10000;
const money = (v) => (v == null ? "—" : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const pnlCls = (v) => (v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-slate-300");

function StatCard({ label, color, dash, equity, maxDD, extra }) {
  const ret = equity != null ? (equity / START - 1) * 100 : null;
  return (
    <Card className="bg-slate-900/60 border-slate-800">
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <svg width="18" height="6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dash} /></svg>
          {label}
        </div>
        <div className="text-2xl font-semibold text-slate-100">{money(equity)}</div>
        <div className={`text-sm ${pnlCls(ret)}`}>{pct(ret)} since start</div>
        {maxDD != null && <div className="text-xs text-slate-400">Worst fall {maxDD.toFixed(1)}%</div>}
        {extra && <div className="text-xs text-slate-400">{extra}</div>}
      </CardContent>
    </Card>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-slate-400">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-slate-200">
          <svg width="14" height="6" aria-hidden="true"><line x1="0" y1="3" x2="14" y2="3" stroke={p.color} strokeWidth="2" strokeDasharray={p.strokeDasharray} /></svg>
          <span className="text-slate-400">{p.name}</span>
          <span className="ml-auto font-medium">{money(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function StrategyLab() {
  const qc = useQueryClient();
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["strategy-lab-accounts"],
    queryFn: () => base44.entities.StrategyLabAccount.list(),
    refetchInterval: 5 * 60 * 1000,
  });
  const { data: trades = [] } = useQuery({
    queryKey: ["strategy-lab-trades"],
    queryFn: () => base44.entities.StrategyLabTrade.list("-executed_at", 500),
    refetchInterval: 5 * 60 * 1000,
  });
  const runNow = useMutation({
    mutationFn: () => base44.functions.invoke("strategyLabWorker", {}),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["strategy-lab-accounts"] });
      qc.invalidateQueries({ queryKey: ["strategy-lab-trades"] });
    },
  });

  const byId = Object.fromEntries(accounts.map((a) => [a.strategy_id, a]));
  const ref = byId.trend_btc_eth || accounts[0];
  const btcStart = ref?.benchmark_btc_start;
  const btcHoldNow = btcStart && ref?.last_btc_price ? (START * ref.last_btc_price) / btcStart : null;

  // One row per daily decision; BTC hold is indexed to the same $10,000 start.
  const chartData = useMemo(() => {
    const rows = new Map();
    for (const a of accounts) {
      for (const h of a.equity_history || []) {
        const d = h.date.slice(0, 10);
        const row = rows.get(d) || { date: d };
        row[a.strategy_id] = h.equity;
        if (btcStart && h.btc && row.btc_hold == null) row.btc_hold = Math.round((START * h.btc) / btcStart);
        rows.set(d, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [accounts, btcStart]);

  const started = ref?.started_at ? format(new Date(ref.started_at), "d MMM yyyy") : null;
  const lastMark = ref?.last_marked_at ? format(new Date(ref.last_marked_at), "d MMM HH:mm") : null;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-100"><FlaskConical className="h-6 w-6" /> Strategy Lab</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Two daily strategies paper-trading side by side, each with its own virtual $10,000. Separate from your main
            portfolio and its risk settings, and never places real orders.
            {started && <> Running since {started}.</>} {lastMark && <> Last update {lastMark}.</>}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => runNow.mutate()} disabled={runNow.isPending} className="border-slate-700">
          <RefreshCw className={`mr-2 h-4 w-4 ${runNow.isPending ? "animate-spin" : ""}`} /> Run now
        </Button>
      </div>

      {isLoading ? (
        <p className="text-slate-400">Loading…</p>
      ) : !accounts.length ? (
        <Card className="bg-slate-900/60 border-slate-800"><CardContent className="p-6 text-slate-300">
          No lab accounts yet. They are created on the first run (hourly), or press <b>Run now</b>.
        </CardContent></Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {SERIES.slice(0, 2).map((s) => {
              const a = byId[s.key];
              return <StatCard key={s.key} label={s.label} color={s.color} dash={s.dash} equity={a?.last_equity} maxDD={a?.max_drawdown_percent}
                extra={a ? `${Object.keys(a.positions || {}).length} open · ${a.trade_count} positions opened · fees ${money(a.total_fees)}` : null} />;
            })}
            <StatCard label="BTC buy & hold (benchmark)" color={SERIES[2].color} dash={SERIES[2].dash} equity={btcHoldNow}
              extra={btcStart ? `From $${btcStart.toLocaleString()} at the lab's start, no fees` : null} />
          </div>

          <Card className="bg-slate-900/60 border-slate-800">
            <CardHeader className="pb-2"><CardTitle className="text-base text-slate-200">Account value after each daily decision</CardTitle></CardHeader>
            <CardContent>
              {chartData.length < 2 ? (
                <p className="py-8 text-center text-sm text-slate-400">
                  The chart fills in one point per day after each daily close (16:00 UTC). {chartData.length ? "One point so far." : ""}
                </p>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                      <CartesianGrid stroke="#334155" strokeOpacity={0.35} vertical={false} />
                      <XAxis dataKey="date" stroke="#475569" tick={{ fill: "#94a3b8", fontSize: 11 }} tickLine={false} minTickGap={24} />
                      <YAxis stroke="#475569" tick={{ fill: "#94a3b8", fontSize: 11 }} tickLine={false} axisLine={false} width={64}
                        tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} domain={["auto", "auto"]} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#64748b", strokeWidth: 1 }} />
                      <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />
                      {SERIES.map((s) => (
                        <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
                          strokeDasharray={s.dash} dot={false} activeDot={{ r: 4, stroke: "#0f172a", strokeWidth: 2 }} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {SERIES.slice(0, 2).map((s) => {
              const a = byId[s.key];
              const positions = Object.values(a?.positions || {});
              return (
                <Card key={s.key} className="bg-slate-900/60 border-slate-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-slate-200">{s.label}: open positions</CardTitle>
                    <p className="flex gap-2 text-xs text-slate-400"><Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{RULES[s.key]}</p>
                  </CardHeader>
                  <CardContent>
                    {!positions.length ? <p className="text-sm text-slate-400">In cash — no signal right now.</p> : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead><tr className="text-left text-xs text-slate-400">
                            <th className="py-1 pr-3 font-normal">Coin</th><th className="pr-3 font-normal text-right">Value</th>
                            <th className="pr-3 font-normal text-right">Entry</th><th className="pr-3 font-normal text-right">Now</th>
                            <th className="pr-3 font-normal text-right">P&L</th>{s.key === "composite_daily" && <th className="font-normal text-right">Stop</th>}
                          </tr></thead>
                          <tbody>
                            {positions.map((p) => {
                              const now = p.last_price ?? p.entry_price;
                              const pl = (now / p.entry_price - 1) * 100;
                              return (
                                <tr key={p.symbol} className="border-t border-slate-800 text-slate-200">
                                  <td className="py-1.5 pr-3">{p.symbol.replace("USDT", "")}</td>
                                  <td className="pr-3 text-right">{money(p.quantity * now)}</td>
                                  <td className="pr-3 text-right">{p.entry_price.toPrecision(5)}</td>
                                  <td className="pr-3 text-right">{now.toPrecision(5)}</td>
                                  <td className={`pr-3 text-right ${pnlCls(pl)}`}>{pct(pl)}</td>
                                  {s.key === "composite_daily" && <td className="text-right text-slate-400">{p.stop_price ? p.stop_price.toPrecision(5) : "—"}</td>}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card className="bg-slate-900/60 border-slate-800">
            <CardHeader className="pb-2"><CardTitle className="text-base text-slate-200">Trade log</CardTitle></CardHeader>
            <CardContent>
              {!trades.length ? <p className="text-sm text-slate-400">No trades yet.</p> : (
                <div className="max-h-96 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-900"><tr className="text-left text-xs text-slate-400">
                      <th className="py-1 pr-3 font-normal">When</th><th className="pr-3 font-normal">Strategy</th><th className="pr-3 font-normal">Action</th>
                      <th className="pr-3 font-normal text-right">Amount</th><th className="pr-3 font-normal text-right">P&L</th><th className="font-normal">Why</th>
                    </tr></thead>
                    <tbody>
                      {trades.map((t) => (
                        <tr key={t.id} className="border-t border-slate-800 align-top text-slate-200">
                          <td className="whitespace-nowrap py-1.5 pr-3 text-slate-400">{format(new Date(t.executed_at), "d MMM HH:mm")}</td>
                          <td className="whitespace-nowrap pr-3">{SERIES.find((s) => s.key === t.strategy_id)?.label ?? t.strategy_id}</td>
                          <td className="whitespace-nowrap pr-3">
                            <Badge variant="outline" className={t.side === "buy" ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300"}>
                              {t.side === "buy" ? "Buy" : "Sell"} {t.symbol.replace("USDT", "")}
                            </Badge>
                          </td>
                          <td className="pr-3 text-right">{money(t.quote_amount)}</td>
                          <td className={`pr-3 text-right ${pnlCls(t.pnl)}`}>{t.pnl == null ? "" : `${money(t.pnl)} (${pct(t.pnl_percent)})`}</td>
                          <td className="text-xs text-slate-400">{t.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
