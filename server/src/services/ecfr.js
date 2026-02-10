const BASE_URL = "https://www.ecfr.gov";

export async function fetchAgencies() {
  const res = await fetch(`${BASE_URL}/api/admin/v1/agencies.json`);
  if (!res.ok) throw new Error(`Failed to fetch agencies: ${res.status}`);
  const data = await res.json();
  return data.agencies;
}

export async function fetchTitles() {
  const res = await fetch(`${BASE_URL}/api/versioner/v1/titles`);
  if (!res.ok) throw new Error(`Failed to fetch titles: ${res.status}`);
  const data = await res.json();
  return data.titles;
}

export async function fetchTitleStructure(titleNumber, date = "latest") {
  const res = await fetch(`${BASE_URL}/api/versioner/v1/structure/${date}/title-${titleNumber}.json`);
  if (!res.ok) throw new Error(`Failed to fetch structure for title ${titleNumber}: ${res.status}`);
  return res.json();
}

export async function fetchTitleXml(titleNumber, date) {
  if (!date) date = new Date().toISOString().split("T")[0];
  const res = await fetch(`${BASE_URL}/api/versioner/v1/full/${date}/title-${titleNumber}.xml`);
  if (!res.ok) throw new Error(`Failed to fetch XML for title ${titleNumber}: ${res.status}`);
  return res.text();
}
