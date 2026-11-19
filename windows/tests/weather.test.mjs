import assert from "node:assert/strict";
import test from "node:test";

import {
  aqiInfo,
  convertTemp,
  formatTemp,
  formatWeatherLocationSub,
  isHourDaytime,
  isWeatherStale,
  loadWeatherLocation,
  loadWeatherUnit,
  saveWeatherLocation,
  saveWeatherUnit,
  upcomingHourly,
  upcomingRainPeak,
  uvLevel,
  weatherAdvisory,
  wmoCondition,
} from "../src/core/weather.ts";

test("convertTemp and formatTemp handle C and F accurately", () => {
  assert.equal(convertTemp(0, "C"), 0);
  assert.equal(convertTemp(0, "F"), 32);
  assert.equal(convertTemp(30.4, "C"), 30);
  assert.equal(convertTemp(30, "F"), 86);
  assert.equal(formatTemp(25.6, "C"), "26°");
});

test("wmoCondition maps weather codes and day/night mood", () => {
  assert.deepEqual(wmoCondition(0, true), {
    kind: "clear",
    label: "Clear",
    wash: "amber",
    emote: "happy",
    emoji: "☀️",
  });
  assert.equal(wmoCondition(0, false).wash, "indigo");
  assert.equal(wmoCondition(0, false).emoji, "🌙");
  assert.equal(wmoCondition(63, true).kind, "rain");
  assert.equal(wmoCondition(95, true).kind, "storm");
  assert.equal(wmoCondition(73, true).kind, "snow");
});

test("aqiInfo classifies US AQI tiers", () => {
  assert.equal(aqiInfo(null), null);
  assert.equal(aqiInfo(28)?.tier, "good");
  assert.equal(aqiInfo(75)?.tier, "moderate");
  assert.equal(aqiInfo(125)?.tier, "sensitive");
  assert.equal(aqiInfo(180)?.tier, "unhealthy");
  assert.equal(aqiInfo(240)?.tier, "very-unhealthy");
  assert.equal(aqiInfo(350)?.tier, "hazardous");
});

test("uvLevel classifies UV index", () => {
  assert.equal(uvLevel(1.5), "Low");
  assert.equal(uvLevel(4.0), "Moderate");
  assert.equal(uvLevel(7.0), "High");
  assert.equal(uvLevel(10.0), "Very high");
});

test("isWeatherStale checks 15-minute TTL", () => {
  assert.equal(isWeatherStale(null, 1000), true);
  const snap = {
    city: "Jakarta",
    latitude: -6.2,
    longitude: 106.8,
    fetchedAt: 1000,
    tempC: 30,
    feelsLikeC: 33,
    humidity: 70,
    windKmh: 10,
    uvIndex: 5,
    isDay: true,
    weatherCode: 1,
    usAqi: 50,
    pm25: 12,
    pm10: 20,
    hourly: [],
    daily: [],
  };
  assert.equal(isWeatherStale(snap, 1500), false);
  assert.equal(isWeatherStale(snap, 1900), true);
});

test("upcomingHourly slices from the current local hour", () => {
  const hourly = [
    { time: "2026-11-18T16:00", tempC: 29, weatherCode: 2, precipProb: 10 },
    { time: "2026-11-18T17:00", tempC: 28, weatherCode: 2, precipProb: 20 },
    { time: "2026-11-18T18:00", tempC: 27, weatherCode: 3, precipProb: 40 },
    { time: "2026-11-18T19:00", tempC: 26, weatherCode: 61, precipProb: 70 },
  ];
  const now = new Date(2026, 10, 18, 18, 15); // 2026-11-18 18:15
  const sliced = upcomingHourly(hourly, now, 2);
  assert.equal(sliced.length, 2);
  assert.equal(sliced[0].time, "2026-11-18T18:00");
  assert.equal(sliced[1].time, "2026-11-18T19:00");
});

test("upcomingHourly crosses midnight seamlessly into the next day", () => {
  const hourly = [
    { time: "2026-11-18T22:00", tempC: 24, weatherCode: 3, precipProb: 41 },
    { time: "2026-11-18T23:00", tempC: 24, weatherCode: 3, precipProb: 37 },
    { time: "2026-11-19T00:00", tempC: 23, weatherCode: 2, precipProb: 20 },
    { time: "2026-11-19T01:00", tempC: 23, weatherCode: 2, precipProb: 15 },
  ];
  const now = new Date(2026, 10, 18, 22, 10);
  const sliced = upcomingHourly(hourly, now, 8);
  assert.equal(sliced.length, 4);
  assert.equal(sliced[0].time, "2026-11-18T22:00");
  assert.equal(sliced[2].time, "2026-11-19T00:00");
  assert.equal(sliced[3].time, "2026-11-19T01:00");
});

test("weather location and unit persist in localStorage", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  saveWeatherLocation({
    name: "Bandung",
    admin1: "West Java",
    country: "Indonesia",
    latitude: -6.9175,
    longitude: 107.6191,
  });
  const loc = loadWeatherLocation();
  assert.equal(loc?.name, "Bandung");
  assert.equal(loc?.latitude, -6.9175);

  saveWeatherUnit("F");
  assert.equal(loadWeatherUnit(), "F");
  saveWeatherUnit("C");
  assert.equal(loadWeatherUnit(), "C");

  delete globalThis.localStorage;
});

test("isHourDaytime checks whether hourly timestamp is between sunrise and sunset", () => {
  const rise = "2026-11-18T05:30";
  const set = "2026-11-18T17:45";
  assert.equal(isHourDaytime("2026-11-18T12:00", rise, set), true);
  assert.equal(isHourDaytime("2026-11-18T05:00", rise, set), false);
  assert.equal(isHourDaytime("2026-11-18T19:00", rise, set), false);
});

test("formatWeatherLocationSub disambiguates same-named regions with admin2/admin3 and coordinates", () => {
  const results = [
    {
      name: "Bandung",
      admin1: "West Java",
      admin2: "Kota Bandung",
      country: "Indonesia",
      featureCode: "PPLA",
      latitude: -6.9039,
      longitude: 107.6186,
    },
    {
      name: "Bandung",
      admin1: "East Java",
      admin2: "Tulungagung",
      country: "Indonesia",
      featureCode: "PPL",
      latitude: -8.17,
      longitude: 111.76,
    },
    {
      name: "Bandung",
      admin1: "East Java",
      admin2: "Jombang",
      admin3: "Diwek",
      country: "Indonesia",
      featureCode: "PPL",
      latitude: -7.58,
      longitude: 112.23,
    },
    {
      name: "Bandung",
      admin1: "West Java",
      admin2: "Bandung",
      country: "Indonesia",
      featureCode: "ADM2",
      latitude: -7.03,
      longitude: 107.57,
    },
  ];
  assert.equal(formatWeatherLocationSub(results[0], results), "Kota Bandung, West Java, Indonesia");
  assert.equal(formatWeatherLocationSub(results[1], results), "Tulungagung, East Java, Indonesia");
  assert.equal(formatWeatherLocationSub(results[2], results), "Diwek, Jombang, East Java, Indonesia");
  assert.equal(formatWeatherLocationSub(results[3], results), "Regency · West Java, Indonesia");

  const dupResults = [
    { name: "Bandung", admin1: "East Java", country: "Indonesia", latitude: -7.45, longitude: 112.41 },
    { name: "Bandung", admin1: "East Java", country: "Indonesia", latitude: -8.17, longitude: 111.76 },
  ];
  assert.equal(formatWeatherLocationSub(dupResults[0], dupResults), "East Java, Indonesia (-7.45, 112.41)");
  assert.equal(formatWeatherLocationSub(dupResults[1], dupResults), "East Java, Indonesia (-8.17, 111.76)");
});

test("upcomingRainPeak and weatherAdvisory detect rain, clearing, AQI, and UV alerts", () => {
  const now = new Date(2026, 10, 19, 10, 15);
  const baseSnap = {
    city: "Jakarta",
    latitude: -6.2,
    longitude: 106.8,
    fetchedAt: 1000,
    tempC: 30,
    feelsLikeC: 34,
    humidity: 72,
    windKmh: 12,
    uvIndex: 4,
    precipitationMm: 0,
    isDay: true,
    weatherCode: 2,
    usAqi: 45,
    pm25: 10,
    pm10: 18,
    hourly: [
      { time: "2026-11-19T10:00", tempC: 30, weatherCode: 2, precipProb: 15 },
      { time: "2026-11-19T11:00", tempC: 31, weatherCode: 3, precipProb: 65 },
      { time: "2026-11-19T12:00", tempC: 29, weatherCode: 61, precipProb: 80 },
    ],
    daily: [],
  };

  assert.deepEqual(upcomingRainPeak(baseSnap, now, 6), { hour: "12:00", precipProb: 80 });
  assert.deepEqual(weatherAdvisory(baseSnap, now), { kind: "rain-likely", hour: "11:00", prob: 65 });

  const rainingSnap = {
    ...baseSnap,
    weatherCode: 63,
    precipitationMm: 1.4,
    hourly: [
      { time: "2026-11-19T10:00", tempC: 27, weatherCode: 63, precipProb: 85 },
      { time: "2026-11-19T11:00", tempC: 27, weatherCode: 61, precipProb: 60 },
      { time: "2026-11-19T12:00", tempC: 28, weatherCode: 2, precipProb: 20 },
    ],
  };
  assert.deepEqual(weatherAdvisory(rainingSnap, now), { kind: "rain-clearing", hour: "12:00" });

  const aqiSnap = {
    ...baseSnap,
    usAqi: 135,
    hourly: [{ time: "2026-11-19T10:00", tempC: 30, weatherCode: 1, precipProb: 10 }],
  };
  assert.equal(upcomingRainPeak(aqiSnap, now, 6), null);
  assert.deepEqual(weatherAdvisory(aqiSnap, now), { kind: "aqi", value: 135 });

  const uvSnap = { ...aqiSnap, usAqi: 40, uvIndex: 9.2 };
  assert.deepEqual(weatherAdvisory(uvSnap, now), { kind: "uv", value: 9 });

  const calmSnap = { ...uvSnap, uvIndex: 3.1 };
  assert.equal(weatherAdvisory(calmSnap, now), null);
});
