const { handleOptions, json } = require("./_lib/backend");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  return json(res, 200, {
    ok: true,
    status: "ok",
    timestamp: new Date().toISOString(),
    hasOddsKey: !!process.env.THE_ODDS_API_KEY,
    stripeConfigured: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
  });
};
