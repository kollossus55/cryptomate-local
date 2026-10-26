/**
 * Local scheduler — replaces the Base44 workflows.
 *
 * The hosted app ran three cron workflows. Those schedules are reproduced here
 * as interval timers.
 *
 * Each job waits for its previous run to finish before starting again. The
 * trading worker mutates the portfolio, and two overlapping runs would
 * double-spend the same cash.
 */

const JOBS = [
  // Matches "Auto Trading Scheduler" — */5 * * * *
  { name: 'tradingScheduler', fn: 'tradingScheduler', everyMinutes: 5 },
  // Matches "Altcoin Scan Scheduler" — */15 * * * *
  { name: 'altcoinScan', fn: 'altcoinScannerWorker', everyMinutes: 15 },
  // Matches "Notification Cleanup" — daily
  { name: 'notificationCleanup', fn: 'notificationCleanup', everyMinutes: 1440 },
];

// ---------------------------------------------------------------------------
// Dead-man's-switch heartbeat (LOCAL-ONLY feature, 2026-10-26).
//
// Every 5 minutes the server performs ONE outbound HTTPS ping to
// HEARTBEAT_URL from .env (a Healthchecks.io ping URL). If those pings ever
// stop — crash, hang, machine asleep, scheduler wedged, power cut —
// Healthchecks' OWN servers notice the silence and email/notify the owner.
//
// Design notes that matter:
//   * The ping must be an outbound UNCONDITIONAL side effect, not a trading
//     job. A job hangs -> its own watchdog pipeline is silent exactly when
//     you need noise. This timer lives outside the JOBS machinery entirely.
//   * A failed ping is logged and swallowed. Never retried, never thrown:
//     outbound internet is flaky; the trading path must not care. Healthchecks
//     tolerates several missed pings (grace period) before alerting.
//   * The URL is a soft secret (anyone holding it could spoof "alive").
//     It lives in .env (gitignored) and is never logged-provisioned beyond
//     its hostname.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export class Scheduler {
  constructor({ registry, store, log }) {
    this.registry = registry;
    this.store = store;
    this.log = log;
    this.timers = [];
    this.running = new Set();
    this.lastRun = {};
    this.heartbeat = { enabled: false, target: null, lastAttempt: null, lastOk: null, lastStatus: null };
  }

  start() {
    this.startHeartbeat();
    for (const job of JOBS) {
      if (!this.registry.has(job.fn)) {
        this.log.warn(`Scheduler: "${job.fn}" is not loaded — skipping ${job.name}`);
        continue;
      }

      const tick = async () => {
        if (this.running.has(job.name)) {
          this.log.warn(`${job.name} is still running — skipping this tick`);
          return;
        }
        this.running.add(job.name);
        try {
          const result = await this.registry.invoke(job.fn, {});
          this.lastRun[job.name] = { at: new Date().toISOString(), ok: true, result };
        } catch (err) {
          this.lastRun[job.name] = { at: new Date().toISOString(), ok: false, error: err.message };
          this.log.error(`${job.name} failed: ${err.message}`);
        } finally {
          this.running.delete(job.name);
        }
      };

      // Stagger the first run so three jobs do not all fire at boot.
      const delay = this.timers.length * 20_000 + 10_000;
      setTimeout(() => { tick(); this.timers.push(setInterval(tick, job.everyMinutes * 60_000)); }, delay);

      this.log.info(`Scheduled ${job.name} every ${job.everyMinutes} min`);
    }
  }

  /**
   * Start the heartbeat ping. Deliberately independent of the JOBS above:
   * this answers "is the process alive AT ALL", not "did trading run".
   */
  startHeartbeat() {
    const url = process.env.HEARTBEAT_URL;

    if (!url || !/^https:\/\//.test(url)) {
      // Not an error: a fresh install without the optional monitor configured
      // is normal. One info line, once, so the operator knows it is off.
      this.log.info('Heartbeat: disabled (HEARTBEAT_URL not set in .env)');
      return;
    }

    let host;
    try {
      host = new URL(url).host;
    } catch {
      this.log.error('Heartbeat: HEARTBEAT_URL is not a valid https URL — disabled');
      return;
    }

    this.heartbeat.enabled = true;
    this.heartbeat.target = host;

    const beat = async () => {
      this.heartbeat.lastAttempt = new Date().toISOString();
      try {
        // POST body doubles as a stored note on the Healthchecks dashboard;
        // uptime answers "did it silently restart?" at a glance. 10s timeout:
        // far shorter than the trading fetch guard — a slow ping is a skipped
        // ping here, never a hung trading path.
        const res = await fetch(url, {
          method: 'POST',
          body: `ok fn=${this.registry?.handlers?.size ?? '?'} up=${Math.round(process.uptime())}s`,
          signal: AbortSignal.timeout(10_000),
        });
        this.heartbeat.lastOk = res.ok;
        this.heartbeat.lastStatus = res.status;
      } catch (err) {
        this.heartbeat.lastOk = false;
        this.heartbeat.lastStatus = String(err.cause?.code ?? err.message).slice(0, 120);
        this.log.warn(`Heartbeat ping failed: ${err.message}`);
      }
    };

    // First beat immediately (proves wiring at boot), then every 5 minutes.
    setTimeout(beat, 2_000);
    this.hbTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    this.timers.push(this.hbTimer);

    this.log.info(`Heartbeat: enabled, pinging ${host} every 5 min`);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  status() {
    return {
      jobs: JOBS.map((j) => j.name),
      lastRun: this.lastRun,
      running: [...this.running],
      heartbeat: this.heartbeat,
    };
  }
}
