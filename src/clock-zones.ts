export const defaultCities = ["Asia/Shanghai", "Australia/Melbourne", "Asia/Kolkata"];
const handColors = ["#82cbd1", "#e5ad78", "#b3a0df"];

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch { return false; }
}

export function loadCities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== defaultCities.length || !value.every(isTimeZone)) return [...defaultCities];
  return [...value];
}

export function cityName(zone: string): string {
  return zone.split("/").pop()!.replace(/_/g, " ");
}

export function clockZones(cities: readonly string[]) {
  return cities.map((zone, index) => ({ zone, label: cityName(zone), color: handColors[index % handColors.length] }));
}

const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
export const cityOptions = [...new Set([
  ...defaultCities,
  ...(supportedValuesOf ? supportedValuesOf("timeZone") : ["UTC", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Asia/Singapore", "Asia/Dubai", "Pacific/Auckland"]),
])].sort((a, b) => cityName(a).localeCompare(cityName(b)));
