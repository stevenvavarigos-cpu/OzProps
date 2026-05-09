const {
  GAME_ODDS_TTL_MS,
  PROP_MARKETS,
  SPORT_CONFIG,
  fetchWithCache,
  getGameId,
  getSport,
  handleOptions,
  json,
} = require("./_lib/backend");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  try {
    const sport = getSport(req);
    const gameId = getGameId(req);
    const cfg = SPORT_CONFIG[sport];
    const marketCsv = (PROP_MARKETS[sport] || []).join(",");
    const cacheKey = `props:${sport}:${gameId}:${marketCsv}`;
    const { data, remaining, source } = await fetchWithCache(
      cacheKey,
      GAME_ODDS_TTL_MS,
      () =>
        `/sports/${cfg.apiKey}/events/${encodeURIComponent(gameId)}/odds?regions=${cfg.region}&markets=${encodeURIComponent(marketCsv)}&oddsFormat=decimal`
    );
    return json(res, 200, data, {
      ...(remaining ? { "x-requests-remaining": remaining } : {}),
      "x-cache-source": source,
    });
  } catch (err) {
    return json(res, err.status || 500, { error: err.message || "Server error", details: err.data || undefined });
  }
};
