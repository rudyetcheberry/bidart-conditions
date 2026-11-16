// Relais METAR LFBZ pour l'application Bidart Conditions.
// AviationWeather ne permet pas les requêtes depuis un navigateur (pas de CORS) :
// ce Worker Cloudflare sert de relais et ajoute les en-têtes CORS nécessaires.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const target = "https://aviationweather.gov/api/data/metar?" + url.search;
    const res = await fetch(target, { headers: { "User-Agent": "ConditionsBidart/1.0" } });
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
