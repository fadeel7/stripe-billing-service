// Proves webhook idempotency: the same Stripe event delivered more than once
// must change customer state exactly once. Run with `npm test`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";

const tmp = mkdtempSync(join(tmpdir(), "billing-test-"));
process.env.BILLING_DB_PATH = join(tmp, "unit.db");
const { db } = await import("../src/db.js");

// Best effort: on Windows the open SQLite handle can keep the folder locked.
after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

// Counts how many times the handler actually reached upsertCustomer.
function countingHandler(customerId) {
  const calls = { n: 0 };
  const handle = () => {
    calls.n += 1;
    db.upsertCustomer(customerId, { subscriptionStatus: "active" });
  };
  return { calls, handle };
}

test("same event delivered twice upserts the customer once", () => {
  const { calls, handle } = countingHandler("cus_twice");

  assert.equal(db.processEventOnce("evt_twice", handle), true);
  assert.equal(db.processEventOnce("evt_twice", handle), false);

  assert.equal(calls.n, 1);
  assert.equal(db.hasProcessed("evt_twice"), true);
  assert.deepEqual(db.getCustomer("cus_twice"), { subscriptionStatus: "active" });
});

test("a failed handler releases the claim so Stripe's retry is processed", () => {
  const { calls, handle } = countingHandler("cus_retry");

  assert.throws(() =>
    db.processEventOnce("evt_retry", () => {
      throw new Error("handler crashed");
    })
  );
  assert.equal(db.hasProcessed("evt_retry"), false);

  assert.equal(db.processEventOnce("evt_retry", handle), true);
  assert.equal(db.processEventOnce("evt_retry", handle), false);
  assert.equal(calls.n, 1);
});

// --- End to end: two server processes, one database, one event. ---

const WEBHOOK_SECRET = "whsec_test_idempotency";
const servers = [];

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env,
        STRIPE_SECRET_KEY: "sk_test_dummy",
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_PRICE_ID: "price_test",
        PORT: String(port),
        CLIENT_URL: `http://localhost:${port}`,
        BILLING_DB_PATH: join(tmp, "shared.db"),
      },
    });
    const server = { child, port, log: "" };
    child.stdout.on("data", (chunk) => {
      server.log += chunk;
      if (server.log.includes("Server running")) resolve(server);
    });
    child.stderr.on("data", (chunk) => (server.log += chunk));
    server.exited = new Promise((done) => child.on("exit", done));
    child.on("exit", (code) => reject(new Error(`server exited (${code}): ${server.log}`)));
    servers.push(server);
  });
}

describe("webhook route", () => {
  // Random high ports so a stray server from an earlier run can't collide.
  const [portA, portB] = [0, 1].map((i) => 40000 + Math.floor(Math.random() * 10000) * 2 + i);

  before(async () => {
    // Start one first so it creates the schema, then the second shares the file.
    await startServer(portA);
    await startServer(portB);
  });

  after(async () => {
    servers.forEach((s) => s.child.kill());
    await Promise.all(servers.map((s) => s.exited));
  });

  test("concurrent duplicate deliveries to two servers activate the customer once", async () => {
    const payload = JSON.stringify({
      id: "evt_concurrent",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { customer: "cus_concurrent", customer_details: { email: "a@example.test" } } },
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const deliver = (port) =>
      fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": header },
        body: payload,
      }).then((r) => r.json());

    const results = await Promise.all([deliver(portA), deliver(portB), deliver(portA), deliver(portB)]);

    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal(results.filter((r) => r.duplicate).length, 3);

    const activations = servers.map((s) => s.log.split("Subscription activated").length - 1);
    assert.equal(activations.reduce((a, b) => a + b, 0), 1);

    const customers = await fetch(`http://localhost:${portB}/api/customers`).then((r) => r.json());
    assert.deepEqual(customers, [
      { stripeCustomerId: "cus_concurrent", email: "a@example.test", subscriptionStatus: "active", plan: "price_test" },
    ]);
  });
});
