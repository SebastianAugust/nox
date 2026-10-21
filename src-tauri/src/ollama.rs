//! Chat requests to the local Ollama server.
//!
//! These run in Rust rather than as a webview `fetch`, because a release
//! build's page origin is `http://tauri.localhost`, which Ollama's default CORS
//! allow-list rejects. The NDJSON response is streamed back line by line over
//! a Tauri `Channel`; the frontend keeps all parsing and error wording.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{async_runtime::JoinHandle, ipc::Channel, AppHandle, Manager, State};

const OLLAMA_CHAT_URL: &str = "http://localhost:11434/api/chat";

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OllamaEvent {
    /// One complete NDJSON line from Ollama.
    Line { text: String },
    /// Ollama answered with a non-2xx status.
    HttpError { status: u16, body: String },
    /// No connection (Ollama not running, wrong port, ...).
    Unreachable,
    /// The response ended.
    End,
}

/// Running requests by frontend request id, so the stop button can abort one.
#[derive(Default)]
pub struct OllamaRequests(Mutex<HashMap<u32, JoinHandle<()>>>);

impl OllamaRequests {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, JoinHandle<()>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[tauri::command]
pub async fn ollama_chat(
    app: AppHandle,
    requests: State<'_, OllamaRequests>,
    request_id: u32,
    body: serde_json::Value,
    on_event: Channel<OllamaEvent>,
) -> Result<(), String> {
    let task = tauri::async_runtime::spawn(async move {
        stream_chat(body, &on_event).await;
        app.state::<OllamaRequests>().lock().remove(&request_id);
    });
    requests.lock().insert(request_id, task);
    Ok(())
}

#[tauri::command]
pub fn ollama_cancel(requests: State<'_, OllamaRequests>, request_id: u32) {
    if let Some(task) = requests.lock().remove(&request_id) {
        task.abort();
    }
}

async fn stream_chat(body: serde_json::Value, events: &Channel<OllamaEvent>) {
    // A closed channel just means the window went away; nothing to report to.
    let send = |event: OllamaEvent| {
        let _ = events.send(event);
    };

    let response = match reqwest::Client::new()
        .post(OLLAMA_CHAT_URL)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return send(OllamaEvent::Unreachable),
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return send(OllamaEvent::HttpError { status: status.as_u16(), body });
    }

    // Split on newlines at the byte level, so a multi-byte character cut
    // between two network chunks is decoded only once it is whole.
    let mut response = response;
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                buffer.extend_from_slice(&bytes);
                for text in drain_lines(&mut buffer) {
                    send(OllamaEvent::Line { text });
                }
            }
            Ok(None) => break,
            Err(_) => return send(OllamaEvent::Unreachable),
        }
    }
    if !buffer.is_empty() {
        send(OllamaEvent::Line {
            text: String::from_utf8_lossy(&buffer).into_owned(),
        });
    }
    send(OllamaEvent::End);
}

/// Take every complete line out of `buffer`, leaving a trailing partial line.
fn drain_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buffer.drain(..=pos).collect();
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::drain_lines;

    #[test]
    fn splits_lines_across_chunks_without_breaking_utf8() {
        let mut buf = Vec::new();
        let whole = "{\"a\":\"é\"}\n{\"b\":1}\n{\"c\"".as_bytes();
        let cut = whole.iter().position(|&b| b == 0xC3).unwrap() + 1; // inside "é"
        buf.extend_from_slice(&whole[..cut]);
        assert!(drain_lines(&mut buf).is_empty());
        buf.extend_from_slice(&whole[cut..]);
        assert_eq!(drain_lines(&mut buf), vec!["{\"a\":\"é\"}\n", "{\"b\":1}\n"]);
        assert_eq!(buf, b"{\"c\"");
    }
}
