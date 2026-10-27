# Stripe Subscriptions

[![Node 18.11+](https://img.shields.io/badge/node-18.11%2B-3c873a?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![stripe-node 16](https://img.shields.io/badge/stripe--node-16-635bff?logo=stripe&logoColor=white)](https://github.com/stripe/stripe-node)
[![License: MIT](https://img.shields.io/badge/license-MIT-555)](package.json)
[![Status: Stripe test mode](https://img.shields.io/badge/status-Stripe%20test%20mode-c2410c)](#running-locally)

A subscription billing service built on Stripe Checkout and webhooks. Users pay on Stripe's hosted checkout page, and the server marks them as subscribed only when Stripe sends a signed webhook confirming the payment.

**Three ideas hold it together:**

1. **Never trust the browser.** Reaching `success.html` proves nothing, because a redirect can be skipped, refreshed or typed by hand. Access is granted only from the webhook.
2. **Verify every webhook signature.** Each event is checked against the signing secret before anything happens. The `/webhook` route reads the raw body, since Stripe signs the exact bytes. If a JSON parser runs first, verification fails silently.
3. **Process each event once.** Stripe may deliver the same event more than once. Each handled event id is recorded, and repeats are acknowledged and skipped.

| Subscribe | Success |
|---|---|
| ![Subscribe page](docs/screenshots/subscribe.png) | ![Success page](docs/screenshots/success.png) |

## The flow

```mermaid
sequenceDiagram
    autonumber
    actor U as Browser
    participant S as Server (Express)
    participant St as Stripe

    U->>S: POST /create-checkout-session
    S->>St: checkout.sessions.create (secret key)
    St-->>S: session.url
    S-->>U: { url }
    U->>St: Redirect to hosted Checkout
    U->>St: User pays (test card 4242…)

    St->>S: POST /webhook (Stripe-Signature header)
    S->>S: Verify signature on raw body
    alt Invalid signature
        S-->>St: 400, event ignored
    else Valid
        S->>S: Idempotency check (event.id seen?)
        alt Already processed
            S-->>St: 200 { duplicate: true }
        else New event
            S->>S: Grant access (subscriptionStatus = active)
            S-->>St: 200 { received: true }
        end
    end

    St-->>U: Redirect to /success.html?session_id=…
    Note over U,S: The redirect and the webhook are independent.<br/>The success page shows a message but changes nothing on the server.
```

## Trust boundary

```mermaid
flowchart LR
    B["Browser<br/>(untrusted)"]
    S["Server"]
    St["Stripe"]

    B -- "asks for a checkout URL<br/>(no say over who is subscribed)" --> S
    S -- "secret key" --> St
    St -- "signed webhook<br/>(only source of truth)" --> S
    St -. "redirect to success.html<br/>(display only)" .-> B
```

The server accepts exactly one kind of input that changes someone's subscription: a webhook with a valid Stripe signature. Nothing the browser sends can do that.

## Running locally

This needs a Stripe account in test mode. The server won't start without `STRIPE_SECRET_KEY`.

```bash
npm install
cp .env.example .env   # then fill in the values below
```

| Variable | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys (test mode) |
| `STRIPE_PRICE_ID` | A recurring product's price, created in the Dashboard |
| `STRIPE_WEBHOOK_SECRET` | Printed by `stripe listen` (starts with `whsec_`) |

Forward webhooks to the server with the [Stripe CLI](https://stripe.com/docs/stripe-cli), then start it:

```bash
stripe listen --forward-to localhost:4242/webhook
npm run dev
```

Open `http://localhost:4242`, click **Subscribe**, and pay with `4242 4242 4242 4242` (any future expiry, any CVC). The server logs each webhook as the subscription activates.

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/create-checkout-session` | Creates a Checkout session and returns its URL |
| POST | `/webhook` | Verifies and handles Stripe events |
| GET | `/api/customers` | Lists known subscribers and their status |

Handled events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Other event types are acknowledged and ignored.

## Stack and limits

Node, Express, the Stripe API, and plain HTML/CSS. State is kept in memory ([`src/db.js`](src/db.js)) behind an interface shaped like a database layer. A restart clears all subscribers **and** the list of processed event ids, so this is a demo, not production storage.

## What I'd add next

- PostgreSQL behind the existing `db` interface.
- A customer portal link (`stripe.billingPortal.sessions.create`) so users can manage or cancel their plan.
- Auth, so a subscription belongs to a logged-in user rather than only a Stripe customer id.

---

MIT
