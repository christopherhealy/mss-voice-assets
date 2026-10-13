// ============================================================
// conversation/ingleLiveRecoveryScheduler.js
//
// Scheduler for durable GPT Live confirmed-closure recovery.
//
// SECURITY:
// - Disabled unless explicitly enabled.
// - Production interval is validated and bounded.
// - Never overlaps batches within one process.
// - Errors are logged without terminating the scheduler.
// - Shutdown prevents further scheduling.
// - Shutdown waits for an active batch.
//
// TESTABILITY:
// - Batch function, enabled state, and interval can be
//   injected without changing production defaults.
// ============================================================

import {
  runLiveRecoveryBatch,
} from "./ingleLiveRecoveryWorker.js";

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 15_000;
const MAX_INTERVAL_MS = 3_600_000;

function readInterval() {
  const raw = process.env.INGLE_LIVE_RECOVERY_INTERVAL_MS;

  if (raw === undefined || raw === "") {
    return DEFAULT_INTERVAL_MS;
  }

  const value = Number(raw);

  if (
    !Number.isSafeInteger(value) ||
    value < MIN_INTERVAL_MS ||
    value > MAX_INTERVAL_MS
  ) {
    throw new Error("live_recovery_invalid_interval");
  }

  return value;
}

export function startLiveRecoveryScheduler({
  enabled = process.env.INGLE_LIVE_RECOVERY_ENABLED === "true",
  intervalMs = readInterval(),
  runBatch = runLiveRecoveryBatch,
} = {}) {
  if (typeof enabled !== "boolean") {
    throw new Error("live_recovery_invalid_enabled");
  }

  if (!enabled) {
    console.log("LIVE_RECOVERY_SCHEDULER_DISABLED");

    return {
      enabled: false,
      stop: async () => {},
    };
  }

  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > MAX_INTERVAL_MS
  ) {
    throw new Error("live_recovery_invalid_interval");
  }

  if (typeof runBatch !== "function") {
    throw new Error("live_recovery_invalid_batch_function");
  }

  let stopped = false;
  let running = false;
  let activeBatch = null;
  let timer = null;

  async function tick() {
    if (stopped || running) {
      return;
    }

    running = true;

    activeBatch = (async () => {
      try {
        const result = await runBatch();

        if (result?.claimed > 0) {
          console.log(
            "LIVE_RECOVERY_BATCH_COMPLETE",
            {
              claimed: result.claimed,
              results: result.results,
            }
          );
        }
      } catch (error) {
        console.error(
          "LIVE_RECOVERY_BATCH_ERROR",
          {
            message: error?.message || String(error),
          }
        );
      } finally {
        running = false;
      }
    })();

    await activeBatch;
  }

  async function loop() {
    await tick();

    if (!stopped) {
      timer = setTimeout(loop, intervalMs);
    }
  }

  // Run one immediate batch, then schedule subsequent batches.
  void loop();

  console.log(
    "LIVE_RECOVERY_SCHEDULER_STARTED",
    { intervalMs }
  );

  return {
    enabled: true,

    async stop() {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (activeBatch) {
        await activeBatch;
      }

      console.log("LIVE_RECOVERY_SCHEDULER_STOPPED");
    },
  };
}
