# Stripe Subscriptions

A full-stack subscription billing service built on **Stripe Checkout** and **webhooks**. A user subscribes to a plan, Stripe handles the hosted payment page, and webhooks keep the server's record of who's subscribed in sync with what actually happened at Stripe.

Built to get the hard part of billing right: **the server never trusts the browser about whether a payment succeeded.** Access is granted only when a signed webhook from Stripe confirms it.

## Why this is built the way it is

Most tutorials flip the user to "subscribed" as soon as the browser hits the success page. That's wrong — the browser can be closed, refreshed, or faked, and a redirect is not proof of payment. This service treats the Stripe webhook as the single source of truth:

- **Signature verification** — every webhook is checked against the signing secret before it's trusted. A request that doesn't carry a valid Stripe signature is rejected, not processed.
- **Raw body handling** — Stripe signs the exact bytes it sends, so the webhook route reads the raw request body while the rest of the app uses normal JSON parsing. Getting this ordering wrong is the most common reason webhook verification silently fails.
- **Idempotency** — Stripe may deliver the same event more than once. Every handled event id is recorded, so a retried "payment succeeded" never grants access twice.

## Stack

Node · Express · Stripe API · vanilla HTML/CSS frontend. No database required to run — state lives in an in-memory store with a repository-shaped interface, so swapping in PostgreSQL is a contained change.

## Flow

```
Browser                Server                 Stripe
   |  POST /create-checkout-session  |          |
   |-------------------------------->|          |
   |                                 |  create  |
   |                                 |--------->|
   |         { checkout url }        |          |
   |<--------------------------------|          |
   |  redirect to hosted Checkout ------------->|
   |                                 |          |
   |                                 |  webhook (signed)
   |                                 |<---------|
   |                                 | verify + update record
   |         success.html            |          |
   |<-------------------------------------------|
```

## Running locally

**1. Install dependencies**
```bash
npm install
```

**2. Set up Stripe (test mode)**
- Create a Stripe account and switch on **Test mode**.
- Create a recurring **Product** with a monthly price; copy its **Price ID**.
- Grab your **Secret key** from Developers → API keys.

**3. Configure environment**
```bash
cp .env.example .env
# fill in STRIPE_SECRET_KEY and STRIPE_PRICE_ID
```

**4. Forward webhooks to your local server** (install the [Stripe CLI](https://stripe.com/docs/stripe-cli) first)
```bash
stripe listen --forward-to localhost:4242/webhook
```
Copy the `whsec_...` signing secret it prints into `.env` as `STRIPE_WEBHOOK_SECRET`.

**5. Start the server**
```bash
npm run dev
```

Open `http://localhost:4242`, click **Subscribe**, and pay with Stripe's test card `4242 4242 4242 4242` (any future expiry, any CVC). Watch the server log the webhook events as the subscription activates.

## Endpoints

| Method | Route                       | Purpose                                              |
|--------|-----------------------------|------------------------------------------------------|
| POST   | `/create-checkout-session`  | Creates a Stripe Checkout session, returns its URL   |
| POST   | `/webhook`                  | Receives and verifies Stripe events, updates records |
| GET    | `/api/customers`            | Lists known subscribers and their status             |

## What I'd add next

- Persist to PostgreSQL behind the existing `db` interface.
- A customer portal link (`stripe.billingPortal.sessions.create`) so users can manage or cancel their own plan.
- Auth, so a subscription is tied to a logged-in user rather than a Stripe customer id alone.

---

MIT
