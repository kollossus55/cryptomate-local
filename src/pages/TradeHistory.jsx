import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, TrendingUp, TrendingDown, Search, Filter, RefreshCw, CheckCircle2, XCircle, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "../components/utils";
import { format } from "date-fns";
import { V6_EXCHANGE, V6_RESET_REFUSED, isV6Trade, v6RecordExists } from "@/lib/v6Trades";

const ENGINES = [
  { id: "v6", label: "V6" },
  { id: "legacy", label: "Legacy" },
  { id: "all", label: "All engines" },
];

const signedMoney = (value) => `${value > 0 ? '+' : value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;

// V6 fills carry their own fill time. created_date is when the row was stored.
const tradeTime = (trade) => {
  const date = new Date(trade.timestamp || trade.created_date);
  return Number.isNaN(date.getTime()) ? 'Time not recorded' : format(date, 'MMM dd, yyyy • HH:mm:ss');
};

function V6TradeDetail({ trade }) {
  const facts = [
    ['Strategy', trade.strategy_id],
    ['Reason code', trade.reason_code],
    ['Fee', Number.isFinite(trade.fee) ? `$${trade.fee.toFixed(2)}` : null],
    ['Slippage', Number.isFinite(trade.slippage_percent) ? `${trade.slippage_percent.toFixed(3)}%` : null],
    ['Fill method', trade.fill_method],
    ['P&L before costs', Number.isFinite(trade.gross_profit_loss) ? signedMoney(trade.gross_profit_loss) : null],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');

  return (
    <div className="border-t border-slate-700 pt-4">
      <h4 className="text-slate-200 font-semibold mb-2">Why this trade</h4>
      <p className="text-sm text-slate-300 mb-3">
        {trade.exit_reason || trade.ai_signal?.reasoning || 'No reason was recorded.'}
      </p>
      <dl className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-slate-400 text-xs">{label}</dt>
            <dd className="text-sm text-white break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-slate-500 mt-3">Simulated paper fill. No order was sent to an exchange.</p>
    </div>
  );
}

export default function TradeHistory() {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [engine, setEngine] = useState("v6");

  const queryClient = useQueryClient();

  const { data: trades = [], isLoading, isError, error: tradesError } = useQuery({
    queryKey: ['trades'],
    queryFn: () => base44.entities.Trade.list('-created_date', 1000),
  });

  const { data: v6Record } = useQuery({
    queryKey: ['v6-record'],
    queryFn: v6RecordExists,
  });

  const { data: portfolio } = useQuery({
    queryKey: ['portfolio'],
    queryFn: async () => {
      const result = await base44.entities.Portfolio.list();
      return result[0] || null;
    },
  });

  const resetPortfolioMutation = useMutation({
    mutationFn: async () => {
      // Checked again here: the button may be stale, and this cannot be undone.
      if (await v6RecordExists()) throw new Error(V6_RESET_REFUSED);

      if (portfolio?.id) {
        // Scoped on the server, so this holds for rows beyond any list() page too.
        await base44.entities.Trade.deleteMany({ exchange: { $ne: V6_EXCHANGE } });

        // Then, update the portfolio to its initial state
        return await base44.entities.Portfolio.update(portfolio.id, {
          total_balance: 10000,
          available_balance: 10000,
          positions: [],
          total_profit_loss: 0,
          total_trades: 0
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['trades'] });
      queryClient.invalidateQueries({ queryKey: ['v6-record'] });
    },
    onError: (error) => {
      console.error('Reset failed:', error);
      alert('Reset failed: ' + (error?.message || 'Unknown error'));
    },
  });

  const handleResetPortfolio = async () => {
    if (window.confirm('Reset the legacy paper portfolio? This clears the legacy trade history and sets the balance back to $10,000.')) {
      await resetPortfolioMutation.mutateAsync();
    }
  };

  // Totals follow the engine filter: mixing engines would blend two unrelated records.
  const engineTrades = trades.filter(trade =>
    engine === "all" || (engine === "v6") === isV6Trade(trade)
  );

  const filteredTrades = engineTrades.filter(trade => {
    const matchesSearch = (trade.asset_symbol ?? '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterType === "all" || trade.trade_type === filterType;
    return matchesSearch && matchesFilter;
  });

  const totalValue = engineTrades.reduce((sum, trade) => sum + (trade.total_value || 0), 0);
  const completedBuyTrades = engineTrades.filter(t => t.status === 'completed' && t.trade_type === 'buy').length;
  const completedSellTrades = engineTrades.filter(t => t.status === 'completed' && t.trade_type === 'sell').length;

  
  // Calculate separate stats for realized vs all trades
  const sellTrades = engineTrades.filter(t => t.trade_type === 'sell' && t.status === 'completed');
  const realizedPnL = sellTrades.reduce((sum, trade) => sum + ((trade.profit_loss || 0)), 0);
  const hasSellTrades = sellTrades.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="max-w-7xl mx-auto px-6 py-8">
        
        {/* Header */}
        <div className="mb-8">
          <Link to={createPageUrl('MissionControl')}>
            <Button variant="ghost" className="mb-4 text-slate-400 hover:text-white">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Mission Control
            </Button>
          </Link>
          
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                Trade History
              </h1>
              <div className="flex flex-col gap-1">
                <p className="text-slate-400">View and analyze your trading activity</p>
                {portfolio?.positions?.length > 0 && (
                  <p className="text-sm font-medium text-slate-300">
                    Open positions: {portfolio.positions.length}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {engine === "v6" && (
                <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
                  PAPER TRADING
                </Badge>
              )}
              {v6Record === false ? (
                <Button
                  onClick={handleResetPortfolio}
                  variant="outline"
                  className="border-red-500/50 text-red-400 hover:bg-red-500/10 hover:border-red-500"
                  disabled={resetPortfolioMutation.isPending}
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {resetPortfolioMutation.isPending ? 'Resetting...' : 'Reset Legacy Portfolio & History'}
                </Button>
              ) : v6Record === true ? (
                <p className="text-xs text-slate-400 max-w-xs">{V6_RESET_REFUSED}</p>
              ) : null}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6">
              <p className="text-slate-400 text-sm mb-2 flex items-center gap-1">
                Total Trading Volume
                <span className="text-xs text-slate-500">(All Trades)</span>
              </p>
              <p className="text-3xl font-bold text-white">${totalValue.toLocaleString()}</p>
              <p className="text-xs text-slate-500 mt-1">
                Sum of all buy + sell values
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6">
              <p className="text-slate-400 text-sm mb-2">Completed Buys</p>
              <p className="text-3xl font-bold text-green-400">{completedBuyTrades}</p>
              <p className="text-xs text-slate-500 mt-1">
                Buy orders filled
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6">
              <p className="text-slate-400 text-sm mb-2">Completed Sells</p>
              <p className="text-3xl font-bold text-red-400">{completedSellTrades}</p>
              <p className="text-xs text-slate-500 mt-1">
                Sell orders filled
              </p>
            </CardContent>
          </Card>

          <Card className={`${realizedPnL >= 0 ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-slate-400 text-sm">Realized P&L</p>
                {!hasSellTrades && (
                  <Badge className="bg-slate-700 text-slate-300 text-xs">
                    No Sells Yet
                  </Badge>
                )}
              </div>
              <p className={`text-3xl font-bold ${realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {realizedPnL >= 0 ? '+' : ''}${realizedPnL.toLocaleString()}
              </p>
              {!hasSellTrades && (
                <p className="text-xs text-slate-400 mt-2">
                  💡 Complete a sell trade to see P&L
                </p>
              )}
              {hasSellTrades && (
                <p className="text-xs text-slate-400 mt-2">
                  From {sellTrades.length} sell trade{sellTrades.length !== 1 ? 's' : ''}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search by asset..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-slate-800 border-slate-700 text-white"
            />
          </div>
          
          <div className="flex gap-2" role="group" aria-label="Engine">
            {ENGINES.map(({ id, label }) => (
              <Button
                key={id}
                variant={engine === id ? "default" : "outline"}
                onClick={() => setEngine(id)}
                className={engine === id ? "bg-indigo-600" : "border-slate-700 text-slate-300"}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="flex gap-2">
            <Button
              variant={filterType === "all" ? "default" : "outline"}
              onClick={() => setFilterType("all")}
              className={filterType === "all" ? "bg-indigo-600" : "border-slate-700 text-slate-300"}
            >
              All
            </Button>
            <Button
              variant={filterType === "buy" ? "default" : "outline"}
              onClick={() => setFilterType("buy")}
              className={filterType === "buy" ? "bg-green-600" : "border-slate-700 text-slate-300"}
            >
              Buy
            </Button>
            <Button
              variant={filterType === "sell" ? "default" : "outline"}
              onClick={() => setFilterType("sell")}
              className={filterType === "sell" ? "bg-red-600" : "border-slate-700 text-slate-300"}
            >
              Sell
            </Button>
          </div>
        </div>

        {/* Trade List */}
        <div className="space-y-4">
          {isLoading ? (
            <div className="text-center py-12">
              <div className="inline-flex items-center gap-3">
                <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-slate-400">Loading trades...</span>
              </div>
            </div>
          ) : isError ? (
            <Card className="bg-red-950/20 border-red-900/50">
              <CardContent className="py-12 text-center">
                <p className="text-red-300">Could not load trades: {tradesError?.message}</p>
              </CardContent>
            </Card>
          ) : filteredTrades.length === 0 ? (
            <Card className="bg-slate-800 border-slate-700">
              <CardContent className="py-12 text-center">
                <p className="text-slate-400">
                  {engine === "v6" && !searchQuery && filterType === "all"
                    ? 'No V6 trades yet. Being in cash is a valid result. Older trades are under Legacy.'
                    : 'No trades found'}
                </p>
              </CardContent>
            </Card>
          ) : (
            filteredTrades.map((trade) => {
              const quantity = trade.quantity || 0;
              const price = trade.price || 0;
              const totalValue = trade.total_value || 0;
              const profitLoss = trade.profit_loss || 0;
              const isV6 = isV6Trade(trade);
              
              // Get status styling
              const getStatusColor = (status) => {
                switch(status) {
                  case 'completed':
                    return 'bg-green-500/20 text-green-400 border-green-500/50';
                  case 'pending':
                    return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
                  case 'failed':
                    return 'bg-red-500/20 text-red-400 border-red-500/50';
                  case 'cancelled':
                    return 'bg-slate-500/20 text-slate-400 border-slate-500/50';
                  default:
                    return 'bg-slate-500/20 text-slate-400 border-slate-500/50';
                }
              };

              const getStatusIcon = (status) => {
                switch(status) {
                  case 'completed':
                    return '✓';
                  case 'pending':
                    return '⏱';
                  case 'failed':
                    return '✗';
                  case 'cancelled':
                    return '⊘';
                  default:
                    return '•';
                }
              };
              
              return (
                <Card key={trade.id} className={`border transition-colors ${
                  trade.status === 'completed' ? 'bg-slate-800 border-slate-700 hover:border-slate-600' :
                  trade.status === 'failed' ? 'bg-red-950/20 border-red-900/50' :
                  trade.status === 'cancelled' ? 'bg-slate-800/50 border-slate-700/50' :
                  'bg-slate-800 border-yellow-500/30'
                }`}>
                  <CardContent className="pt-6">
                    <div className="flex flex-col gap-4">
                      {/* Header Row */}
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                            trade.trade_type === 'buy' ? 'bg-green-500/20' : 'bg-red-500/20'
                          }`}>
                            {trade.trade_type === 'buy' ? (
                              <TrendingUp className="w-6 h-6 text-green-400" />
                            ) : (
                              <TrendingDown className="w-6 h-6 text-red-400" />
                            )}
                          </div>
                          
                          <div>
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <h3 className="font-bold text-white text-lg">{trade.asset_symbol}</h3>
                              <Badge className={
                                trade.trade_type === 'buy' 
                                  ? 'bg-green-500/20 text-green-400 border-green-500/50' 
                                  : 'bg-red-500/20 text-red-400 border-red-500/50'
                              }>
                                {(trade.trade_type ?? 'trade').toUpperCase()}
                              </Badge>
                              <Badge className={`${getStatusColor(trade.status)} border-2 font-bold`}>
                                {getStatusIcon(trade.status)} {(trade.status ?? 'unknown').toUpperCase()}
                              </Badge>
                            </div>
                            <p className="text-sm text-slate-400">
                              {tradeTime(trade)}
                            </p>
                          </div>
                        </div>
                        
                        {/* P&L Badge (for sell trades) */}
                        {(profitLoss !== 0 || trade.trade_type === 'sell') && trade.status === 'completed' && (
                          <Badge className={`text-lg px-4 py-2 ${
                            profitLoss > 0 
                              ? 'bg-green-500/20 text-green-400 border-green-500/50' 
                              : profitLoss < 0
                              ? 'bg-red-500/20 text-red-400 border-red-500/50'
                              : 'bg-slate-500/20 text-slate-400 border-slate-500/50'
                          } border-2`}>
                            {signedMoney(profitLoss)} P&L
                          </Badge>
                        )}
                      </div>

                      {/* Trade Details Grid */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-slate-900/50 rounded-lg">
                        <div>
                          <p className="text-slate-400 text-xs mb-1">Quantity</p>
                          <p className="text-white font-bold text-lg">{quantity.toFixed(6)}</p>
                        </div>
                        <div>
                          <p className="text-slate-400 text-xs mb-1">Execution Price</p>
                          <p className="text-white font-bold text-lg">${price.toLocaleString()}</p>
                        </div>
                        <div>
                          <p className="text-slate-400 text-xs mb-1">Total Value</p>
                          <p className="text-white font-bold text-lg">${totalValue.toLocaleString()}</p>
                        </div>
                        <div>
                          <p className="text-slate-400 text-xs mb-1">Exchange</p>
                          <p className="text-white font-semibold">{trade.exchange}</p>
                        </div>
                      </div>

                      {/* Execution Details */}
                      {trade.status === 'completed' && (
                        <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-4">
                          <div className="flex items-start gap-2 mb-2">
                            <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1">
                              <h4 className="text-green-400 font-semibold mb-1">{isV6 ? 'Paper fill recorded' : 'Trade filled'}</h4>
                              <p className="text-slate-300 text-sm">
                                {trade.trade_type === 'buy' ? 'Bought' : 'Sold'} {quantity.toFixed(6)} {(trade.asset_symbol ?? '').split('/')[0]} at ${price.toLocaleString()}
                                {(profitLoss !== 0 || trade.trade_type === 'sell') && (
                                  <span className={profitLoss > 0 ? 'text-green-400' : profitLoss < 0 ? 'text-red-400' : 'text-slate-400'}>
                                    {' • '}{profitLoss > 0 ? 'Profit' : profitLoss < 0 ? 'Loss' : 'P&L'}: {signedMoney(profitLoss)}
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                          {trade.trade_type === 'buy' && (
                            <p className="text-xs text-slate-400 ml-7">
                              ℹ️ Position opened
                            </p>
                          )}
                          {trade.trade_type === 'sell' && (
                            <p className="text-xs text-slate-400 ml-7">
                              ℹ️ Position closed • Return: {(totalValue - profitLoss) > 0 ? ((profitLoss / (totalValue - profitLoss)) * 100).toFixed(2) : '0.00'}%
                            </p>
                          )}
                        </div>
                      )}

                      {trade.status === 'pending' && (
                        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-4">
                          <div className="flex items-start gap-2">
                            <RefreshCw className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5 animate-spin" />
                            <div>
                              <h4 className="text-yellow-400 font-semibold mb-1">Trade Pending</h4>
                              <p className="text-slate-300 text-sm">
                                Waiting for execution... This may take a few moments.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {trade.status === 'failed' && (
                        <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4">
                          <div className="flex items-start gap-2">
                            <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                            <div>
                              <h4 className="text-red-400 font-semibold mb-1">Trade Failed</h4>
                              <p className="text-slate-300 text-sm">
                                The trade could not be executed. Possible reasons: insufficient balance, market conditions, or system error.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {trade.status === 'cancelled' && (
                        <div className="bg-slate-500/5 border border-slate-500/20 rounded-lg p-4">
                          <div className="flex items-start gap-2">
                            <XCircle className="w-5 h-5 text-slate-400 flex-shrink-0 mt-0.5" />
                            <div>
                              <h4 className="text-slate-400 font-semibold mb-1">Trade Cancelled</h4>
                              <p className="text-slate-300 text-sm">
                                This trade was cancelled before execution.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {isV6 && <V6TradeDetail trade={trade} />}

                      {/* Old engine's signal. Its score was never a probability: the audit
                          found its top score (95) was the worst-performing group. */}
                      {!isV6 && trade.ai_signal && (
                        <div className="border-t border-slate-700 pt-4">
                          <div className="flex items-start gap-2">
                            <Sparkles className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <h4 className="text-indigo-300 font-semibold">Old engine signal</h4>
                                {Number.isFinite(trade.ai_signal.signal_strength ?? trade.ai_signal.confidence) && (
                                  <Badge className="bg-slate-700 text-slate-300 border-slate-600">
                                    Indicator score {trade.ai_signal.signal_strength ?? trade.ai_signal.confidence}/100, not a probability
                                  </Badge>
                                )}
                              </div>
                              <p className="text-sm text-slate-300 mb-2">
                                {trade.ai_signal.reasoning}
                              </p>
                              {trade.ai_signal.indicators && trade.ai_signal.indicators.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                  {trade.ai_signal.indicators.map((indicator, idx) => (
                                    <Badge key={idx} variant="outline" className="border-indigo-500/30 text-indigo-300 text-xs">
                                      {indicator}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}