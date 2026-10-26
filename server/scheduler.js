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

export class Scheduler {
  constructor({ registry, store, log }) {
    this.registry = registry;
    this.store = store;
    this.log = log;
    this.timers = [];
    this.running = new Set();
    this.lastRun = {};
  }

  start() {
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

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  status() {
    return { jobs: JOBS.map((j) => j.name), lastRun: this.lastRun, running: [...this.running] };
  }
}
