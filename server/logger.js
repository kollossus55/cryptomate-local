/**
 * Logging.
 *
 * Console plus a daily rotating file. The file matters: when the bot has been
 * running unattended for a week and a position closed unexpectedly, the log is
 * the only record of why. Each cycle logs the gate it stopped at, so "no trades
 * today" always has a traceable reason rather than being silence.
 *
 * Secrets are redacted on the way out — an API key that reaches a log file has
 * leaked, and logs get pasted into chats and issue trackers.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS = [
  /\b[A-Za-z0-9_-]{32,}\b/g,         // long opaque tokens
  /(api[_-]?(key|secret)["':\s=]+)([^\s"',}]+)/gi,
  /(passphrase["':\s=]+)([^\s"',}]+)/gi,
];

export function redact(text) {
  let out = String(text);
  out = out.replace(SECRET_PATTERNS[1], (_, p1) => `${p1}[REDACTED]`);
  out = out.replace(SECRET_PATTERNS[2], (_, p1) => `${p1}[REDACTED]`);
  // Long opaque strings: keep the first 4 chars so logs stay diagnosable.
  out = out.replace(SECRET_PATTERNS[0], (m) => `${m.slice(0, 4)}…[REDACTED]`);
  return out;
}

export class Logger {
  constructor({ dir, level = 'info', retentionDays = 30, quiet = false } = {}) {
    this.dir = dir;
    this.threshold = LEVELS[level] ?? LEVELS.info;
    this.retentionDays = retentionDays;
    this.quiet = quiet;
    this.recent = [];
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (dir) this._prune();
  }

  _file() {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, `bot-${day}.log`);
  }

  _prune() {
    try {
      const cutoff = Date.now() - this.retentionDays * 86400000;
      for (const f of readdirSync(this.dir)) {
        if (!f.startsWith('bot-') || !f.endsWith('.log')) continue;
        const p = path.join(this.dir, f);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      }
    } catch { /* logging must never crash the bot */ }
  }

  _write(level, message) {
    if (LEVELS[level] < this.threshold) return;

    // LOCAL FIX: strip control characters before redaction. Function error
    // messages can embed raw request input (e.g. "Unknown action: ${action}"),
    // and a CRLF in that input lands verbatim in the log file — a forged line
    // that looks like it came from the server. Redaction runs after this, so
    // redacted placeholders stay intact.
    const safe = redact(String(message).replace(/[\r\n]+/g, ' '));
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${safe}`;

    // Kept in memory so the dashboard can show recent activity without
    // re-reading the file on every request.
    this.recent.push({ at: Date.now(), level, message: safe });
    if (this.recent.length > 500) this.recent.shift();

    if (!this.quiet) {
      const stream = level === 'error' || level === 'warn' ? console.error : console.log;
      stream(line);
    }

    if (this.dir) {
      try { appendFileSync(this._file(), line + '\n', 'utf8'); } catch { /* ignore */ }
    }
  }

  debug(m) { this._write('debug', m); }
  info(m) { this._write('info', m); }
  warn(m) { this._write('warn', m); }
  error(m) { this._write('error', m); }

  tail(n = 100) {
    return this.recent.slice(-n);
  }
}
