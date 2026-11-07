/**
 * Advanced AI Signal Generator
 * Incorporates multiple data sources for sophisticated trading signals
 */

import { base44 } from "@/api/base44Client";
import { analyzeIndicators } from "./TechnicalAnalysisEngine";

// Cache for market intelligence results to prevent rate limiting
const cache = {
  intelligence: new Map()
};

const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// aiMarketIntelligence serves one call per 60s and answers 503 otherwise, so
// asking faster only fills the server log. One call at a time, spaced to match,
// and failures back off instead of repeating on every poll.
const CALL_SPACING_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const gate = { nextCallAt: 0, failures: 0, inFlight: false };

/** How long until a new intelligence call may be made. 0 means now. */
export const marketIntelligenceRetryInMs = () => Math.max(0, gate.nextCallAt - Date.now());

// Real-time market intelligence (news, social, on-chain) via server-side
// backend function with live web search. Returns null when rate-limited or
// unavailable — never fabricated data.
export const fetchMarketIntelligence = async (asset) => {
  const cached = cache.intelligence.get(asset.symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

  if (gate.inFlight || marketIntelligenceRetryInMs() > 0) return null;

  gate.inFlight = true;
  try {
    // invoke() resolves to { data }: the function's own body is under .data.
    const { data } = await base44.functions.invoke('aiMarketIntelligence', {
      symbol: asset.symbol,
      name: asset.name,
    });

    gate.nextCallAt = Date.now() + CALL_SPACING_MS;
    if (!data?.success) return null;
    gate.failures = 0;

    const result = {
      news: data.news,
      social: data.social,
      onchain: data.onchain,
      fetchedAt: new Date().toISOString(),
    };
    cache.intelligence.set(asset.symbol, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    if (error?.status === 503) {
      // The server's own throttle: expected, and it says when to come back.
      gate.nextCallAt = Date.now() + (error.body?.retry_after_ms ?? CALL_SPACING_MS);
    } else {
      gate.failures += 1;
      gate.nextCallAt = Date.now() + Math.min(MAX_BACKOFF_MS, CALL_SPACING_MS * 2 ** gate.failures);
      if (gate.failures === 1) console.warn('Market intelligence unavailable:', error?.message);
    }
    return null;
  } finally {
    gate.inFlight = false;
  }
};

// Predictive price movement analysis using machine learning-like patterns
const predictPriceMovement = (asset) => {
  // Analyze recent momentum and patterns
  const momentum = asset.change24h;
  const volumeTrend = asset.volume24h / 1500000000; // Normalized volume
  
  // Calculate momentum indicators
  const shortTermMomentum = momentum;
  const volumeStrength = Math.min(volumeTrend * 100, 100);
  
  // Pattern recognition - detect bullish/bearish patterns
  const isBullishPattern = momentum > 0 && volumeTrend > 1.2;
  const isBearishPattern = momentum < 0 && volumeTrend > 1.2;
  
  // Predict next 24h movement
  let predictedChange = momentum * 0.6; // Momentum continuation factor
  
  // Add pattern influence
  if (isBullishPattern) predictedChange += 2;
  if (isBearishPattern) predictedChange -= 2;
  
  // Add volume influence
  if (volumeTrend > 2) predictedChange *= 1.2;
  
  // Calculate target price
  const currentPrice = asset.price;
  const predictedPrice = currentPrice * (1 + predictedChange / 100);
  
  // Confidence in prediction (0-100)
  const predictionConfidence = Math.min(95, Math.max(30, 
    50 + (volumeStrength * 0.3) + (Math.abs(momentum) * 2)
  ));
  
  return {
    predicted_change: predictedChange,
    predicted_price: predictedPrice,
    prediction_confidence: Math.round(predictionConfidence),
    timeframe: '24h',
    pattern_detected: isBullishPattern ? 'bullish' : isBearishPattern ? 'bearish' : 'neutral',
    key_factors: [
      `Momentum: ${momentum > 0 ? '+' : ''}${momentum.toFixed(2)}%`,
      `Volume trend: ${volumeTrend.toFixed(2)}x average`,
      `Pattern: ${isBullishPattern ? 'Bullish breakout' : isBearishPattern ? 'Bearish breakdown' : 'Consolidation'}`
    ]
  };
};

// Generate a signal driven PURELY by technical indicators on real Binance
// OHLCV candles. No simulated news, social, or on-chain data — those were
// Math.random()-based and fabricated confidence. The app's indicators deduce
// the signal from real exchange data.
export const generateAdvancedSignal = async (asset, signalConfig = null, indicatorSettings = { rsi: true, macd: true, bollinger: true, ema: true, stoch: true }) => {
  try {
    // Advanced Technical Analysis on REAL Binance candles.
    // Returns null when candle data is unavailable — no data means no signal.
    const technicalAnalysis = await analyzeIndicators(asset, indicatorSettings);

    if (!technicalAnalysis) {
      return {
        symbol: asset.symbol,
        available: false,
        reason: 'no_market_data',
        message: `No candle data available for ${asset.symbol}. No signal generated.`,
      };
    }

    // Technical score from REAL Binance 24h change & quote volume (no market cap).
    let technicalScore = calculateTechnicalScore(asset);
    technicalScore = Math.max(0, Math.min(100, technicalScore + technicalAnalysis.scoreModifier));

    // Deterministic momentum read from real Binance change & volume.
    const prediction = predictPriceMovement(asset);

    // Confidence is driven strictly by technical indicators on real candles.
    let confidence = Math.max(30, Math.min(95, Math.round(technicalScore)));

    // Risk level from real volatility.
    let riskLevel = 'medium';
    const volatility = Math.abs(asset.change24h || 0);
    if (confidence >= 80 && volatility < 5) riskLevel = 'low';
    else if (confidence < 60 || volatility > 10) riskLevel = 'high';

    // Recommendation from technicals + real momentum only.
    let recommendation = 'hold';
    if (confidence >= 75 && asset.change24h > 1 && prediction.predicted_change > 0) {
      recommendation = 'buy';
    } else if (confidence < 50 || asset.change24h < -3 || prediction.predicted_change < -3) {
      recommendation = 'sell';
    }

    return {
      confidence,
      recommendation,
      riskLevel,
      prediction,
      activeIndicators: [
        { name: "Technical Analysis", status: "active", score: technicalScore, weight: "100%" },
        { name: "Pattern Recognition", status: "active", score: prediction.prediction_confidence, weight: "Variable" }
      ],
      technicalDetails: technicalAnalysis,
      breakdown: {
        technical: technicalScore,
        advanced_indicators: technicalAnalysis.results
      },
      signals: {
        strength: confidence >= 75 ? 'strong' : confidence >= 60 ? 'moderate' : 'weak',
        direction: technicalScore >= 60 ? 'bullish' : technicalScore <= 40 ? 'bearish' : 'neutral'
      }
    };
  } catch (error) {
    console.error("Advanced signal generation failed:", error);
    // Fallback to basic calculation
    return generateBasicSignal(asset);
  }
};

// Calculate technical score from price/volume data
const calculateTechnicalScore = (asset) => {
  let score = 50;

  // Price momentum (Refined V4)
  const change = asset.change24h || 0;
  if (change > 2 && change <= 10) score += 20; // Sweet spot
  else if (change > 10) score += 5; // Overextended
  else if (change > 0) score += 10; // Slow grind
  else if (change > -3) score += 5; // Dip
  else if (change > -8) score -= 5; // Correction
  else score -= 20; // Crash

  // Volume analysis (real Binance quote volume)
  const avgVolume = 1500000000;
  if (asset.volume24h > avgVolume * 2) score += 15;
  else if (asset.volume24h > avgVolume) score += 10;
  else if (asset.volume24h < avgVolume / 2) score -= 10;

  // Volatility
  const volatility = Math.abs(change);
  if (volatility > 10) score -= 10;
  else if (volatility < 2) score += 5;

  return Math.max(0, Math.min(100, score));
};

const generateBasicSignal = (asset) => {
  const basicScore = calculateTechnicalScore(asset);
  return {
    confidence: Math.max(30, Math.min(95, basicScore)),
    recommendation: basicScore > 70 ? 'buy' : basicScore < 40 ? 'sell' : 'hold',
    riskLevel: basicScore > 70 ? 'low' : basicScore > 50 ? 'medium' : 'high',
    breakdown: {
      technical: basicScore
    },
    signals: {
      strength: basicScore > 70 ? 'strong' : basicScore > 50 ? 'moderate' : 'weak',
      direction: basicScore > 60 ? 'bullish' : basicScore < 40 ? 'bearish' : 'neutral'
    }
  };
};