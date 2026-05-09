const {
  EVENT_TTL_MS,
  SPORT_CONFIG,
  fetchWithCache,
  getSport,
  handleOptions,
  json,
} = require("./_lib/backend");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  try {
    const sport = getSport(req);
    const cfg = SPORT_CONFIG[sport];
    const cacheKey = `events:${sport}`;
    const { data, remaining, source } = await fetchWithCache(
      cacheKey,
      EVENT_TTL_MS,
      () => `/sports/${cfg.apiKey}/events?dateFormat=iso`
    );
    return json(res, 200, data, {
      ...(remaining ? { "x-requests-remaining": remaining } : {}),
      "x-cache-source": source,
    });
  } catch (err) {
    return json(res, err.status || 500, { error: err.message || "Server error", details: err.data || undefined });
  }
};
