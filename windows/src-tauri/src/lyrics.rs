// Spotify synced lyrics lookup via LRCLIB (zero API key required).
// All HTTP requests run in Rust through `net::client` and `net::read_capped`
// with an in-memory LRU cache so track replays never hit the network twice.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::net;

const LYRICS_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_LYRICS_BODY: usize = 256 * 1024;
const CACHE_CAP: usize = 48;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsPayload {
    pub synced_lyrics: Option<String>,
    pub plain_lyrics: Option<String>,
    pub instrumental: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrcLibRecord {
    duration: Option<f64>,
    instrumental: Option<bool>,
    synced_lyrics: Option<String>,
    plain_lyrics: Option<String>,
}

impl LrcLibRecord {
    fn has_content(&self) -> bool {
        self.instrumental.unwrap_or(false)
            || self.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.plain_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty())
    }

    fn into_payload(self) -> LyricsPayload {
        LyricsPayload {
            synced_lyrics: self.synced_lyrics.filter(|s| !s.trim().is_empty()),
            plain_lyrics: self.plain_lyrics.filter(|s| !s.trim().is_empty()),
            instrumental: self.instrumental.unwrap_or(false),
        }
    }
}

fn cache() -> &'static Mutex<VecDeque<(String, Option<LyricsPayload>)>> {
    static CACHE: OnceLock<Mutex<VecDeque<(String, Option<LyricsPayload>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn cache_key(title: &str, artist: &str, album: &str) -> String {
    format!(
        "{}|{}|{}",
        title.trim().to_ascii_lowercase(),
        artist.trim().to_ascii_lowercase(),
        album.trim().to_ascii_lowercase()
    )
}

fn cache_get(key: &str) -> Option<Option<LyricsPayload>> {
    let guard = cache().lock().ok()?;
    guard.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

fn cache_put(key: String, val: Option<LyricsPayload>) {
    if let Ok(mut guard) = cache().lock() {
        if let Some(pos) = guard.iter().position(|(k, _)| k == &key) {
            guard.remove(pos);
        }
        guard.push_back((key, val));
        while guard.len() > CACHE_CAP {
            guard.pop_front();
        }
    }
}

fn build_get_url(title: &str, artist: &str, album: &str, duration: f64) -> Result<Url, String> {
    let mut params: Vec<(&str, String)> = vec![
        ("track_name", title.to_string()),
        ("artist_name", artist.to_string()),
    ];
    if !album.trim().is_empty() {
        params.push(("album_name", album.trim().to_string()));
    }
    if duration.is_finite() && duration > 0.0 {
        params.push(("duration", duration.round().to_string()));
    }
    Url::parse_with_params("https://lrclib.net/api/get", &params).map_err(|e| e.to_string())
}

fn build_search_url(title: &str, artist: &str) -> Result<Url, String> {
    let mut params = vec![("track_name", title)];
    if !artist.trim().is_empty() {
        params.push(("artist_name", artist.trim()));
    }
    Url::parse_with_params("https://lrclib.net/api/search", &params).map_err(|e| e.to_string())
}

fn pick_best_record(records: Vec<LrcLibRecord>, target_duration: f64) -> Option<LyricsPayload> {
    let mut best: Option<(bool, f64, LrcLibRecord)> = None;
    for rec in records {
        if !rec.has_content() {
            continue;
        }
        let has_synced = rec.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty());
        let diff = if target_duration > 0.0 {
            match rec.duration {
                Some(d) if d.is_finite() => (d - target_duration).abs(),
                _ => 30.0,
            }
        } else {
            0.0
        };
        if target_duration > 0.0 && diff > 10.0 && best.as_ref().is_some_and(|(_, bd, _)| *bd <= 10.0) {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((best_synced, best_diff, _)) => {
                (has_synced && !*best_synced) || (has_synced == *best_synced && diff < *best_diff)
            }
        };
        if replace {
            best = Some((has_synced, diff, rec));
        }
    }
    best.map(|(_, _, rec)| rec.into_payload())
}

async fn get_bytes(url: Url) -> Result<Option<Vec<u8>>, String> {
    let client = net::client(&url, LYRICS_TIMEOUT)?;
    let resp = client
        .get(url)
        .header("User-Agent", concat!("Aira/", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let bytes = net::read_capped(resp, MAX_LYRICS_BODY).await?;
    Ok(Some(bytes))
}

#[tauri::command]
pub async fn spotify_lyrics(
    title: String,
    artist: String,
    album: String,
    duration: f64,
) -> Result<Option<LyricsPayload>, String> {
    let t = title.trim();
    let a = artist.trim();
    if t.is_empty() {
        return Ok(None);
    }

    let key = cache_key(t, a, &album);
    if let Some(hit) = cache_get(&key) {
        return Ok(hit);
    }

    // Try exact LRCLIB `/api/get` first when both title and artist are present.
    if !a.is_empty() {
        let get_url = build_get_url(t, a, &album, duration)?;
        if let Ok(Some(bytes)) = get_bytes(get_url).await {
            if let Ok(rec) = serde_json::from_slice::<LrcLibRecord>(&bytes) {
                if rec.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty()) {
                    let payload = Some(rec.into_payload());
                    cache_put(key, payload.clone());
                    return Ok(payload);
                }
            }
        }
    }

    // Fallback to `/api/search` (handles slightly different album names or plain-only exact hit).
    let search_url = build_search_url(t, a)?;
    let payload = match get_bytes(search_url).await {
        Ok(Some(bytes)) => serde_json::from_slice::<Vec<LrcLibRecord>>(&bytes)
            .ok()
            .and_then(|list| pick_best_record(list, duration)),
        _ => None,
    };

    cache_put(key, payload.clone());
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_url_includes_optional_album_and_rounded_duration() {
        let url = build_get_url("Hype Boy", "NewJeans", "New Jeans", 179.6).unwrap();
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(pairs.contains(&("track_name".into(), "Hype Boy".into())));
        assert!(pairs.contains(&("artist_name".into(), "NewJeans".into())));
        assert!(pairs.contains(&("album_name".into(), "New Jeans".into())));
        assert!(pairs.contains(&("duration".into(), "180".into())));

        let minimal = build_get_url("Track", "Artist", "  ", -1.0).unwrap();
        let m_pairs: Vec<(String, String)> = minimal.query_pairs().into_owned().collect();
        assert!(!m_pairs.iter().any(|(k, _)| k == "album_name" || k == "duration"));
    }

    #[test]
    fn pick_best_prefers_synced_and_closest_duration() {
        let plain_exact = LrcLibRecord {
            duration: Some(200.0),
            instrumental: Some(false),
            synced_lyrics: None,
            plain_lyrics: Some("Hello plain".into()),
        };
        let synced_close = LrcLibRecord {
            duration: Some(201.0),
            instrumental: Some(false),
            synced_lyrics: Some("[00:05.00] Hello synced".into()),
            plain_lyrics: Some("Hello synced".into()),
        };
        let synced_far = LrcLibRecord {
            duration: Some(240.0),
            instrumental: Some(false),
            synced_lyrics: Some("[00:10.00] Wrong edit".into()),
            plain_lyrics: None,
        };
        let chosen = pick_best_record(vec![plain_exact, synced_far, synced_close], 200.0).unwrap();
        assert_eq!(chosen.synced_lyrics.as_deref(), Some("[00:05.00] Hello synced"));
    }
}
