// Live local weather & air quality via Open-Meteo (zero API key required).
// All external HTTP calls run in Rust with bounded reads (net::read_capped)
// so the webview's strict CSP stays untouched.

use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::net;

const WEATHER_TIMEOUT: Duration = Duration::from_secs(10);
const GEO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_WEATHER_BODY: usize = 512 * 1024;
const MAX_CITY_QUERY_LEN: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherLocation {
    pub name: String,
    pub admin1: Option<String>,
    #[serde(default)]
    pub admin2: Option<String>,
    #[serde(default)]
    pub admin3: Option<String>,
    pub country: Option<String>,
    #[serde(default)]
    pub feature_code: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherHourlyPoint {
    pub time: String,
    pub temp_c: f64,
    pub weather_code: i32,
    pub precip_prob: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherDailyPoint {
    pub date: String,
    pub temp_max_c: f64,
    pub temp_min_c: f64,
    pub weather_code: i32,
    pub sunrise: Option<String>,
    pub sunset: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherSnapshot {
    pub city: String,
    pub latitude: f64,
    pub longitude: f64,
    pub fetched_at: u64,
    pub temp_c: f64,
    pub feels_like_c: f64,
    pub humidity: i32,
    pub wind_kmh: f64,
    pub uv_index: f64,
    pub cloud_cover: i32,
    pub precipitation_mm: f64,
    pub is_day: bool,
    pub weather_code: i32,
    pub us_aqi: Option<i32>,
    pub pm25: Option<f64>,
    pub pm10: Option<f64>,
    pub hourly: Vec<WeatherHourlyPoint>,
    pub daily: Vec<WeatherDailyPoint>,
}

#[derive(Deserialize)]
struct ForecastResponse {
    current: ForecastCurrent,
    hourly: Option<ForecastHourly>,
    daily: Option<ForecastDaily>,
}

#[derive(Deserialize)]
struct ForecastCurrent {
    temperature_2m: f64,
    apparent_temperature: f64,
    relative_humidity_2m: i32,
    wind_speed_10m: f64,
    #[serde(default)]
    uv_index: f64,
    #[serde(default)]
    cloud_cover: i32,
    #[serde(default)]
    precipitation: f64,
    is_day: i32,
    weather_code: i32,
}

#[derive(Deserialize)]
struct ForecastHourly {
    time: Vec<String>,
    temperature_2m: Vec<f64>,
    weather_code: Vec<i32>,
    #[serde(default)]
    precipitation_probability: Vec<Option<i32>>,
}

#[derive(Deserialize)]
struct ForecastDaily {
    time: Vec<String>,
    temperature_2m_max: Vec<f64>,
    temperature_2m_min: Vec<f64>,
    weather_code: Vec<i32>,
    #[serde(default)]
    sunrise: Vec<String>,
    #[serde(default)]
    sunset: Vec<String>,
}

#[derive(Deserialize)]
struct AirQualityResponse {
    current: Option<AirQualityCurrent>,
}

#[derive(Deserialize)]
struct AirQualityCurrent {
    us_aqi: Option<i32>,
    pm2_5: Option<f64>,
    pm10: Option<f64>,
}

#[derive(Deserialize)]
struct GeocodingResponse {
    results: Option<Vec<GeocodingItem>>,
}

#[derive(Deserialize)]
struct GeocodingItem {
    name: String,
    admin1: Option<String>,
    admin2: Option<String>,
    admin3: Option<String>,
    country: Option<String>,
    feature_code: Option<String>,
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize)]
struct GeoIpResponse {
    city: Option<String>,
    country: Option<String>,
    latitude: Option<String>,
    longitude: Option<String>,
}

fn validate_coords(lat: f64, lon: f64) -> Result<(), String> {
    if !lat.is_finite() || !(-90.0..=90.0).contains(&lat) {
        return Err("Invalid latitude".to_string());
    }
    if !lon.is_finite() || !(-180.0..=180.0).contains(&lon) {
        return Err("Invalid longitude".to_string());
    }
    Ok(())
}

async fn get_json(url: Url, timeout: Duration) -> Result<Vec<u8>, String> {
    let client = net::client(&url, timeout)?;
    let resp = client
        .get(url)
        .header("User-Agent", concat!("Aira/", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = net::read_capped(resp, net::MAX_ERROR_BODY).await.unwrap_or_default();
        let detail = net::error_detail(&body);
        return Err(if detail.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {detail}")
        });
    }
    net::read_capped(resp, MAX_WEATHER_BODY).await
}

fn build_snapshot(
    city: String,
    lat: f64,
    lon: f64,
    forecast: ForecastResponse,
    air: Option<AirQualityResponse>,
) -> WeatherSnapshot {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hourly = Vec::new();
    if let Some(h) = forecast.hourly {
        let count = h.time.len().min(h.temperature_2m.len()).min(h.weather_code.len()).min(48);
        for i in 0..count {
            let prob = h.precipitation_probability.get(i).copied().flatten().unwrap_or(0);
            hourly.push(WeatherHourlyPoint {
                time: h.time[i].clone(),
                temp_c: h.temperature_2m[i],
                weather_code: h.weather_code[i],
                precip_prob: prob,
            });
        }
    }

    let mut daily = Vec::new();
    if let Some(d) = forecast.daily {
        let count = d
            .time
            .len()
            .min(d.temperature_2m_max.len())
            .min(d.temperature_2m_min.len())
            .min(d.weather_code.len())
            .min(3);
        for i in 0..count {
            daily.push(WeatherDailyPoint {
                date: d.time[i].clone(),
                temp_max_c: d.temperature_2m_max[i],
                temp_min_c: d.temperature_2m_min[i],
                weather_code: d.weather_code[i],
                sunrise: d.sunrise.get(i).cloned(),
                sunset: d.sunset.get(i).cloned(),
            });
        }
    }

    let air_cur = air.and_then(|a| a.current);

    WeatherSnapshot {
        city,
        latitude: lat,
        longitude: lon,
        fetched_at: now_unix,
        temp_c: forecast.current.temperature_2m,
        feels_like_c: forecast.current.apparent_temperature,
        humidity: forecast.current.relative_humidity_2m,
        wind_kmh: forecast.current.wind_speed_10m,
        uv_index: forecast.current.uv_index,
        cloud_cover: forecast.current.cloud_cover,
        precipitation_mm: forecast.current.precipitation,
        is_day: forecast.current.is_day != 0,
        weather_code: forecast.current.weather_code,
        us_aqi: air_cur.as_ref().and_then(|c| c.us_aqi),
        pm25: air_cur.as_ref().and_then(|c| c.pm2_5),
        pm10: air_cur.as_ref().and_then(|c| c.pm10),
        hourly,
        daily,
    }
}

#[tauri::command]
pub async fn fetch_weather(lat: f64, lon: f64, city: String) -> Result<WeatherSnapshot, String> {
    validate_coords(lat, lon)?;
    let city_clean = city.trim();
    let city_name = if city_clean.is_empty() {
        format!("{lat:.2}, {lon:.2}")
    } else {
        city_clean.chars().take(64).collect()
    };

    let lat_s = format!("{lat:.4}");
    let lon_s = format!("{lon:.4}");

    let forecast_url = Url::parse_with_params(
        "https://api.open-meteo.com/v1/forecast",
        &[
            ("latitude", lat_s.as_str()),
            ("longitude", lon_s.as_str()),
            (
                "current",
                "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,uv_index,cloud_cover,precipitation",
            ),
            ("hourly", "temperature_2m,weather_code,precipitation_probability"),
            ("daily", "temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset"),
            ("timezone", "auto"),
            ("forecast_days", "3"),
        ],
    )
    .map_err(|e| e.to_string())?;

    let air_url = Url::parse_with_params(
        "https://air-quality-api.open-meteo.com/v1/air-quality",
        &[
            ("latitude", lat_s.as_str()),
            ("longitude", lon_s.as_str()),
            ("current", "us_aqi,pm2_5,pm10"),
            ("timezone", "auto"),
        ],
    )
    .map_err(|e| e.to_string())?;

    let (forecast_res, air_res) = tokio::join!(
        get_json(forecast_url, WEATHER_TIMEOUT),
        get_json(air_url, WEATHER_TIMEOUT),
    );

    let forecast_bytes = forecast_res?;
    let forecast: ForecastResponse = serde_json::from_slice(&forecast_bytes)
        .map_err(|e| format!("Invalid weather data: {e}"))?;

    let air = air_res
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AirQualityResponse>(&bytes).ok());

    Ok(build_snapshot(city_name, lat, lon, forecast, air))
}

#[tauri::command]
pub async fn search_weather_city(query: String) -> Result<Vec<WeatherLocation>, String> {
    let q: String = query.trim().chars().take(MAX_CITY_QUERY_LEN).collect();
    if q.len() < 2 {
        return Ok(Vec::new());
    }

    let url = Url::parse_with_params(
        "https://geocoding-api.open-meteo.com/v1/search",
        &[
            ("name", q.as_str()),
            ("count", "5"),
            ("language", "en"),
            ("format", "json"),
        ],
    )
    .map_err(|e| e.to_string())?;

    let bytes = get_json(url, WEATHER_TIMEOUT).await?;
    let resp: GeocodingResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid geocoding data: {e}"))?;

    Ok(resp
        .results
        .unwrap_or_default()
        .into_iter()
        .map(|item| WeatherLocation {
            name: item.name,
            admin1: item.admin1,
            admin2: item.admin2,
            admin3: item.admin3,
            country: item.country,
            feature_code: item.feature_code,
            latitude: item.latitude,
            longitude: item.longitude,
        })
        .collect())
}

#[tauri::command]
pub async fn detect_weather_location() -> Option<WeatherLocation> {
    let url = Url::parse("https://get.geojs.io/v1/ip/geo.json").ok()?;
    let bytes = get_json(url, GEO_TIMEOUT).await.ok()?;
    let geo: GeoIpResponse = serde_json::from_slice(&bytes).ok()?;
    let lat: f64 = geo.latitude?.parse().ok()?;
    let lon: f64 = geo.longitude?.parse().ok()?;
    validate_coords(lat, lon).ok()?;
    let name = geo.city.filter(|c| !c.trim().is_empty())?;
    Some(WeatherLocation {
        name,
        admin1: None,
        admin2: None,
        admin3: None,
        country: geo.country,
        feature_code: None,
        latitude: lat,
        longitude: lon,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_coordinates() {
        assert!(validate_coords(95.0, 106.0).is_err());
        assert!(validate_coords(-91.0, 0.0).is_err());
        assert!(validate_coords(0.0, 181.0).is_err());
        assert!(validate_coords(f64::NAN, 106.0).is_err());
        assert!(validate_coords(-6.2088, 106.8456).is_ok());
    }

    #[test]
    fn builds_snapshot_from_sample_json() {
        let forecast_json = br#"{
            "current": {
                "temperature_2m": 30.4,
                "apparent_temperature": 34.1,
                "relative_humidity_2m": 72,
                "wind_speed_10m": 11.2,
                "uv_index": 6.5,
                "cloud_cover": 42,
                "precipitation": 0.0,
                "is_day": 1,
                "weather_code": 2
            },
            "hourly": {
                "time": ["2026-11-18T18:00", "2026-11-18T19:00"],
                "temperature_2m": [29.8, 28.4],
                "weather_code": [2, 3],
                "precipitation_probability": [20, 45]
            },
            "daily": {
                "time": ["2026-11-18"],
                "temperature_2m_max": [32.0],
                "temperature_2m_min": [24.5],
                "weather_code": [2],
                "sunrise": ["2026-11-18T05:25"],
                "sunset": ["2026-11-18T17:48"]
            }
        }"#;
        let air_json = br#"{"current":{"us_aqi":68,"pm2_5":20.1,"pm10":31.5}}"#;

        let f: ForecastResponse = serde_json::from_slice(forecast_json).unwrap();
        let a: AirQualityResponse = serde_json::from_slice(air_json).unwrap();
        let snap = build_snapshot("Jakarta".into(), -6.2088, 106.8456, f, Some(a));

        assert_eq!(snap.city, "Jakarta");
        assert_eq!(snap.temp_c, 30.4);
        assert!(snap.is_day);
        assert_eq!(snap.us_aqi, Some(68));
        assert_eq!(snap.hourly.len(), 2);
        assert_eq!(snap.hourly[1].precip_prob, 45);
        assert_eq!(snap.daily.len(), 1);
    }
}
