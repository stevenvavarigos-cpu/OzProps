const { handleOptions, json, stripeVerifySession } = require("../_lib/backend");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  try {
    const out = await stripeVerifySession(req.query.session_id);
    return json(res, 200, out);
  } catch (err) {
    return json(res, 500, { error: err.message || "Server error" });
  }
};
