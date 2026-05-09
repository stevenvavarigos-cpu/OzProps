const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

const SPORT_CONFIG = {
  AFL: { apiKey: "aussierules_afl", region: "au" },
  NBA: { apiKey: "basketball_nba", region: "au" },
};

const PROP_MARKETS = {
  AFL: [
    "player_disposals",
    "player_disposals_over",
    "player_goals_scored_over",
    "player_marks_over",
    "player_tackles_over",
    "player_afl_fantasy_points",
    "player_afl_fantasy_points_over",
    "player_clearances_over",
    "player_kicks_over",
    "player_handballs_over",
    "player_goal_scorer_first",
    "player_goal_scorer_last",
    "player_goal_scorer_anytime",
    "player_marks_most",
    "player_tackles_most",
    "player_afl_fantasy_points_most",
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
    "player_blocks",
    "player_steals",
    "player_turnovers",
  ],
};

const TEAM_MARKETS = {
  AFL: ["h2h", "totals", "team_totals", "spreads", "alternate_spreads", "alternate_totals"],
  NBA: ["h2h", "totals", "team_totals", "spreads", "alternate_spreads", "alternate_totals"],
};

const cache = new Map();
const EVENT_TTL_MS = Number(process.env.EVENT_TTL_MS || 60 * 60 * 1000);
const GAME_ODDS_TTL_MS = Number(process.env.GAME_ODDS_TTL_MS || 5 * 60 * 1000);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleOptions(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

function json(res, status, body, headers = {}) {
  setCors(res);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json(body);
}

function getCached(cacheKey) {
  const hit = cache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) return null;
  return hit;
}

function setCached(cacheKey, payload, ttlMs) {
  cache.set(cacheKey, {
    ...payload,
    expiresAt: Date.now() + Math.max(1000, ttlMs),
  });
}

async function oddsFetch(pathWithQuery) {
  const key = process.env.THE_ODDS_API_KEY || "";
  if (!key) throw new Error("Missing THE_ODDS_API_KEY env var on backend");
  const joiner = pathWithQuery.includes("?") ? "&" : "?";
  const url = `${ODDS_API_BASE}${pathWithQuery}${joiner}apiKey=${encodeURIComponent(key)}`;
  const resp = await fetch(url);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const msg = data?.error || data?.message || `Odds API HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return { data, remaining: resp.headers.get("x-requests-remaining") };
}

async function fetchWithCache(cacheKey, ttlMs, buildPath) {
  const hit = getCached(cacheKey);
  if (hit) return { ...hit, source: "cache" };
  const payload = await oddsFetch(buildPath());
  setCached(cacheKey, payload, ttlMs);
  return { ...payload, source: "origin" };
}

function getSport(req) {
  const sport = req.query.sport;
  if (!sport || !SPORT_CONFIG[sport]) throw new Error("Invalid sport param");
  return sport;
}

function getGameId(req) {
  const gameId = req.query.gameId;
  if (!gameId) throw new Error("Missing gameId param");
  return gameId;
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value);
}

async function stripeCreateCheckoutSession(origin, customerEmail) {
  const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
  const stripePriceId = process.env.STRIPE_PRICE_ID || "";
  const appBaseUrl = process.env.APP_BASE_URL || "";
  if (!stripeSecret) throw new Error("Missing STRIPE_SECRET_KEY env var on backend");
  if (!stripePriceId) throw new Error("Missing STRIPE_PRICE_ID env var on backend");

  const safeOrigin = isHttpUrl(origin) ? String(origin).replace(/\/+$/, "") : "";
  const baseUrl = safeOrigin || (isHttpUrl(appBaseUrl) ? appBaseUrl.replace(/\/+$/, "") : "");
  if (!baseUrl) throw new Error("Missing valid APP_BASE_URL for Stripe redirect URLs");

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", stripePriceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${baseUrl}/?ozp_checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${baseUrl}/?ozp_checkout=cancel`);
  form.set("metadata[product]", "ozprops-premium");
  if (customerEmail) form.set("customer_email", String(customerEmail));

  const resp = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Stripe HTTP ${resp.status}`);
  }
  return { id: data.id, url: data.url };
}

async function stripeVerifySession(sessionId) {
  const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
  if (!stripeSecret) throw new Error("Missing STRIPE_SECRET_KEY env var on backend");
  if (!sessionId) throw new Error("Missing session_id");
  const resp = await fetch(`${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${stripeSecret}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Stripe HTTP ${resp.status}`);
  }
  const premiumActive = data?.payment_status === "paid" || data?.status === "complete";
  return {
    premiumActive,
    sessionId: data.id,
    paymentStatus: data.payment_status,
    status: data.status,
  };
}

module.exports = {
  EVENT_TTL_MS,
  GAME_ODDS_TTL_MS,
  PROP_MARKETS,
  SPORT_CONFIG,
  TEAM_MARKETS,
  fetchWithCache,
  getGameId,
  getSport,
  handleOptions,
  json,
  stripeCreateCheckoutSession,
  stripeVerifySession,
};
