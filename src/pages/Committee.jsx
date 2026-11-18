// LOCAL CHANGE (agent committee, phase 3): the Committee page.
// Shows what the shadow committee would have done with the legacy engine's
// picks, how those picks actually turned out, how each agent's votes line up
// with outcomes, and the committee's own settings. Shadow only: nothing on
// this page can make the committee place or block a real trade.
import React, { useEffect, useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Users, ShieldCheck, ShieldX, RefreshCw, ChevronDown, ChevronRight, Info, Save } from "lucide-react";
import { format } from "date-fns";
import { summarizeFilter, agentScorecard, engineComparison, dedupeDecisions, MIN_FILTER_SAMPLE } from "@/lib/committeeStats";

const AGENT_LABELS = {
  trend: "Trend",
  momentum: "Momentum",
  volumeFlow: "Volume / Flow",
  structure: "Structure",
  marketRegime: "Market Regime",
  derivatives: "Derivatives",
  liquidity: "Liquidity",
};
const AGENT_ORDER = Object.keys(AGENT_LABELS);

// Mirrors DEFAULT_COMMITTEE_SETTINGS in shared/trading/committee.js.
const DEFAULTS = {
  mode: "shadow",
  role: "filter",
  block_against: 2,
  min_long_votes: 4,
  max_against: 1,
  min_score: 0.6,
  btc_drop_veto_pct: 3,
  breadth_veto: 0,
  funding_veto: 0.0005,
  funding_warn: 0.0003,
  max_spread_pct: 0.3,
  agents_enabled: {},
};

const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
const signed = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const when = (iso) => { try { return format(new Date(iso), "dd MMM HH:mm"); } catch { return "—"; } };

const VOTE_STYLE = {
  long: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  against: "bg-red-500/20 text-red-300 border-red-500/30",
  abstain: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  veto: "bg-red-600/40 text-red-100 border-red-500/60",
  nodata: "bg-slate-800 text-slate-600 border-slate-700",
};

function voteKind(v) {
  if (v.data_ok === false) return "nodata";
  if (v.veto) return "veto";
  return v.vote;
}

const VERDICT_STYLE = {
  collecting: { cls: "bg-slate-500/20 text-slate-300 border-slate-500/30", label: "Collecting data" },
  helping: { cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30", label: "Filter is helping" },
  hurting: { cls: "bg-red-500/20 text-red-300 border-red-500/30", label: "Filter is hurting" },
  inconclusive: { cls: "bg-amber-500/20 text-amber-300 border-amber-500/30", label: "Inconclusive" },
};

function Stat({ label, value, hint }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function OutcomeBlock({ title, icon: Icon, tone, s }) {
  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex items-center gap-2 mb-3 font-medium"><Icon className="w-4 h-4" />{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Picks" value={s.total} hint={`${s.resolved} resolved, ${s.pending} pending`} />
        <Stat label="Hit TP first" value={pct(s.winRate)} />
        <Stat label="Hit stop first" value={pct(s.stopRate)} />
        <Stat label="Avg 24h return" value={signed(s.avgRet24h)} />
      </div>
    </div>
  );
}

function SummaryCell({ s }) {
  if (!s.total) return <span className="text-slate-600">—</span>;
  return (
    <span className="tabular-nums">
      {s.total}
      <span className="text-slate-500"> · </span>
      {s.resolved ? <span>{pct(s.winRate, 0)} TP</span> : <span className="text-slate-500">pending</span>}
    </span>
  );
}

function DecisionRow({ r }) {
  const [open, setOpen] = useState(false);
  const votes = [...(r.votes || [])].sort((a, b) => AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent));
  const o = r.outcome;
  return (
    <>
      <tr className="border-t border-slate-800 hover:bg-slate-800/40 cursor-pointer" onClick={() => setOpen(!open)}>
        <td className="py-2 pr-2 text-slate-500">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
        <td className="py-2 pr-3 whitespace-nowrap text-slate-400">{when(r.evaluated_at)}</td>
        <td className="py-2 pr-3 font-medium">{(r.symbol || "").replace(/USDT$/, "")}</td>
        <td className="py-2 pr-3">
          {r.legacy_decision === "enter"
            ? <Badge className="bg-indigo-500/20 text-indigo-300 border-indigo-500/30">pick{r.legacy_traded ? " · bought" : ""}</Badge>
            : <span className="text-slate-500">skip</span>}
        </td>
        <td className="py-2 pr-3">
          {r.filter_verdict === "block" && <Badge className="bg-red-500/20 text-red-300 border-red-500/30">would block</Badge>}
          {r.filter_verdict === "allow" && <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30">allow</Badge>}
          {!r.filter_verdict && <span className="text-slate-600">—</span>}
        </td>
        <td className="py-2 pr-3">
          <div className="flex flex-wrap gap-1">
            {votes.map((v) => (
              <span key={v.agent} title={`${AGENT_LABELS[v.agent] || v.agent}: ${voteKind(v)}`}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${VOTE_STYLE[voteKind(v)] || VOTE_STYLE.abstain}`}>
                {(AGENT_LABELS[v.agent] || v.agent).slice(0, 4)}
              </span>
            ))}
          </div>
        </td>
        <td className="py-2 pr-3 whitespace-nowrap">
          {o ? (
            <span className={o.first_hit === "tp" ? "text-emerald-400" : o.first_hit === "sl" ? "text-red-400" : "text-slate-400"}>
              {o.first_hit === "tp" ? "TP" : o.first_hit === "sl" ? "Stop" : "Neither"} · {signed(o.ret_24h, 1)}
            </span>
          ) : <span className="text-slate-600">pending</span>}
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-900/60">
          <td />
          <td colSpan={6} className="py-3 pr-3">
            <div className="text-sm text-slate-300 mb-2">
              Committee alone: <span className="font-medium">{r.decision}</span> — {r.decision_reason}
              {r.filter_reason && <> · Filter: {r.filter_reason}</>}
              {Number.isFinite(r.legacy_strength) && <> · Legacy strength {r.legacy_strength}</>}
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              {votes.map((v) => (
                <div key={v.agent} className="text-xs rounded border border-slate-800 p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-slate-200">{AGENT_LABELS[v.agent] || v.agent}</span>
                    <span className={`px-1.5 rounded border ${VOTE_STYLE[voteKind(v)] || VOTE_STYLE.abstain}`}>{voteKind(v)}</span>
                    {Number.isFinite(v.score) && <span className="text-slate-500">score {v.score}</span>}
                    {v.eligible === false && <span className="text-slate-500">(not eligible)</span>}
                  </div>
                  <ul className="text-slate-400 list-disc ml-4">
                    {(v.reasons || []).map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              ))}
            </div>
            {o && (
              <div className="text-xs text-slate-500 mt-2">
                Entry {o.entry_price} at {when(o.entry_time)} · max up {signed(o.max_up, 1)} · max down {signed(o.max_down, 1)} over {o.horizon_hours}h ·
                TP {o.take_profit_percent}% / SL {o.stop_loss_percent}%
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function NumField({ label, hint, value, onChange, step = "any", min, max, scale = 1 }) {
  return (
    <div>
      <Label className="text-slate-300">{label}</Label>
      <Input type="number" step={step} min={min} max={max}
        value={Number.isFinite(value) ? +(value * scale).toFixed(6) : ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value) / scale)}
        className="bg-slate-900 border-slate-700 mt-1" />
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

function SettingsPanel({ saved }) {
  const queryClient = useQueryClient();
  const [s, setS] = useState({ ...DEFAULTS });
  useEffect(() => {
    if (saved) setS({ ...DEFAULTS, ...(saved.committee || {}), agents_enabled: { ...(saved.committee?.agents_enabled || {}) } });
  }, [saved]);
  const set = (k) => (v) => setS((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    // Only the `committee` field is written, never the account's risk settings.
    mutationFn: () => base44.entities.AutoTradingSettings.update(saved.id, { committee: { ...(saved.committee || {}), ...s } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auto-trading-settings"] }),
  });

  if (!saved) return <p className="text-slate-500">Save your Auto-Trading settings once before configuring the committee.</p>;

  return (
    <div className="space-y-6">
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <Label className="text-slate-300">Mode</Label>
          <div className="flex gap-2 mt-1">
            {["off", "shadow"].map((m) => (
              <Button key={m} size="sm" variant={s.mode === m ? "default" : "outline"} onClick={() => set("mode")(m)}
                className={s.mode === m ? "" : "border-slate-700 text-slate-300"}>{m}</Button>
            ))}
            <Button size="sm" variant="outline" disabled className="border-slate-800 text-slate-600" title="Needs a go/no-go decision from shadow results">live (locked)</Button>
          </div>
          <p className="text-xs text-slate-500 mt-1">Shadow logs decisions only. Live is locked until the shadow results justify it.</p>
        </div>
        <div>
          <Label className="text-slate-300">Role</Label>
          <div className="flex gap-2 mt-1">
            {[["filter", "Filter legacy picks"], ["replace", "Pick entries itself"]].map(([r, t]) => (
              <Button key={r} size="sm" variant={s.role === r ? "default" : "outline"} onClick={() => set("role")(r)}
                className={s.role === r ? "" : "border-slate-700 text-slate-300"}>{t}</Button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1">Filter: the legacy engine picks, the committee may only object. Every record keeps both views either way.</p>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <NumField label="Block at N against votes" step="1" min={1} max={7} value={s.block_against} onChange={set("block_against")}
          hint="Filter role. Any veto also blocks." />
        <NumField label="BTC drop veto (% in 4h)" step="0.5" min={0} value={s.btc_drop_veto_pct} onChange={set("btc_drop_veto_pct")} />
        <NumField label="Breadth veto (% of coins above EMA50)" step="5" min={0} max={100} scale={100} value={s.breadth_veto} onChange={set("breadth_veto")}
          hint="0 = off (default). Backtests showed this blocked the best trades." />
        <NumField label="Funding veto (% per 8h)" step="0.005" min={0} scale={100} value={s.funding_veto} onChange={set("funding_veto")}
          hint="Default 0.05% — longs crowded." />
        <NumField label="Funding warning (% per 8h)" step="0.005" min={0} scale={100} value={s.funding_warn} onChange={set("funding_warn")} />
        <NumField label="Max spread (%)" step="0.05" min={0} value={s.max_spread_pct} onChange={set("max_spread_pct")} />
      </div>

      {s.role === "replace" && (
        <div className="grid sm:grid-cols-3 gap-4">
          <NumField label="Long votes needed" step="1" min={1} max={7} value={s.min_long_votes} onChange={set("min_long_votes")} />
          <NumField label="Max against votes" step="1" min={0} max={7} value={s.max_against} onChange={set("max_against")} />
          <NumField label="Min committee score (0–1)" step="0.05" min={0} max={1} value={s.min_score} onChange={set("min_score")} />
        </div>
      )}

      <div>
        <Label className="text-slate-300">Agents</Label>
        <div className="grid sm:grid-cols-4 gap-3 mt-2">
          {AGENT_ORDER.map((a) => (
            <label key={a} className="flex items-center justify-between gap-2 rounded border border-slate-800 px-3 py-2 text-sm">
              {AGENT_LABELS[a]}
              <Switch checked={s.agents_enabled[a] !== false}
                onCheckedChange={(on) => setS((p) => ({ ...p, agents_enabled: { ...p.agents_enabled, [a]: on } }))} />
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="w-4 h-4 mr-2" />{save.isPending ? "Saving…" : "Save committee settings"}
        </Button>
        <Button variant="ghost" className="text-slate-400" onClick={() => setS({ ...DEFAULTS, agents_enabled: {} })}>Reset to defaults</Button>
        {save.isSuccess && <span className="text-sm text-emerald-400">Saved — applies from the next trading cycle.</span>}
        {save.isError && <span className="text-sm text-red-400">Save failed: {save.error?.message}</span>}
      </div>
    </div>
  );
}

export default function Committee() {
  const [view, setView] = useState("picks");
  const [limit, setLimit] = useState(50);

  const { data: records = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["committee-decisions"],
    queryFn: () => base44.entities.CommitteeDecision.list("-evaluated_at", 20000),
    refetchInterval: 5 * 60 * 1000,
  });
  const { data: settings } = useQuery({
    queryKey: ["auto-trading-settings"],
    queryFn: async () => (await base44.entities.AutoTradingSettings.list())[0],
  });

  const deduped = useMemo(() => dedupeDecisions(records), [records]);
  const filter = useMemo(() => summarizeFilter(records), [records]);
  const agents = useMemo(() => agentScorecard(records).sort((a, b) => AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent)), [records]);
  const engines = useMemo(() => engineComparison(records), [records]);

  const shown = useMemo(() => {
    const rows = [...deduped].reverse(); // newest first
    if (view === "picks") return rows.filter((r) => r.legacy_decision === "enter");
    if (view === "blocked") return rows.filter((r) => r.filter_verdict === "block");
    if (view === "committee") return rows.filter((r) => r.decision === "enter");
    return rows;
  }, [deduped, view]);

  const cfg = { ...DEFAULTS, ...(settings?.committee || {}) };
  const latest = deduped.length ? deduped[deduped.length - 1].evaluated_at : null;
  const v = VERDICT_STYLE[filter.verdict];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent flex items-center gap-3">
              <Users className="w-8 h-8 text-indigo-400" /> Agent Committee
            </h1>
            <p className="text-slate-400">What the committee would have done with each pick, and how those picks turned out.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30">{cfg.mode === "off" ? "off" : "shadow — never trades"}</Badge>
            <Badge className="bg-indigo-500/20 text-indigo-300 border-indigo-500/30">role: {cfg.role}</Badge>
            <Button variant="outline" size="sm" className="border-slate-700 text-slate-300" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />Refresh
            </Button>
          </div>
        </div>

        {!isLoading && records.length === 0 && (
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="py-6 flex gap-3 text-slate-300">
              <Info className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
              <div>
                No committee decisions yet. The committee runs inside the auto-trading cycle whenever it looks for new entries, so
                it needs auto-trading enabled and not paused (daily loss limit, portfolio take-profit, circuit breaker or trading schedule).
                Each coin is logged at most once per candle.
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="bg-slate-900/60 border-slate-800 text-white">
          <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
            <CardTitle>Filter results — legacy picks the committee would allow vs block</CardTitle>
            <Badge className={v.cls}>{v.label}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-400">{filter.detail} Outcomes resolve about {cfg && settings?.candle_interval === "4h" ? "4 days" : "a day"} after each pick.</p>
            <div className="grid lg:grid-cols-2 gap-4">
              <OutcomeBlock title="Would allow" icon={ShieldCheck} tone="border-emerald-500/20 bg-emerald-500/5" s={filter.allowed} />
              <OutcomeBlock title="Would block" icon={ShieldX} tone="border-red-500/20 bg-red-500/5" s={filter.blocked} />
            </div>
            <div className="h-2 rounded bg-slate-800 overflow-hidden" title={`Blocked sample: ${filter.blocked.resolved}/${MIN_FILTER_SAMPLE}`}>
              <div className="h-full bg-indigo-500" style={{ width: `${Math.min(100, (Math.min(filter.allowed.resolved, filter.blocked.resolved) / MIN_FILTER_SAMPLE) * 100)}%` }} />
            </div>
            <p className="text-xs text-slate-500">
              Progress to a meaningful verdict ({MIN_FILTER_SAMPLE} resolved on each side). Win = take-profit reached before the stop,
              at your TP/SL, from the next candle's open. Gross of fees.
            </p>
            {filter.blockReasons.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-slate-500 text-left"><tr><th className="py-1">Blocked because</th><th>Picks</th><th>Hit TP first</th><th>Hit stop first</th><th>Avg 24h</th></tr></thead>
                <tbody>
                  {filter.blockReasons.map((b) => (
                    <tr key={b.label} className="border-t border-slate-800">
                      <td className="py-1.5">{b.label.replace(/\b(\w+)$/, (m) => AGENT_LABELS[m] || m)}</td>
                      <td className="tabular-nums">{b.total}</td><td>{pct(b.winRate)}</td><td>{pct(b.stopRate)}</td><td>{signed(b.avgRet24h)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="bg-slate-900/60 border-slate-800 text-white lg:col-span-2">
            <CardHeader><CardTitle>Agent scorecard — on legacy picks</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-500 text-left">
                  <tr><th className="py-1">Agent</th><th>Voted long</th><th>Abstained</th><th>Voted against</th><th>Vetoed</th><th>No data</th></tr>
                </thead>
                <tbody>
                  {agents.length === 0 && <tr><td colSpan={6} className="py-3 text-slate-500">No legacy picks logged yet.</td></tr>}
                  {agents.map((a) => (
                    <tr key={a.agent} className="border-t border-slate-800">
                      <td className="py-1.5 font-medium">{AGENT_LABELS[a.agent] || a.agent}</td>
                      <td><SummaryCell s={a.long} /></td><td><SummaryCell s={a.abstain} /></td>
                      <td><SummaryCell s={a.against} /></td><td><SummaryCell s={a.veto} /></td>
                      <td className="tabular-nums text-slate-500">{a.noData || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-slate-500 mt-3">
                Each cell: picks · share that hit take-profit first. A useful agent shows a lower TP rate when it objects than when it agrees.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-900/60 border-slate-800 text-white">
            <CardHeader><CardTitle>Legacy vs committee picking alone</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              {[["Legacy picks", engines.legacy], ["Committee would enter", engines.committee]].map(([t, s]) => (
                <div key={t}>
                  <div className="text-slate-400 mb-1">{t}</div>
                  <div className="flex gap-6">
                    <Stat label="Picks" value={s.total} hint={`${s.resolved} resolved`} />
                    <Stat label="Hit TP first" value={pct(s.winRate)} />
                    <Stat label="Avg 24h" value={signed(s.avgRet24h)} />
                  </div>
                </div>
              ))}
              <p className="text-xs text-slate-500">Backtests had the committee picking worse than legacy; this tracks it live.</p>
              <p className="text-xs text-slate-500">{deduped.length} decisions logged{latest ? `, latest ${when(latest)}` : ""}. Kept 30 days.</p>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-slate-900/60 border-slate-800 text-white">
          <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
            <CardTitle>Decisions</CardTitle>
            <div className="flex gap-2 flex-wrap">
              {[["picks", "Legacy picks"], ["blocked", "Would block"], ["committee", "Committee would enter"], ["all", "All"]].map(([k, t]) => (
                <Button key={k} size="sm" variant={view === k ? "default" : "outline"} onClick={() => { setView(k); setLimit(50); }}
                  className={view === k ? "" : "border-slate-700 text-slate-300"}>{t}</Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-500 text-left">
                <tr><th /><th className="py-1">Time</th><th>Coin</th><th>Legacy</th><th>Filter</th><th>Votes</th><th>Outcome</th></tr>
              </thead>
              <tbody>
                {isLoading && <tr><td colSpan={7} className="py-4 text-slate-500">Loading…</td></tr>}
                {!isLoading && shown.length === 0 && <tr><td colSpan={7} className="py-4 text-slate-500">Nothing here yet.</td></tr>}
                {shown.slice(0, limit).map((r) => <DecisionRow key={r.id} r={r} />)}
              </tbody>
            </table>
            {shown.length > limit && (
              <Button variant="ghost" className="mt-3 text-slate-400" onClick={() => setLimit(limit + 100)}>Show more ({shown.length - limit} left)</Button>
            )}
            <div className="flex flex-wrap gap-2 mt-4 text-[11px] text-slate-500">
              {Object.entries(VOTE_STYLE).map(([k, c]) => <span key={k} className={`px-1.5 py-0.5 rounded border ${c}`}>{k === "nodata" ? "no data" : k}</span>)}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/60 border-slate-800 text-white">
          <CardHeader><CardTitle>Committee settings</CardTitle></CardHeader>
          <CardContent><SettingsPanel saved={settings} /></CardContent>
        </Card>
      </div>
    </div>
  );
}
