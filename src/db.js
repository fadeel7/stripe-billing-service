// A tiny in-memory "database" so the project runs with zero setup.
// In production this is where Postgres would live — the shape of the
// functions below is deliberately close to what a real repository layer
// would expose, so swapping in `pg` later is a small change, not a rewrite.

const customers = new Map(); // stripeCustomerId -> { email, subscriptionStatus, plan, currentPeriodEnd }
const processedEvents = new Set(); // webhook event ids we've already handled

export const db = {
  upsertCustomer(stripeCustomerId, data) {
    const existing = customers.get(stripeCustomerId) ?? {};
    customers.set(stripeCustomerId, { ...existing, ...data });
    return customers.get(stripeCustomerId);
  },

  getCustomer(stripeCustomerId) {
    return customers.get(stripeCustomerId) ?? null;
  },

  allCustomers() {
    return [...customers.entries()].map(([id, c]) => ({ stripeCustomerId: id, ...c }));
  },

  // Idempotency: Stripe can deliver the same webhook more than once.
  // We record every event id we've acted on and skip repeats, so a
  // retried "payment succeeded" never double-grants access.
  hasProcessed(eventId) {
    return processedEvents.has(eventId);
  },

  markProcessed(eventId) {
    processedEvents.add(eventId);
  },
};
