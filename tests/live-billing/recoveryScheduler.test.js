import test from "node:test";
import assert from "node:assert/strict";

import {
  startLiveRecoveryScheduler,
} from "../../conversation/ingleLiveRecoveryScheduler.js";

// ============================================================
// GPT Live recovery scheduler QA.
//
// No PostgreSQL operations.
// No OpenAI calls.
// No financial API calls.
//
// Tests scheduler behaviour with injected batch functions.
// ============================================================

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("qa_wait_timeout");
    }

    await delay(5);
  }
}

function deferred() {
  let resolve;

  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test(
  "GPT Live recovery scheduler: disabled mode",
  async () => {
    let calls = 0;

    const scheduler = startLiveRecoveryScheduler({
      enabled: false,
      intervalMs: 10,
      runBatch: async () => {
        calls++;
        return { claimed: 0, results: [] };
      },
    });

    await delay(40);

    assert.equal(scheduler.enabled, false);
    assert.equal(calls, 0);

    await scheduler.stop();

    console.log("PASS: Disabled scheduler performs no work.");
  }
);

test(
  "GPT Live recovery scheduler: immediate execution and shutdown",
  async () => {
    let calls = 0;

    const scheduler = startLiveRecoveryScheduler({
      enabled: true,
      intervalMs: 20,
      runBatch: async () => {
        calls++;
        return { claimed: 0, results: [] };
      },
    });

    try {
      await waitFor(() => calls >= 2);

      assert.equal(scheduler.enabled, true);
    } finally {
      await scheduler.stop();
    }

    const countAfterStop = calls;

    await delay(60);

    assert.equal(calls, countAfterStop);

    console.log(
      "PASS: Immediate execution and shutdown prevent further batches."
    );
  }
);

test(
  "GPT Live recovery scheduler: no overlapping batches",
  async () => {
    const releaseBatch = deferred();

    let calls = 0;
    let active = 0;
    let maxActive = 0;

    const scheduler = startLiveRecoveryScheduler({
      enabled: true,
      intervalMs: 10,
      runBatch: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);

        if (calls === 1) {
          await releaseBatch.promise;
        }

        active--;

        return { claimed: 0, results: [] };
      },
    });

    try {
      await waitFor(() => calls === 1);

      await delay(60);

      assert.equal(calls, 1);
      assert.equal(maxActive, 1);

      releaseBatch.resolve();

      await waitFor(() => calls >= 2);

      assert.equal(maxActive, 1);
    } finally {
      releaseBatch.resolve();
      await scheduler.stop();
    }

    console.log("PASS: Recovery batches never overlap.");
  }
);

test(
  "GPT Live recovery scheduler: errors do not stop execution",
  async () => {
    let calls = 0;

    const originalError = console.error;
    const loggedErrors = [];

    console.error = (...args) => {
      loggedErrors.push(args);
    };

    let scheduler;

    try {
      scheduler = startLiveRecoveryScheduler({
        enabled: true,
        intervalMs: 10,
        runBatch: async () => {
          calls++;

          if (calls === 1) {
            throw new Error("qa_simulated_failure");
          }

          return { claimed: 0, results: [] };
        },
      });

      await waitFor(() => calls >= 2);

      assert.ok(loggedErrors.length >= 1);
      assert.equal(
        loggedErrors[0][0],
        "LIVE_RECOVERY_BATCH_ERROR"
      );
    } finally {
      if (scheduler) {
        await scheduler.stop();
      }

      console.error = originalError;
    }

    console.log("PASS: Scheduler continues after batch failure.");
  }
);

test(
  "GPT Live recovery scheduler: shutdown waits for active batch",
  async () => {
    const releaseBatch = deferred();

    let started = false;
    let finished = false;
    let stopResolved = false;

    const scheduler = startLiveRecoveryScheduler({
      enabled: true,
      intervalMs: 10,
      runBatch: async () => {
        started = true;

        await releaseBatch.promise;

        finished = true;

        return { claimed: 0, results: [] };
      },
    });

    try {
      await waitFor(() => started);

      const stopping = scheduler.stop().then(() => {
        stopResolved = true;
      });

      await delay(40);

      assert.equal(stopResolved, false);

      releaseBatch.resolve();

      await stopping;

      assert.equal(finished, true);
      assert.equal(stopResolved, true);
    } finally {
      releaseBatch.resolve();
      await scheduler.stop();
    }

    console.log("PASS: Shutdown waits for active recovery batch.");
  }
);
