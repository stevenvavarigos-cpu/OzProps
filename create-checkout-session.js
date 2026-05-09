const { handleOptions, json, stripeCreateCheckoutSession } = require("../_lib/backend");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  try {
    const body = req.body || {};
    const out = await stripeCreateCheckoutSession(body.origin, body.customerEmail);
    return json(res, 200, out);
  } catch (err) {
    return json(res, 500, { error: err.message || "Server error" });
  }
};
