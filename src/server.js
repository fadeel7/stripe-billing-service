import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import { db } from "./db.js";

dotenv.config();

const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, CLIENT_URL } = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error("Missing STRIPE_SECRET_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}

// This deployment is a test-mode demo; refuse to run against real money.
if (STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  console.error("STRIPE_SECRET_KEY is a live key. This service is meant to run in Stripe test mode only.");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 4242;
// Public base URL for Stripe's success/cancel redirects. Set CLIENT_URL explicitly;
// on Render, RENDER_EXTERNAL_URL (e.g. https://<service>.onrender.com) is the fallback.
const clientUrl = (CLIENT_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

/*
 * IMPORTANT: the webhook route must receive the RAW request body, because
 * Stripe signs the exact bytes it sent. If express.json() parses it first,
 * the signature check fails. So we mount express.raw() on the webhook route
 * ONLY, and express.json() on everything else. Order matters here.
 */

// --- Webhook: Stripe -> us. Verifies signature, reacts to events. ---
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // A failed signature check means the request didn't really come from
    // Stripe (or was tampered with). Reject it — never trust the payload.
    console.warn(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: claim the event id and apply its changes in one transaction.
  // The UNIQUE constraint on processed_events.event_id decides who wins, so a
  // duplicate delivery — even one racing this one — runs none of the code below.
  const isNew = db.processEventOnce(event.id, () => applyEvent(event));
  res.json(isNew ? { received: true } : { received: true, duplicate: true });
});

function applyEvent(event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      db.upsertCustomer(session.customer, {
        email: session.customer_details?.email,
        subscriptionStatus: "active",
        plan: STRIPE_PRICE_ID,
      });
      console.log(`✓ Subscription activated for customer ${session.customer}`);
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      db.upsertCustomer(sub.customer, {
        subscriptionStatus: sub.status, // active, past_due, canceled, etc.
        currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      });
      console.log(`✓ Subscription for ${sub.customer} is now ${sub.status}`);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      db.upsertCustomer(sub.customer, { subscriptionStatus: "canceled" });
      console.log(`✓ Subscription canceled for customer ${sub.customer}`);
      break;
    }

    default:
      // Unhandled event types are normal — Stripe sends many. Just ack them.
      break;
  }
}

// Every other route can use normal JSON parsing.
app.use(express.json());
app.use(express.static("public"));

// --- Create a Checkout Session: us -> Stripe -> redirect user to pay. ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${clientUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/cancel.html`,
    });
    // Return the hosted Checkout URL; the frontend redirects the browser to it.
    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session error:", err.message);
    res.status(500).json({ error: "Could not create checkout session." });
  }
});

// --- Read endpoint: list what we know about subscribers (for the demo). ---
app.get("/api/customers", (_req, res) => {
  res.json(db.allCustomers());
});

app.listen(PORT, () => {
  console.log(`Server running on ${clientUrl}`);
  console.log(`Webhook endpoint: POST ${clientUrl}/webhook`);
});
