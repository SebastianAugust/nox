//! Weather from Open-Meteo (no account, no key). Rust only fetches and
//! reshapes; caching and wording live in `src/lib/weather.ts`.

use serde::Serialize;
use serde_json::Value;

use crate::http::{self, ApiError};

const GEOCODE_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    name: String,
    /// Province / regency / country, for telling places with one name apart.
    admin1: Option<String>,
    admin2: Option<String>,
    admin3: Option<String>,
    country: Option<String>,
    latitude: f64,
    longitude: f64,
    timezone: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    temperature: f64,
    feels_like: f64,
    weather_code: i64,
    is_day: bool,
    temp_max: Option<f64>,
    temp_min: Option<f64>,
    /// Highest rain chance today, in percent.
    rain_chance_today: Option<i64>,
    /// Highest rain chance over the next six hours, in percent.
    rain_chance_soon: Option<i64>,
    /// Local "YYYY-MM-DDTHH:MM" at the place.
    sunrise: Option<String>,
    sunset: Option<String>,
    timezone: Option<String>,
}

async fn get_json(url: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
    let response = http::client().get(url).query(query).send().await?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(http::from_status(status));
    }
    Ok(response.json::<Value>().await?)
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// Places matching a name (the first word group before any comma).
#[tauri::command]
pub async fn weather_geocode(name: String) -> Result<Vec<Place>, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(ApiError::Invalid);
    }
    let data = get_json(
        GEOCODE_URL,
        &[
            ("name", name.to_string()),
            ("count", "10".into()),
            ("language", "en".into()),
            ("format", "json".into()),
        ],
    )
    .await?;
    let Some(results) = data["results"].as_array() else {
        return Ok(Vec::new()); // no match is an empty list, not an error
    };
    Ok(results
        .iter()
        .filter_map(|r| {
            Some(Place {
                name: r["name"].as_str()?.to_string(),
                admin1: opt_str(&r["admin1"]),
                admin2: opt_str(&r["admin2"]),
                admin3: opt_str(&r["admin3"]),
                country: opt_str(&r["country"]),
                latitude: r["latitude"].as_f64()?,
                longitude: r["longitude"].as_f64()?,
                timezone: opt_str(&r["timezone"]),
            })
        })
        .collect())
}

const IP_LOCATION_URL: &str = "https://ipapi.co/json/";

/// A rough location from the public IP. Only ever a suggestion.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approximate {
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    latitude: f64,
    longitude: f64,
}

/// Estimate the location from the public IP (one HTTPS call, no key). Runs
/// only on a button press, and only while `location_detect_enabled` is on,
/// since it sends the IP to ipapi.co. The IP itself is not passed on.
#[tauri::command]
pub async fn location_detect(app: tauri::AppHandle) -> Result<Approximate, ApiError> {
    if crate::db::read_setting_async(&app, "location_detect_enabled").await.as_deref() != Some("true") {
        return Err(ApiError::Invalid);
    }
    let data = get_json(IP_LOCATION_URL, &[]).await?;
    if data["error"].as_bool() == Some(true) {
        return Err(ApiError::BadResponse);
    }
    Ok(Approximate {
        city: opt_str(&data["city"]),
        region: opt_str(&data["region"]),
        country: opt_str(&data["country_name"]),
        latitude: data["latitude"].as_f64().ok_or(ApiError::BadResponse)?,
        longitude: data["longitude"].as_f64().ok_or(ApiError::BadResponse)?,
    })
}

/// Current conditions plus today's forecast for a place.
#[tauri::command]
pub async fn weather_fetch(latitude: f64, longitude: f64) -> Result<Weather, ApiError> {
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return Err(ApiError::Invalid);
    }
    let data = get_json(
        FORECAST_URL,
        &[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            (
                "current",
                "temperature_2m,apparent_temperature,weather_code,is_day".into(),
            ),
            ("hourly", "precipitation_probability".into()),
            (
                "daily",
                "temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"
                    .into(),
            ),
            ("timezone", "auto".into()),
            ("forecast_days", "2".into()),
        ],
    )
    .await?;

    let current = &data["current"];
    let daily = &data["daily"];
    let first = |v: &Value| v.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);

    // Next six hourly slots from the current hour on.
    let rain_chance_soon = (|| {
        let now = current["time"].as_str()?.get(..13)?; // "YYYY-MM-DDTHH"
        let times = data["hourly"]["time"].as_array()?;
        let probs = data["hourly"]["precipitation_probability"].as_array()?;
        let start = times.iter().position(|t| t.as_str().is_some_and(|t| t.starts_with(now)))?;
        probs[start..(start + 6).min(probs.len())]
            .iter()
            .filter_map(Value::as_i64)
            .max()
    })();

    Ok(Weather {
        temperature: current["temperature_2m"].as_f64().ok_or(ApiError::BadResponse)?,
        feels_like: current["apparent_temperature"].as_f64().ok_or(ApiError::BadResponse)?,
        weather_code: current["weather_code"].as_i64().unwrap_or(0),
        is_day: current["is_day"].as_i64() == Some(1),
        temp_max: first(&daily["temperature_2m_max"]).as_f64(),
        temp_min: first(&daily["temperature_2m_min"]).as_f64(),
        rain_chance_today: first(&daily["precipitation_probability_max"]).as_i64(),
        rain_chance_soon,
        sunrise: opt_str(&first(&daily["sunrise"])),
        sunset: opt_str(&first(&daily["sunset"])),
        timezone: opt_str(&data["timezone"]),
    })
}
