// Live weather & air quality state, WMO mapping, AQI tiers, and local cache.

import { Bridge, IS_TAURI } from "./bridge";
import type { BotEmoteName, Wash } from "./layout";
import { N_ } from "../i18n/i18n";

export type WeatherUnit = "C" | "F";

export interface WeatherLocation {
  name: string;
  admin1?: string | null;
  admin2?: string | null;
  admin3?: string | null;
  country?: string | null;
  featureCode?: string | null;
  latitude: number;
  longitude: number;
}

export interface WeatherHourlyPoint {
  time: string;
  tempC: number;
  weatherCode: number;
  precipProb: number;
}

export interface WeatherDailyPoint {
  date: string;
  tempMaxC: number;
  tempMinC: number;
  weatherCode: number;
  sunrise?: string | null;
  sunset?: string | null;
}

export interface WeatherSnapshot {
  city: string;
  latitude: number;
  longitude: number;
  fetchedAt: number;
  tempC: number;
  feelsLikeC: number;
  humidity: number;
  windKmh: number;
  uvIndex: number;
  cloudCover?: number;
  precipitationMm?: number;
  isDay: boolean;
  weatherCode: number;
  usAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  hourly: WeatherHourlyPoint[];
  daily: WeatherDailyPoint[];
}

export type WeatherKind =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "storm";

export interface WeatherConditionInfo {
  kind: WeatherKind;
  label: string;
  wash: Wash;
  emote: BotEmoteName;
  emoji: string;
}

export type AqiTier =
  | "good"
  | "moderate"
  | "sensitive"
  | "unhealthy"
  | "very-unhealthy"
  | "hazardous";

export interface AqiBadgeInfo {
  tier: AqiTier;
  label: string;
  color: string;
}

const LOCATION_KEY = "aira.weather.location.v1";
const CACHE_KEY = "aira.weather.cache.v1";
const UNIT_KEY = "aira.weather.unit.v1";

/** Refresh automatically after 15 minutes. */
export const WEATHER_TTL_SEC = 900;

export const DEFAULT_WEATHER_LOCATION: WeatherLocation = {
  name: "Jakarta",
  admin1: "Jakarta",
  country: "Indonesia",
  latitude: -6.2088,
  longitude: 106.8456,
};

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadWeatherLocation(): WeatherLocation | null {
  const store = safeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(LOCATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WeatherLocation>;
    if (
      typeof parsed.name === "string" &&
      typeof parsed.latitude === "number" &&
      typeof parsed.longitude === "number" &&
      Number.isFinite(parsed.latitude) &&
      Number.isFinite(parsed.longitude)
    ) {
      return {
        name: parsed.name,
        admin1: typeof parsed.admin1 === "string" ? parsed.admin1 : null,
        country: typeof parsed.country === "string" ? parsed.country : null,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
      };
    }
  } catch {
    // Ignore malformed cache.
  }
  return null;
}

export function saveWeatherLocation(loc: WeatherLocation): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(LOCATION_KEY, JSON.stringify(loc));
  } catch {
    // Ignore quota errors.
  }
}

export function loadWeatherCache(): WeatherSnapshot | null {
  const store = safeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WeatherSnapshot>;
    if (
      typeof parsed.city === "string" &&
      typeof parsed.tempC === "number" &&
      typeof parsed.weatherCode === "number" &&
      typeof parsed.fetchedAt === "number"
    ) {
      return parsed as WeatherSnapshot;
    }
  } catch {
    // Ignore malformed cache.
  }
  return null;
}

export function saveWeatherCache(snap: WeatherSnapshot): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(CACHE_KEY, JSON.stringify(snap));
  } catch {
    // Ignore quota errors.
  }
}

export function loadWeatherUnit(): WeatherUnit {
  const store = safeStorage();
  if (!store) return "C";
  return store.getItem(UNIT_KEY) === "F" ? "F" : "C";
}

export function saveWeatherUnit(unit: WeatherUnit): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(UNIT_KEY, unit);
  } catch {
    // Ignore quota errors.
  }
}

export function isWeatherStale(snap: WeatherSnapshot | null, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!snap) return true;
  return nowSec - snap.fetchedAt >= WEATHER_TTL_SEC;
}

export function convertTemp(tempC: number, unit: WeatherUnit): number {
  return unit === "F" ? Math.round((tempC * 9) / 5 + 32) : Math.round(tempC);
}

export function formatTemp(tempC: number, unit: WeatherUnit): string {
  return `${convertTemp(tempC, unit)}°`;
}

export function wmoCondition(code: number, isDay = true): WeatherConditionInfo {
  if (code === 0) {
    return {
      kind: "clear",
      label: N_("Clear"),
      wash: isDay ? "amber" : "indigo",
      emote: isDay ? "happy" : "yawn",
      emoji: isDay ? "☀️" : "🌙",
    };
  }
  if (code === 1) {
    return {
      kind: "partly-cloudy",
      label: N_("Mostly clear"),
      wash: isDay ? "amber" : "indigo",
      emote: "happy",
      emoji: isDay ? "🌤️" : "🌙",
    };
  }
  if (code === 2) {
    return {
      kind: "partly-cloudy",
      label: N_("Partly cloudy"),
      wash: isDay ? "soft" : "indigo",
      emote: "happy",
      emoji: isDay ? "⛅" : "☁️",
    };
  }
  if (code === 3) {
    return {
      kind: "cloudy",
      label: N_("Overcast"),
      wash: "soft",
      emote: "yawn",
      emoji: "☁️",
    };
  }
  if (code === 45 || code === 48) {
    return {
      kind: "fog",
      label: N_("Foggy"),
      wash: "soft",
      emote: "yawn",
      emoji: "🌫️",
    };
  }
  if ((code >= 51 && code <= 57) || code === 80) {
    return {
      kind: "drizzle",
      label: N_("Drizzle"),
      wash: "cyan",
      emote: "yawn",
      emoji: "🌦️",
    };
  }
  if ((code >= 61 && code <= 67) || code === 81 || code === 82) {
    return {
      kind: "rain",
      label: N_("Rain"),
      wash: "cyan",
      emote: "surprised",
      emoji: "🌧️",
    };
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
    return {
      kind: "snow",
      label: N_("Snow"),
      wash: "cyan",
      emote: "surprised",
      emoji: "❄️",
    };
  }
  if (code >= 95) {
    return {
      kind: "storm",
      label: N_("Thunderstorm"),
      wash: "indigo",
      emote: "surprised",
      emoji: "⛈️",
    };
  }
  return {
    kind: "cloudy",
    label: N_("Cloudy"),
    wash: "soft",
    emote: "happy",
    emoji: "☁️",
  };
}

export function aqiInfo(aqi: number | null): AqiBadgeInfo | null {
  if (aqi == null || !Number.isFinite(aqi)) return null;
  if (aqi <= 50) return { tier: "good", label: N_("Good"), color: "#34D399" };
  if (aqi <= 100) return { tier: "moderate", label: N_("Moderate"), color: "#FACC15" };
  if (aqi <= 150) return { tier: "sensitive", label: N_("Sensitive"), color: "#FB923C" };
  if (aqi <= 200) return { tier: "unhealthy", label: N_("Unhealthy"), color: "#F4505E" };
  if (aqi <= 300) return { tier: "very-unhealthy", label: N_("Very unhealthy"), color: "#C084FC" };
  return { tier: "hazardous", label: N_("Hazardous"), color: "#EF4444" };
}

export function uvLevel(uv: number): string {
  if (uv < 3) return N_("Low");
  if (uv < 6) return N_("Moderate");
  if (uv < 8) return N_("High");
  return N_("Very high");
}

/** Determines whether an hourly ISO timestamp falls between sunrise and sunset. */
export function isHourDaytime(
  isoTime: string,
  sunrise?: string | null,
  sunset?: string | null,
  fallbackDay = true,
): boolean {
  const tIdx = isoTime.indexOf("T");
  if (tIdx < 0) return fallbackDay;
  const hhmm = isoTime.slice(tIdx + 1, tIdx + 6);
  const rise = sunrise && sunrise.includes("T") ? sunrise.slice(sunrise.indexOf("T") + 1, sunrise.indexOf("T") + 6) : "06:00";
  const set = sunset && sunset.includes("T") ? sunset.slice(sunset.indexOf("T") + 1, sunset.indexOf("T") + 6) : "18:00";
  return hhmm >= rise && hhmm < set;
}

/** Slices up to `limit` upcoming hourly points starting at the current local hour. */
export function upcomingHourly(
  hourly: WeatherHourlyPoint[],
  now = new Date(),
  limit = 10,
): WeatherHourlyPoint[] {
  if (hourly.length === 0) return [];
  const pad = (n: number) => String(n).padStart(2, "0");
  const currentPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}`;
  const idx = hourly.findIndex((p) => p.time >= currentPrefix);
  const start = idx >= 0 ? idx : 0;
  return hourly.slice(start, start + limit);
}

/** In-memory latest snapshot so compact island & header stay in sync without re-parsing. */
class WeatherStore {
  snapshot: WeatherSnapshot | null = loadWeatherCache();
  location: WeatherLocation | null = loadWeatherLocation();
  unit: WeatherUnit = loadWeatherUnit();
  loading = false;
  error: string | null = null;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  setUnit(unit: WeatherUnit) {
    this.unit = unit;
    saveWeatherUnit(unit);
    this.emit();
  }

  setLocation(loc: WeatherLocation) {
    this.location = loc;
    saveWeatherLocation(loc);
    this.emit();
  }

  async ensureLoaded(force = false): Promise<WeatherSnapshot | null> {
    if (!force && this.snapshot && this.snapshot.hourly.length >= 36 && !isWeatherStale(this.snapshot)) {
      return this.snapshot;
    }
    if (this.loading) return this.snapshot;
    this.loading = true;
    this.error = null;
    this.emit();
    try {
      let loc = this.location;
      if (!loc) {
        if (IS_TAURI) {
          loc = (await Bridge.detectWeatherLocation()) ?? DEFAULT_WEATHER_LOCATION;
        } else {
          loc = DEFAULT_WEATHER_LOCATION;
        }
        this.location = loc;
        saveWeatherLocation(loc);
      }

      const snap = IS_TAURI
        ? await Bridge.fetchWeather(loc.latitude, loc.longitude, loc.name)
        : await fetchWeatherBrowserFallback(loc.latitude, loc.longitude, loc.name);

      this.snapshot = snap;
      saveWeatherCache(snap);
      return snap;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return this.snapshot;
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  async selectLocation(loc: WeatherLocation): Promise<WeatherSnapshot | null> {
    this.setLocation(loc);
    return this.ensureLoaded(true);
  }

  async detectCurrentLocation(): Promise<WeatherLocation | null> {
    if (IS_TAURI) {
      return Bridge.detectWeatherLocation();
    }
    try {
      const res = await fetch("https://get.geojs.io/v1/ip/geo.json");
      if (!res.ok) return null;
      const g = (await res.json()) as { city?: string; country?: string; latitude?: string; longitude?: string };
      const lat = Number(g.latitude);
      const lon = Number(g.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !g.city) return null;
      return { name: g.city, admin1: null, country: g.country ?? null, latitude: lat, longitude: lon };
    } catch {
      return null;
    }
  }

  async searchCities(query: string): Promise<WeatherLocation[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    if (IS_TAURI) {
      return Bridge.searchWeatherCity(q);
    }
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<WeatherLocation & { feature_code?: string | null }>;
    };
    return (data.results ?? []).map((r) => ({
      name: r.name,
      admin1: r.admin1 ?? null,
      admin2: r.admin2 ?? null,
      admin3: r.admin3 ?? null,
      country: r.country ?? null,
      featureCode: r.featureCode ?? r.feature_code ?? null,
      latitude: r.latitude,
      longitude: r.longitude,
    }));
  }
}

const FEATURE_KIND_LABELS: Record<string, string> = {
  PPLC: "Capital",
  PPLA: "City",
  PPLA2: "City",
  ADM2: "Regency",
  ADM3: "District",
  ADM4: "Subdistrict",
};

function baseLocationSub(loc: WeatherLocation): string {
  const seen = new Set<string>([loc.name.trim().toLowerCase()]);
  const parts: string[] = [];
  for (const raw of [loc.admin3, loc.admin2, loc.admin1, loc.country]) {
    const val = raw?.trim();
    if (!val) continue;
    const key = val.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(val);
  }
  const typeTag = loc.featureCode ? FEATURE_KIND_LABELS[loc.featureCode] : undefined;
  const base = parts.join(", ");
  if (typeTag && (!loc.admin2 || loc.admin2.trim().toLowerCase() === loc.name.trim().toLowerCase())) {
    return base ? `${typeTag} · ${base}` : typeTag;
  }
  return base;
}

/**
 * Formats a concise, unambiguous region subtitle for city search results.
 * Includes district/regency (`admin3`/`admin2`) and falls back to coordinates
 * if another result in the list would otherwise display identically.
 */
export function formatWeatherLocationSub(
  loc: WeatherLocation,
  allResults?: WeatherLocation[],
): string {
  const sub = baseLocationSub(loc);
  if (!allResults || allResults.length < 2) return sub;
  const nameKey = loc.name.trim().toLowerCase();
  const collisions = allResults.filter(
    (other) => other.name.trim().toLowerCase() === nameKey && baseLocationSub(other) === sub,
  ).length;
  if (collisions > 1) {
    const coords = `${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)}`;
    return sub ? `${sub} (${coords})` : coords;
  }
  return sub;
}

async function fetchWeatherBrowserFallback(lat: number, lon: number, city: string): Promise<WeatherSnapshot> {
  const fUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,uv_index,cloud_cover,precipitation&hourly=temperature_2m,weather_code,precipitation_probability&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset&timezone=auto&forecast_days=3`;
  const aUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5,pm10&timezone=auto`;
  const [fRes, aRes] = await Promise.all([fetch(fUrl), fetch(aUrl).catch(() => null)]);
  if (!fRes.ok) throw new Error(`HTTP ${fRes.status}`);
  const f = await fRes.json();
  const a = aRes && aRes.ok ? await aRes.json() : null;
  const hourly: WeatherHourlyPoint[] = (f.hourly?.time ?? []).slice(0, 48).map((time: string, i: number) => ({
    time,
    tempC: f.hourly.temperature_2m[i],
    weatherCode: f.hourly.weather_code[i],
    precipProb: f.hourly.precipitation_probability?.[i] ?? 0,
  }));
  const daily: WeatherDailyPoint[] = (f.daily?.time ?? []).slice(0, 3).map((date: string, i: number) => ({
    date,
    tempMaxC: f.daily.temperature_2m_max[i],
    tempMinC: f.daily.temperature_2m_min[i],
    weatherCode: f.daily.weather_code[i],
    sunrise: f.daily.sunrise?.[i] ?? null,
    sunset: f.daily.sunset?.[i] ?? null,
  }));
  return {
    city,
    latitude: lat,
    longitude: lon,
    fetchedAt: Math.floor(Date.now() / 1000),
    tempC: f.current.temperature_2m,
    feelsLikeC: f.current.apparent_temperature,
    humidity: f.current.relative_humidity_2m,
    windKmh: f.current.wind_speed_10m,
    uvIndex: f.current.uv_index ?? 0,
    cloudCover: f.current.cloud_cover ?? 0,
    precipitationMm: f.current.precipitation ?? 0,
    isDay: f.current.is_day !== 0,
    weatherCode: f.current.weather_code,
    usAqi: a?.current?.us_aqi ?? null,
    pm25: a?.current?.pm2_5 ?? null,
    pm10: a?.current?.pm10 ?? null,
    hourly,
    daily,
  };
}

export const Weather = new WeatherStore();
