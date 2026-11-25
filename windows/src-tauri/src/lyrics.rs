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
    track_name: Option<String>,
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

fn has_variant_mismatch(rec_title: Option<&str>, query_title: &str) -> bool {
    const VARIANTS: &[&str] = &[
        "remix", "live", "sped up", "slowed", "reverb",
        "acoustic", "cover", "karaoke", "nightcore", "8d",
    ];
    let Some(rt) = rec_title else { return false };
    let r_low = rt.to_ascii_lowercase();
    let q_low = query_title.to_ascii_lowercase();
    VARIANTS.iter().any(|v| r_low.contains(v) && !q_low.contains(v))
}

fn title_matches(rec_title: Option<&str>, query_title: &str) -> bool {
    let Some(rt) = rec_title else { return true };
    let r_low = rt.trim().to_ascii_lowercase();
    let q_low = query_title.trim().to_ascii_lowercase();
    r_low == q_low || r_low.starts_with(&q_low) || q_low.starts_with(&r_low)
}

fn pick_best_record(
    records: Vec<LrcLibRecord>,
    target_duration: f64,
    query_title: &str,
) -> Option<LyricsPayload> {
    // Score tuple: (has_synced, !variant_mismatch, title_matches, neg_diff)
    let mut best: Option<((bool, bool, bool, f64), LrcLibRecord)> = None;
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
        if target_duration > 0.0 && diff > 12.0 && best.as_ref().is_some_and(|((_, _, _, nd), _)| -*nd <= 12.0) {
            continue;
        }
        let clean_variant = !has_variant_mismatch(rec.track_name.as_deref(), query_title);
        let exact_title = title_matches(rec.track_name.as_deref(), query_title);
        let score = (has_synced, clean_variant, exact_title, -diff);
        let replace = match &best {
            None => true,
            Some((best_score, _)) => score > *best_score,
        };
        if replace {
            best = Some((score, rec));
        }
    }
    best.map(|(_, rec)| rec.into_payload())
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
            .and_then(|list| pick_best_record(list, duration, t)),
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
            track_name: Some("Hello".into()),
            duration: Some(200.0),
            instrumental: Some(false),
            synced_lyrics: None,
            plain_lyrics: Some("Hello plain".into()),
        };
        let synced_close = LrcLibRecord {
            track_name: Some("Hello".into()),
            duration: Some(201.0),
            instrumental: Some(false),
            synced_lyrics: Some("[00:05.00] Hello synced".into()),
            plain_lyrics: Some("Hello synced".into()),
        };
        let synced_far = LrcLibRecord {
            track_name: Some("Hello (Live)".into()),
            duration: Some(240.0),
            instrumental: Some(false),
            synced_lyrics: Some("[00:10.00] Wrong edit".into()),
            plain_lyrics: None,
        };
        let chosen = pick_best_record(vec![plain_exact, synced_far, synced_close], 200.0, "Hello").unwrap();
        assert_eq!(chosen.synced_lyrics.as_deref(), Some("[00:05.00] Hello synced"));
    }

    #[test]
    fn pick_best_avoids_remix_when_duration_is_unknown() {
        let remix = LrcLibRecord {
            track_name: Some("Midnight (Sped Up)".into()),
            duration: Some(150.0),
            instrumental: Some(false),
            synced_lyrics: Some("[00:02.00] Fast".into()),
            plain_lyrics: None,
        };
        let original = LrcLibRecord {
            track_name: Some("Midnight".into()),
            duration: Some(195.0),
            instrumental: Some(false),
            synced_lyrics: Some("[00:04.00] Normal".into()),
            plain_lyrics: None,
        };
        let chosen = pick_best_record(vec![remix, original], 0.0, "Midnight").unwrap();
        assert_eq!(chosen.synced_lyrics.as_deref(), Some("[00:04.00] Normal"));
    }
}
