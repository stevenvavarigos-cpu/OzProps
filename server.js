#!/usr/bin/env node

/**
 * OzProps lightweight backend proxy.
 *
 * Purpose:
 * - Keep THE_ODDS_API_KEY on the server
 * - Expose frontend-safe endpoints so users never enter API keys
 *
 * Run:
 *   THE_ODDS_API_KEY=your_key node ozprops-backend.js
 *
 * Optional:
 *   PORT=8787
 */

const PORT = Number(process.env.PORT || 8787);
const ODDS_API_KEY = process.env.THE_ODDS_API_KEY || "";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const APP_BASE_URL = process.env.APP_BASE_URL || "";
const EVENT_TTL_MS = Number(process.env.EVENT_TTL_MS || 60 * 60 * 1000);   // 1h
const GAME_ODDS_TTL_MS = Number(process.env.GAME_ODDS_TTL_MS || 5 * 60 * 1000); // 5m
const ESTIMATED_CREDITS_PER_GAME_CALL = Number(process.env.ESTIMATED_CREDITS_PER_GAME_CALL || 10);
const ESTIMATED_CREDITS_PER_EVENTS_CALL = Number(process.env.ESTIMATED_CREDITS_PER_EVENTS_CALL || 1);

const SPORT_CONFIG = {
  NRL: { apiKey: "rugbyleague_nrl", region: "au" },
  AFL: { apiKey: "aussierules_afl", region: "au" },
  NBA: { apiKey: "basketball_nba", region: "au" },
  Cricket: { apiKey: "cricket_big_bash", region: "au" },
};

const PROP_MARKETS = {
  NRL: [
    "player_anytime_try_scorer",
    "player_first_try_scorer",
    "player_anytime_try_scorer_alternate",
    "player_tackles_over_under",
    "player_tackles_alternate",
    "player_runs_over_under",
    "player_runs_alternate",
    "player_fantasy_points_over_under",
    "player_fantasy_points_alternate",
  ],
  AFL: [
    "player_goals",
    "player_goals_alternate",
    "player_disposals_over_under",
    "player_disposals_alternate",
    "player_marks_over_under",
    "player_marks_alternate",
    "player_tackles_over_under",
    "player_tackles_alternate",
    "player_fantasy_points_over_under",
    "player_fantasy_points_alternate",
  ],
  NBA: [
    "player_points",
    "player_points_alternate",
    "player_rebounds",
    "player_rebounds_alternate",
    "player_assists",
    "player_assists_alternate",
    "player_threes",
    "player_threes_alternate",
  ],
  Cricket: [
    "player_runs_over_under",
    "player_runs_alternate",
    "player_wickets_over_under",
  ],
};

const TEAM_MARKETS = {
  NRL: ["h2h", "totals", "team_totals", "spreads", "alternate_spreads", "alternate_totals"],
  AFL: ["h2h", "totals", "team_totals", "spreads", "alternate_spreads", "alternate_totals"],
  NBA: ["h2h", "totals", "team_totals", "spreads", "alternate_spreads", "alternate_totals"],
  Cricket: ["h2h", "totals", "spreads"],
};

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const SUBSCRIPTION_DB_PATH = path.join(__dirname, ".ozprops-subscriptions.json");

function loadSubscriptionDb() {
  try {
    const raw = fs.readFileSync(SUBSCRIPTION_DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      sessions: parsed.sessions || {},
      customers: parsed.customers || {},
      subscriptions: parsed.subscriptions || {},
      updatedAt: parsed.updatedAt || Date.now(),
    };
  } catch {
    return { sessions: {}, customers: {}, subscriptions: {}, updatedAt: Date.now() };
  }
}

function saveSubscriptionDb() {
  subscriptionDb.updatedAt = Date.now();
  fs.writeFileSync(SUBSCRIPTION_DB_PATH, JSON.stringify(subscriptionDb, null, 2), "utf8");
}

function sessionLooksPremium(session) {
  return session?.payment_status === "paid" || session?.status === "complete";
}

function setSubscriptionActive(subscriptionId, isActive) {
  if (!subscriptionId) return;
  subscriptionDb.subscriptions[subscriptionId] = !!isActive;
}

function setCustomerPremium(customerId, isPremium) {
  if (!customerId) return;
  subscriptionDb.customers[customerId] = !!isPremium;
}

function persistPremiumFromSession(session) {
  if (!session?.id) return;
  const premium = sessionLooksPremium(session);
  subscriptionDb.sessions[session.id] = {
    premium,
    payment_status: session.payment_status || null,
    status: session.status || null,
    customer: session.customer || null,
    subscription: session.subscription || null,
    updatedAt: Date.now(),
  };
  if (session.customer) setCustomerPremium(session.customer, premium);
  if (session.subscription) setSubscriptionActive(session.subscription, premium);
  saveSubscriptionDb();
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!secret) throw new Error("Missing STRIPE_WEBHOOK_SECRET env var on backend");
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header");

  const parts = signatureHeader.split(",").map(s => s.trim());
  const tPart = parts.find(p => p.startsWith("t="));
  const v1Parts = parts.filter(p => p.startsWith("v1="));
  if (!tPart || !v1Parts.length) throw new Error("Invalid Stripe-Signature format");

  const timestamp = Number(tPart.slice(2));
  if (!Number.isFinite(timestamp)) throw new Error("Invalid Stripe signature timestamp");
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSec > 300) throw new Error("Stripe signature too old");

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

  const ok = v1Parts.some(p => {
    const sig = p.slice(3);
    if (sig.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error("Stripe signature verification failed");
}

const subscriptionDb = loadSubscriptionDb();

function json(res, status, body, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value);
}

async function stripeRequest(path, formBody) {
  if (!STRIPE_SECRET_KEY) {
    throw new Error("Missing STRIPE_SECRET_KEY env var on backend");
  }
  const resp = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = payload?.error?.message || `Stripe HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.data = payload;
    throw err;
  }
  return payload;
}

const cache = new Map(); // key -> { data, remaining, expiresAt, fetchedAt }
const inFlight = new Map(); // key -> Promise<{ data, remaining }>
const metrics = {
  startMs: Date.now(),
  upstream: {
    total: 0,
    events: 0,
    gameOdds: 0,
    props: 0,
    teamProps: 0,
    byRoute: {},
  },
  served: {
    origin: 0,
    cache: 0,
    deduped: 0,
    stale: 0,
  },
};

function getCached(cacheKey) {
  const hit = cache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) return null;
  return hit;
}

function setCached(cacheKey, payload, ttlMs) {
  cache.set(cacheKey, {
    ...payload,
    fetchedAt: Date.now(),
    expiresAt: Date.now() + Math.max(1000, ttlMs),
  });
}

function markUpstream(routeName) {
  metrics.upstream.total += 1;
  metrics.upstream.byRoute[routeName] = (metrics.upstream.byRoute[routeName] || 0) + 1;
  if (routeName === "events") metrics.upstream.events += 1;
  if (routeName === "game-odds") metrics.upstream.gameOdds += 1;
  if (routeName === "props") metrics.upstream.props += 1;
  if (routeName === "team-props") metrics.upstream.teamProps += 1;
}

async function fetchWithCache(cacheKey, ttlMs, pathBuilder, routeName) {
  const fresh = getCached(cacheKey);
  if (fresh) {
    metrics.served.cache += 1;
    return { ...fresh, source: "cache" };
  }

  if (inFlight.has(cacheKey)) {
    const payload = await inFlight.get(cacheKey);
    metrics.served.deduped += 1;
    return { ...payload, source: "deduped" };
  }

  const task = (async () => {
    markUpstream(routeName);
    const payload = await oddsFetch(pathBuilder());
    setCached(cacheKey, payload, ttlMs);
    return payload;
  })();

  inFlight.set(cacheKey, task);
  try {
    const payload = await task;
    metrics.served.origin += 1;
    return { ...payload, source: "origin" };
  } catch (err) {
    // Serve stale cache on upstream failure if available.
    const stale = cache.get(cacheKey);
    if (stale) {
      metrics.served.stale += 1;
      return { ...stale, source: "stale" };
    }
    throw err;
  } finally {
    inFlight.delete(cacheKey);
  }
}

function getEstimator() {
  const uptimeMs = Math.max(1, Date.now() - metrics.startMs);
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  const scale = monthMs / uptimeMs;

  const projected = {
    upstreamCalls: Math.round(metrics.upstream.total * scale),
    eventsCalls: Math.round(metrics.upstream.events * scale),
    gameOddsCalls: Math.round(metrics.upstream.gameOdds * scale),
    propsCalls: Math.round(metrics.upstream.props * scale),
    teamPropsCalls: Math.round(metrics.upstream.teamProps * scale),
  };

  const estimatedMonthlyCredits =
    (projected.eventsCalls * ESTIMATED_CREDITS_PER_EVENTS_CALL) +
    ((projected.gameOddsCalls + projected.propsCalls + projected.teamPropsCalls) * ESTIMATED_CREDITS_PER_GAME_CALL);

  return {
    uptimeHours: Number((uptimeMs / (60 * 60 * 1000)).toFixed(2)),
    assumptions: {
      creditsPerGameLikeCall: ESTIMATED_CREDITS_PER_GAME_CALL,
      creditsPerEventsCall: ESTIMATED_CREDITS_PER_EVENTS_CALL,
      monthDays: 30,
    },
    observed: {
      upstream: metrics.upstream,
      served: metrics.served,
      cacheEntries: cache.size,
      inFlight: inFlight.size,
    },
    projectedMonthly: {
      ...projected,
      estimatedCredits: Math.round(estimatedMonthlyCredits),
    },
  };
}

async function oddsFetch(pathWithQuery) {
  if (!ODDS_API_KEY) {
    throw new Error("Missing THE_ODDS_API_KEY env var on backend");
  }
  const joiner = pathWithQuery.includes("?") ? "&" : "?";
  const url = `${ODDS_API_BASE}${pathWithQuery}${joiner}apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
  const resp = await fetch(url);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const message = data?.error || data?.message || `Odds API HTTP ${resp.status}`;
    const err = new Error(message);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  const remaining = resp.headers.get("x-requests-remaining");
  return { data, remaining };
}

function getSport(reqUrl) {
  const sport = reqUrl.searchParams.get("sport");
  if (!sport || !SPORT_CONFIG[sport]) throw new Error("Invalid sport param");
  return sport;
}

function getGameId(reqUrl) {
  const gameId = reqUrl.searchParams.get("gameId");
  if (!gameId) throw new Error("Missing gameId param");
  return gameId;
}

const http = require("http");

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return json(res, 204, {});
  }
  if (!["GET", "POST"].includes(req.method)) {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = reqUrl.pathname;

    if (pathname === "/health") {
      return json(res, 200, {
        ok: true,
        hasKey: !!ODDS_API_KEY,
        stripeConfigured: !!(STRIPE_SECRET_KEY && STRIPE_PRICE_ID),
        cacheEntries: cache.size,
        inFlight: inFlight.size,
        premiumStore: {
          sessions: Object.keys(subscriptionDb.sessions).length,
          customers: Object.keys(subscriptionDb.customers).length,
          subscriptions: Object.keys(subscriptionDb.subscriptions).length,
        },
        ttl: {
          eventsMs: EVENT_TTL_MS,
          gameOddsMs: GAME_ODDS_TTL_MS,
        },
      });
    }

    if (pathname === "/metrics/estimate") {
      return json(res, 200, getEstimator());
    }

    if (pathname === "/admin/cache/clear") {
      cache.clear();
      return json(res, 200, { ok: true, cleared: true });
    }

    if (pathname === "/api/stripe/create-checkout-session" && req.method === "POST") {
      if (!STRIPE_PRICE_ID) {
        return json(res, 500, { error: "Missing STRIPE_PRICE_ID env var on backend" });
      }
      const body = await readJsonBody(req);
      const safeBodyOrigin = isHttpUrl(body.origin) ? String(body.origin).replace(/\/+$/, "") : "";
      const baseUrl = safeBodyOrigin || (isHttpUrl(APP_BASE_URL) ? APP_BASE_URL.replace(/\/+$/, "") : "");

      if (!baseUrl) {
        return json(res, 400, {
          error: "Missing valid APP_BASE_URL for Stripe redirect URLs. Set APP_BASE_URL=https://your-site-domain"
        });
      }

      if (STRIPE_SECRET_KEY.startsWith("sk_live_") && !baseUrl.startsWith("https://")) {
        return json(res, 400, {
          error: "Live Stripe mode requires HTTPS APP_BASE_URL (e.g. https://your-site-domain)"
        });
      }

      const successUrl = body.successUrl && isHttpUrl(body.successUrl)
        ? body.successUrl
        : `${baseUrl}/?ozp_checkout=success&session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = body.cancelUrl && isHttpUrl(body.cancelUrl)
        ? body.cancelUrl
        : `${baseUrl}/?ozp_checkout=cancel`;

      const form = new URLSearchParams();
      form.set("mode", "subscription");
      form.set("line_items[0][price]", STRIPE_PRICE_ID);
      form.set("line_items[0][quantity]", "1");
      form.set("success_url", successUrl);
      form.set("cancel_url", cancelUrl);
      if (body.customerEmail) form.set("customer_email", String(body.customerEmail));
      form.set("metadata[product]", "ozprops-premium");

      const session = await stripeRequest("/checkout/sessions", form);
      return json(res, 200, { id: session.id, url: session.url });
    }

    if (pathname === "/api/stripe/webhook" && req.method === "POST") {
      const rawBody = await readRawBody(req);
      const sig = Array.isArray(req.headers["stripe-signature"])
        ? req.headers["stripe-signature"][0]
        : req.headers["stripe-signature"];
      verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
      const event = JSON.parse(rawBody);

      if (event.type === "checkout.session.completed") {
        persistPremiumFromSession(event.data?.object || {});
      }

      if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
        const sub = event.data?.object || {};
        const active = ["active", "trialing", "past_due"].includes(sub.status);
        setSubscriptionActive(sub.id, active);
        setCustomerPremium(sub.customer, active);
        saveSubscriptionDb();
      }

      if (event.type === "customer.subscription.deleted") {
        const sub = event.data?.object || {};
        setSubscriptionActive(sub.id, false);
        setCustomerPremium(sub.customer, false);
        saveSubscriptionDb();
      }

      return json(res, 200, { received: true });
    }

    if (pathname === "/api/stripe/verify-session") {
      const sessionId = reqUrl.searchParams.get("session_id");
      if (!sessionId) return json(res, 400, { error: "Missing session_id" });
      if (!STRIPE_SECRET_KEY) return json(res, 500, { error: "Missing STRIPE_SECRET_KEY env var on backend" });

      const resp = await fetch(`${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` },
      });
      const session = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = session?.error?.message || `Stripe HTTP ${resp.status}`;
        return json(res, resp.status, { error: msg, details: session });
      }

      const stored = subscriptionDb.sessions[session.id];
      const paid = sessionLooksPremium(session) ||
        !!stored?.premium ||
        !!subscriptionDb.customers[session.customer] ||
        !!subscriptionDb.subscriptions[session.subscription];
      if (paid) persistPremiumFromSession(session);
      return json(res, 200, {
        premiumActive: paid,
        sessionId: session.id,
        paymentStatus: session.payment_status,
        status: session.status,
      });
    }

    if (pathname === "/api/events") {
      const sport = getSport(reqUrl);
      const cfg = SPORT_CONFIG[sport];
      const cacheKey = `events:${sport}`;
      const { data, remaining, source } = await fetchWithCache(cacheKey, EVENT_TTL_MS, () =>
        `/sports/${cfg.apiKey}/events?dateFormat=iso`
      , "events");
      return json(
        res,
        200,
        data,
        {
          ...(remaining ? { "x-requests-remaining": remaining } : {}),
          "x-cache-source": source,
        }
      );
    }

    if (pathname === "/api/game-odds") {
      const sport = getSport(reqUrl);
      const gameId = getGameId(reqUrl);
      const cfg = SPORT_CONFIG[sport];
      const allMarkets = [...(PROP_MARKETS[sport] || []), ...(TEAM_MARKETS[sport] || [])].join(",");
      const cacheKey = `game-odds:${sport}:${gameId}:${allMarkets}`;
      const { data, remaining, source } = await fetchWithCache(cacheKey, GAME_ODDS_TTL_MS, () =>
        `/sports/${cfg.apiKey}/events/${encodeURIComponent(gameId)}/odds?regions=${cfg.region}&markets=${encodeURIComponent(allMarkets)}&oddsFormat=decimal`
      , "game-odds");
      return json(
        res,
        200,
        data,
        {
          ...(remaining ? { "x-requests-remaining": remaining } : {}),
          "x-cache-source": source,
        }
      );
    }

    // Optional compatibility fallbacks
    if (pathname === "/api/props" || pathname === "/api/team-props") {
      const sport = getSport(reqUrl);
      const gameId = getGameId(reqUrl);
      const cfg = SPORT_CONFIG[sport];
      const markets = pathname === "/api/props" ? PROP_MARKETS[sport] : TEAM_MARKETS[sport];
      const marketCsv = (markets || []).join(",");
      const cacheKey = `${pathname}:${sport}:${gameId}:${marketCsv}`;
      const { data, remaining, source } = await fetchWithCache(cacheKey, GAME_ODDS_TTL_MS, () =>
        `/sports/${cfg.apiKey}/events/${encodeURIComponent(gameId)}/odds?regions=${cfg.region}&markets=${encodeURIComponent(marketCsv)}&oddsFormat=decimal`
      , pathname === "/api/props" ? "props" : "team-props");
      return json(
        res,
        200,
        data,
        {
          ...(remaining ? { "x-requests-remaining": remaining } : {}),
          "x-cache-source": source,
        }
      );
    }

    return json(res, 404, { error: "Not found" });
  } catch (err) {
    const status = err.status || 500;
    return json(res, status, { error: err.message || "Server error", details: err.data || undefined });
  }
});

server.listen(PORT, () => {
  console.log(`OzProps backend running on http://localhost:${PORT}`);
  if (!ODDS_API_KEY) {
    console.log("WARNING: THE_ODDS_API_KEY is missing. Requests will fail until set.");
  }
  console.log(`Cache TTLs: events=${EVENT_TTL_MS}ms gameOdds=${GAME_ODDS_TTL_MS}ms`);
});

