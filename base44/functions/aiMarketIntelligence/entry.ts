import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Backoff state for the throttle below (see Deno.serve). Kept at module
// scope deliberately: the local runtime caches function modules for the
// process lifetime, so this survives across requests without any store.
const MIN_INTEL_INTERVAL_MS = 60_000;
const MAX_INTEL_BACKOFF_MS = 5 * 60_000;
let _lastIntelAttemptAt = 0;
let _intelBackoffMs = 0;

/**
 * AI Market Intelligence — fetches real-time news, social, and on-chain
 * sentiment for a single cryptocurrency via live web search.
 *
 * Narrow, app-specific operation: the client sends only { symbol, name };
 * the prompt is constructed entirely server-side. The client never sends
 * a raw prompt, preventing prompt-injection abuse of integration credits.
 */

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Require authentication — prevents anonymous credit consumption.
    try {
      await base44.auth.me();
    } catch {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { symbol, name } = await req.json();

    if (!symbol || !name) {
      return Response.json({ error: 'symbol and name required' }, { status: 400 });
    }

    // LOCAL FIX (2026-10-27): throttle + backoff. The UI polls this function
    // for every asset in a widget's watchlist, so one tick = five near-
    // simultaneous LLM calls. On the local build's own API key (free tier)
    // that burned the entire quota — 5x 429 per cycle, all night, log full
    // of it — while NONE of this feeds the auto-trading path (the worker
    // builds its signals from the local signal engine; this is a dashboard
    // feature only). Now: at most ONE Google call per 60s window, and after
    // a 429 the interval doubles up to 5 minutes so quota recovers instead
    // of being hammered. Throttled callers get a 503 the client understands
    // (it returns null and renders without intelligence data).
    const nowMs = Date.now();
    const earliestAllowed = _lastIntelAttemptAt + Math.max(MIN_INTEL_INTERVAL_MS, _intelBackoffMs);
    if (nowMs < earliestAllowed) {
      return Response.json(
        { error: 'Intelligence is rate limited right now', retry_after_ms: earliestAllowed - nowMs },
        { status: 503 }
      );
    }
    _lastIntelAttemptAt = nowMs;

    // Sanitize inputs — only alphanumeric + a few separators.
    const cleanSymbol = String(symbol).replace(/[^A-Za-z0-9/-]/g, '').slice(0, 20);
    const cleanName = String(name).replace(/[^A-Za-z0-9 .-]/g, '').slice(0, 80);

    // Construct the prompt server-side — client never controls the prompt text.
    const prompt = `Search the web for real-time data about the cryptocurrency ${cleanName} (${cleanSymbol}) from the last 24 hours. Provide three analyses based ONLY on what you actually find via web search:

1. NEWS SENTIMENT: 3 actual recent headlines you found, an overall sentiment score from -1 (very bearish) to 1 (very bullish), a sentiment label, the impact level, a brief summary, and the source name for each headline.

2. SOCIAL MEDIA SENTIMENT: Based on real Twitter/X, Reddit, and crypto forums data, return a social score (0-100), mention volume, a sentiment breakdown (positive/neutral/negative percentages summing to 100), up to 3 real trending topics or hashtags, influencer sentiment, and engagement level.

3. ON-CHAIN METRICS: Based on real on-chain data, return an on-chain score (0-100), whale activity, exchange flow, network health %, a holder distribution summary, key metrics (active addresses, transaction volume in USD, large tx count), and an overall on-chain signal.

Do not invent data; if little is found for any section, reflect that in conservative values.`;

    const response = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: true,
      model: 'gemini_3_flash',
      response_json_schema: {
        type: 'object',
        properties: {
          news: {
            type: 'object',
            properties: {
              sentiment_score: { type: 'number' },
              sentiment_label: { type: 'string', enum: ['very_bearish', 'bearish', 'neutral', 'bullish', 'very_bullish'] },
              key_headlines: { type: 'array', items: { type: 'string' } },
              impact_level: { type: 'string', enum: ['low', 'medium', 'high'] },
              summary: { type: 'string' },
              sources: { type: 'array', items: { type: 'string' } },
            },
          },
          social: {
            type: 'object',
            properties: {
              social_score: { type: 'number' },
              mention_volume: { type: 'string', enum: ['high', 'moderate', 'low'] },
              sentiment_breakdown: {
                type: 'object',
                properties: {
                  positive: { type: 'number' },
                  neutral: { type: 'number' },
                  negative: { type: 'number' },
                },
              },
              trending_topics: { type: 'array', items: { type: 'string' } },
              influencer_sentiment: { type: 'string', enum: ['bullish', 'mixed', 'bearish'] },
              engagement_level: { type: 'string', enum: ['viral', 'high', 'moderate', 'low'] },
            },
          },
          onchain: {
            type: 'object',
            properties: {
              onchain_score: { type: 'number' },
              whale_activity: { type: 'string', enum: ['accumulating', 'distributing', 'neutral'] },
              exchange_flow: { type: 'string', enum: ['net_inflow', 'net_outflow', 'balanced'] },
              network_health: { type: 'number' },
              holder_distribution: { type: 'string' },
              key_metrics: {
                type: 'object',
                properties: {
                  active_addresses: { type: 'number' },
                  transaction_volume: { type: 'number' },
                  large_transactions: { type: 'number' },
                },
              },
              signal: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
            },
          },
        },
      },
    });

    // Normalize — clamp ranges and fill defaults so the client gets clean data.
    // The call SUCCEEDED here, so the backoff resets to the plain one-per-minute
    // spacing — a burned-successful quota is worth more than a fast dashboard.
    _intelBackoffMs = 0;
    const news = {
      sentiment_score: Math.max(-1, Math.min(1, response.news?.sentiment_score || 0)),
      sentiment_label: response.news?.sentiment_label || 'neutral',
      key_headlines: (response.news?.key_headlines || []).slice(0, 3),
      impact_level: response.news?.impact_level || 'medium',
      summary: response.news?.summary || '',
      sources: response.news?.sources || [],
    };

    const social = {
      social_score: Math.max(0, Math.min(100, response.social?.social_score || 50)),
      mention_volume: response.social?.mention_volume || 'low',
      sentiment_breakdown: {
        positive: Math.round(response.social?.sentiment_breakdown?.positive ?? 33),
        neutral: Math.round(response.social?.sentiment_breakdown?.neutral ?? 34),
        negative: Math.round(response.social?.sentiment_breakdown?.negative ?? 33),
      },
      trending_topics: (response.social?.trending_topics || []).slice(0, 3),
      influencer_sentiment: response.social?.influencer_sentiment || 'mixed',
      engagement_level: response.social?.engagement_level || 'low',
    };

    const onchain = {
      onchain_score: Math.max(0, Math.min(100, response.onchain?.onchain_score || 50)),
      whale_activity: response.onchain?.whale_activity || 'neutral',
      exchange_flow: response.onchain?.exchange_flow || 'balanced',
      network_health: Math.max(0, Math.min(100, response.onchain?.network_health ?? 70)),
      holder_distribution: response.onchain?.holder_distribution || 'No distribution data available from live sources.',
      key_metrics: {
        active_addresses: response.onchain?.key_metrics?.active_addresses || 0,
        transaction_volume: response.onchain?.key_metrics?.transaction_volume || 0,
        large_transactions: response.onchain?.key_metrics?.large_transactions || 0,
      },
      signal: response.onchain?.signal || 'neutral',
    };

    return Response.json({ success: true, news, social, onchain });
  } catch (error) {
    console.error('AI Market Intelligence Error:', error);
    // Repeated 429s (quota) back off progressively; anything else just waits
    // for the next 60s window. The message text is Google's API envelope,
    // which calls itself a "429" in the quota case — brittle but cheap, and
    // the failure mode of guessing wrong is only a shorter cooldown.
    const isQuota = String(error?.message || error).includes('429');
    _intelBackoffMs = isQuota
      ? Math.min(MAX_INTEL_BACKOFF_MS, Math.max(30_000, _intelBackoffMs * 2))
      : _intelBackoffMs;
    return Response.json({ error: 'Market intelligence unavailable' }, { status: 500 });
  }
});