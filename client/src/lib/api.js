const API_BASE = "/api";

async function request(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function post(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function buildQs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
}

export const api = {
  getStats: () => request("/stats"),
  getAgencies: () => request("/agencies"),
  getAgency: (slug) => request(`/agencies/${slug}`),
  getWordCounts: () => request("/wordcounts"),
  computeWordCounts: () => post("/wordcounts/compute"),
  getRegulationStructure: (titleNumber, params = {}) => {
    const qs = buildQs(params);
    return request(`/regulation/${titleNumber}/structure${qs ? "?" + qs : ""}`);
  },
  getRegulationContent: (titleNumber, params = {}) => {
    const qs = buildQs(params);
    return request(`/regulation/${titleNumber}/content${qs ? "?" + qs : ""}`);
  },
  getRegulationVersions: (titleNumber, params = {}) => {
    const qs = buildQs(params);
    return request(`/regulation/${titleNumber}/versions${qs ? "?" + qs : ""}`);
  },
  getRegulationDiff: (titleNumber, params = {}) => {
    const qs = buildQs(params);
    return request(`/regulation/${titleNumber}/diff${qs ? "?" + qs : ""}`);
  },
  getRegulationRevisionCounts: (titleNumber, params = {}) => {
    const qs = buildQs(params);
    return request(`/regulation/${titleNumber}/revision-counts${qs ? "?" + qs : ""}`);
  },
  getIngestStatus: () => request("/ingest/status"),
  triggerQuickIngest: () => post("/ingest/quick"),
  triggerFullIngest: () => post("/ingest/full"),
};
