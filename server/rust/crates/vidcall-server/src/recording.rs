//! Recording byte storage — mirror of `packages/server/src/recording.ts`.
//!
//! Recording *sessions* (metadata) live in the [`Store`]; the media *bytes*
//! (MediaRecorder `.webm` chunks, SFU egress segments, ...) live in a
//! [`RecordingStorage`]. Two implementations ship:
//!
//!  - [`DiskRecordingStorage`] — local directory, zero extra deps;
//!  - [`S3RecordingStorage`] — any S3-compatible object store (AWS S3,
//!    MinIO, R2, GCS XML API, ...) via a minimal SigV4 reqwest client
//!    ([`crate::aws_sigv4`]) — deliberately **no AWS SDK dependency**.
//!
//! Chunk model: a session is an ordered list of chunks (`index` 0..n-1).
//! `finalize` writes a manifest so `bytes` can reassemble the file.

use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::aws_sigv4::{sign_v4, SignV4Options};
use crate::error::{Result, VidcallError};

/// Result of [`RecordingStorage::finalize`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeManifest {
    pub session_id: String,
    pub chunks: u64,
    pub bytes: u64,
    pub finalized_at: i64,
}

/// Ordered byte storage for one recording session.
#[async_trait]
pub trait RecordingStorage: Send + Sync + 'static {
    /// Append one chunk (index is client-supplied, 0-based).
    async fn save_chunk(&self, session_id: &str, chunk: &[u8], index: u64) -> Result<()>;
    /// Seal the session; returns byte/chunk totals.
    async fn finalize(&self, session_id: &str) -> Result<FinalizeManifest>;
    /// Read the concatenated chunks in order (whole file).
    async fn read_all(&self, session_id: &str) -> Result<Vec<u8>>;
    /// Remove a session's bytes (optional cleanup tooling).
    async fn delete(&self, session_id: &str) -> Result<()>;
}

/// Keep session ids safe as filesystem segments / object keys.
///
/// Strict allowlist: ASCII alphanumerics plus `- . _`. Anything else (path
/// separators, whitespace, non-ASCII, `..`, empty) is rejected with
/// `invalid_request` — sanitizing silently would let two distinct ids
/// collide on the same path.
pub(crate) fn safe_segment(session_id: &str) -> Result<String> {
    if session_id.is_empty()
        || session_id == "."
        || session_id == ".."
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_')
    {
        return Err(VidcallError::invalid_request(format!(
            "Unsafe recording session id: {session_id}"
        )));
    }
    Ok(session_id.to_string())
}

fn chunk_path(dir: &Path, index: u64) -> PathBuf {
    dir.join(format!("chunk-{index:06}"))
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

/// Local-filesystem recording storage: `dir/<sessionId>/chunk-<index>` + manifest.
pub struct DiskRecordingStorage {
    dir: PathBuf,
}

impl DiskRecordingStorage {
    /// Root directory; one subdirectory per session.
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
        }
    }

    fn session_dir(&self, session_id: &str) -> Result<PathBuf> {
        Ok(self.dir.join(safe_segment(session_id)?))
    }
}

#[async_trait]
impl RecordingStorage for DiskRecordingStorage {
    async fn save_chunk(&self, session_id: &str, chunk: &[u8], index: u64) -> Result<()> {
        let dir = self.session_dir(session_id)?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| VidcallError::recording_storage_error(format!("mkdir failed: {e}")))?;
        tokio::fs::write(chunk_path(&dir, index), chunk)
            .await
            .map_err(|e| VidcallError::recording_storage_error(format!("write failed: {e}")))?;
        Ok(())
    }

    async fn finalize(&self, session_id: &str) -> Result<FinalizeManifest> {
        let dir = self.session_dir(session_id)?;
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => {
                return Err(VidcallError::recording_storage_error(format!(
                    "No chunks stored for recording {session_id}"
                )))
            }
        };
        let mut chunks = 0u64;
        let mut bytes = 0u64;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| VidcallError::recording_storage_error(format!("readdir failed: {e}")))?
        {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(idx) = name.strip_prefix("chunk-") {
                if let Ok(i) = idx.parse::<u64>() {
                    let meta = entry.metadata().await.map_err(|e| {
                        VidcallError::recording_storage_error(format!("stat failed: {e}"))
                    })?;
                    chunks = chunks.max(i + 1);
                    bytes += meta.len();
                }
            }
        }
        if chunks == 0 {
            return Err(VidcallError::recording_storage_error(format!(
                "No chunks stored for recording {session_id}"
            )));
        }
        let manifest = FinalizeManifest {
            session_id: session_id.to_string(),
            chunks,
            bytes,
            finalized_at: crate::protocol::now_ms(),
        };
        tokio::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|e| {
                VidcallError::recording_storage_error(format!("manifest encode failed: {e}"))
            })?,
        )
        .await
        .map_err(|e| {
            VidcallError::recording_storage_error(format!("manifest write failed: {e}"))
        })?;
        Ok(manifest)
    }

    async fn read_all(&self, session_id: &str) -> Result<Vec<u8>> {
        let dir = self.session_dir(session_id)?;
        let raw = tokio::fs::read(dir.join("manifest.json"))
            .await
            .map_err(|_| {
                VidcallError::recording_storage_error(format!(
                    "Recording {session_id} is not finalized"
                ))
            })?;
        let manifest: FinalizeManifest = serde_json::from_slice(&raw).map_err(|e| {
            VidcallError::recording_storage_error(format!("manifest decode failed: {e}"))
        })?;
        let mut out = Vec::with_capacity(manifest.bytes as usize);
        for i in 0..manifest.chunks {
            let path = chunk_path(&dir, i);
            let data = tokio::fs::read(&path).await.map_err(|_| {
                VidcallError::recording_storage_error(format!(
                    "Missing chunk {i} for recording {session_id}"
                ))
            })?;
            out.extend_from_slice(&data);
        }
        Ok(out)
    }

    async fn delete(&self, session_id: &str) -> Result<()> {
        let dir = self.session_dir(session_id)?;
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| VidcallError::recording_storage_error(format!("delete failed: {e}")))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// S3 (reqwest + SigV4, no AWS SDK)
// ---------------------------------------------------------------------------

/// S3-compatible object storage configuration.
#[derive(Debug, Clone)]
pub struct S3RecordingStorageConfig {
    /// e.g. `https://s3.us-east-1.amazonaws.com` or a MinIO/R2 endpoint.
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Optional object-key prefix, e.g. `recordings/`.
    pub prefix: Option<String>,
    /// Path-style URLs (`endpoint/bucket/key`) — required by MinIO; S3
    /// default is virtual-host style.
    pub force_path_style: bool,
    /// Optional custom reqwest client (tests).
    pub client: Option<reqwest::Client>,
}

impl S3RecordingStorageConfig {
    /// Build a config with defaults.
    pub fn new(
        endpoint: impl Into<String>,
        bucket: impl Into<String>,
        region: impl Into<String>,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            region: region.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            prefix: None,
            force_path_style: false,
            client: None,
        }
    }
}

/// S3-compatible object storage via a minimal SigV4 reqwest client.
pub struct S3RecordingStorage {
    cfg: S3RecordingStorageConfig,
    client: reqwest::Client,
}

impl S3RecordingStorage {
    /// Create a storage from a config.
    pub fn new(cfg: S3RecordingStorageConfig) -> Result<Self> {
        let client = cfg.client.clone().unwrap_or_else(|| {
            reqwest::Client::builder()
                .user_agent("vidcall-server/0.1 (S3RecordingStorage)")
                .build()
                .expect("reqwest client build")
        });
        Ok(Self { cfg, client })
    }

    /// Object key for a chunk / manifest.
    pub fn key_for(&self, session_id: &str, kind: &str, index: Option<u64>) -> Result<String> {
        let base = match (&self.cfg.prefix, safe_segment(session_id)?) {
            (Some(p), seg) => format!("{}/{}", p.trim_end_matches('/'), seg),
            (None, seg) => seg,
        };
        Ok(match kind {
            "manifest" => format!("{base}/manifest.json"),
            "chunk" => format!("{base}/chunk-{:06}", index.unwrap_or(0)),
            _ => unreachable!("kind must be chunk or manifest"),
        })
    }

    fn object_url(&self, key: &str) -> String {
        let endpoint = self.cfg.endpoint.trim_end_matches('/');
        if self.cfg.force_path_style {
            format!(
                "{endpoint}/{}/{}",
                self.cfg.bucket,
                key.split('/')
                    .map(uri_encode_key)
                    .collect::<Vec<_>>()
                    .join("/")
            )
        } else {
            format!(
                "{endpoint}/{}",
                key.split('/')
                    .map(uri_encode_key)
                    .collect::<Vec<_>>()
                    .join("/")
            )
        }
    }

    async fn signed_request(
        &self,
        method: &'static str,
        key: &str,
        body: Vec<u8>,
    ) -> Result<reqwest::RequestBuilder> {
        let url = self.object_url(key);
        let signed = sign_v4(SignV4Options {
            method,
            url: url.clone(),
            headers: vec![(
                "content-type".to_string(),
                "application/octet-stream".to_string(),
            )],
            body,
            access_key_id: self.cfg.access_key_id.clone(),
            secret_access_key: self.cfg.secret_access_key.clone(),
            region: self.cfg.region.clone(),
            service: "s3".to_string(),
            amz_date: None,
        });
        let mut req = self.client.request(
            reqwest::Method::from_bytes(method.as_bytes()).expect("valid method"),
            &url,
        );
        for (k, v) in &signed.headers {
            req = req.header(k, v);
        }
        Ok(req)
    }
}

fn uri_encode_key(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[async_trait]
impl RecordingStorage for S3RecordingStorage {
    async fn save_chunk(&self, session_id: &str, chunk: &[u8], index: u64) -> Result<()> {
        let key = self.key_for(session_id, "chunk", Some(index))?;
        let req = self
            .signed_request("PUT", &key, chunk.to_vec())
            .await?
            .body(chunk.to_vec());
        let resp = req
            .send()
            .await
            .map_err(|e| VidcallError::recording_storage_error(format!("s3 put failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(VidcallError::recording_storage_error(format!(
                "s3 put failed ({status}) for {key}: {text}"
            )));
        }
        Ok(())
    }

    async fn finalize(&self, session_id: &str) -> Result<FinalizeManifest> {
        // Discover chunk count by HEAD-requesting until we miss (bounded).
        let mut chunks = 0u64;
        let mut bytes = 0u64;
        for i in 0..10_000u64 {
            let key = self.key_for(session_id, "chunk", Some(i))?;
            let req = self.signed_request("HEAD", &key, Vec::new()).await?;
            let resp = req.send().await.map_err(|e| {
                VidcallError::recording_storage_error(format!("s3 head failed: {e}"))
            })?;
            if !resp.status().is_success() {
                break;
            }
            chunks += 1;
            bytes += resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
        }
        if chunks == 0 {
            return Err(VidcallError::recording_storage_error(format!(
                "No chunks stored for recording {session_id}"
            )));
        }
        let manifest = FinalizeManifest {
            session_id: session_id.to_string(),
            chunks,
            bytes,
            finalized_at: crate::protocol::now_ms(),
        };
        let key = self.key_for(session_id, "manifest", None)?;
        let body = serde_json::to_vec(&manifest).map_err(|e| {
            VidcallError::recording_storage_error(format!("manifest encode failed: {e}"))
        })?;
        let req = self
            .signed_request("PUT", &key, body.clone())
            .await?
            .body(body);
        let resp = req.send().await.map_err(|e| {
            VidcallError::recording_storage_error(format!("s3 manifest put failed: {e}"))
        })?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(VidcallError::recording_storage_error(format!(
                "s3 manifest put failed ({status}) for {key}: {text}"
            )));
        }
        Ok(manifest)
    }

    async fn read_all(&self, session_id: &str) -> Result<Vec<u8>> {
        let key = self.key_for(session_id, "manifest", None)?;
        let req = self.signed_request("GET", &key, Vec::new()).await?;
        let resp = req
            .send()
            .await
            .map_err(|e| VidcallError::recording_storage_error(format!("s3 get failed: {e}")))?;
        if !resp.status().is_success() {
            return Err(VidcallError::recording_storage_error(format!(
                "s3 manifest missing ({}) for {session_id}",
                resp.status().as_u16()
            )));
        }
        let manifest: FinalizeManifest = resp.json().await.map_err(|e| {
            VidcallError::recording_storage_error(format!("manifest decode failed: {e}"))
        })?;
        let mut out = Vec::with_capacity(manifest.bytes as usize);
        for i in 0..manifest.chunks {
            let chunk_key = self.key_for(session_id, "chunk", Some(i))?;
            let req = self.signed_request("GET", &chunk_key, Vec::new()).await?;
            let resp = req.send().await.map_err(|e| {
                VidcallError::recording_storage_error(format!("s3 get failed: {e}"))
            })?;
            if !resp.status().is_success() {
                return Err(VidcallError::recording_storage_error(format!(
                    "s3 chunk {i} missing ({}) for {session_id}",
                    resp.status().as_u16()
                )));
            }
            out.extend_from_slice(&resp.bytes().await.map_err(|e| {
                VidcallError::recording_storage_error(format!("s3 read failed: {e}"))
            })?);
        }
        Ok(out)
    }

    async fn delete(&self, session_id: &str) -> Result<()> {
        let manifest_key = self.key_for(session_id, "manifest", None)?;
        let req = self
            .signed_request("DELETE", &manifest_key, Vec::new())
            .await?;
        let _ = req.send().await;
        for i in 0..10_000u64 {
            let key = self.key_for(session_id, "chunk", Some(i))?;
            let head = self.signed_request("HEAD", &key, Vec::new()).await?;
            let resp = head.send().await.map_err(|e| {
                VidcallError::recording_storage_error(format!("s3 head failed: {e}"))
            })?;
            if !resp.status().is_success() {
                break;
            }
            let del = self.signed_request("DELETE", &key, Vec::new()).await?;
            let _ = del.send().await;
        }
        Ok(())
    }
}
