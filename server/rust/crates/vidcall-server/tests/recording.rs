//! Recording storage + SigV4 signing tests.
//!
//!  - [`DiskRecordingStorage`] end-to-end (chunks → finalize → read → delete),
//!  - SigV4 canonical-request structure + determinism (no AWS SDK anywhere),
//!  - [`S3RecordingStorage`] against a tiny in-process S3-compatible mock
//!    (PUT/HEAD/GET/DELETE over plain HTTP — no external service needed).

use axum::body::Body;
use axum::http::{Method, StatusCode};
use axum::routing::any;
use axum::Router;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use vidcall_server::aws_sigv4::{sign_v4, SignV4Options};
use vidcall_server::recording::{
    DiskRecordingStorage, FinalizeManifest, RecordingStorage, S3RecordingStorage,
    S3RecordingStorageConfig,
};

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

#[tokio::test]
async fn disk_storage_chunks_finalize_read_delete() {
    let dir = tempfile::tempdir().unwrap();
    let storage = DiskRecordingStorage::new(dir.path());
    let session = "rec-session-001";

    storage.save_chunk(session, b"chunk-zero", 0).await.unwrap();
    storage.save_chunk(session, b"chunk-one-", 1).await.unwrap();
    storage.save_chunk(session, b"chunk-two", 2).await.unwrap();

    let manifest: FinalizeManifest = storage.finalize(session).await.unwrap();
    assert_eq!(manifest.session_id, session);
    assert_eq!(manifest.chunks, 3);
    assert_eq!(manifest.bytes, 10 + 10 + 9);

    let all = storage.read_all(session).await.unwrap();
    assert_eq!(all, b"chunk-zerochunk-one-chunk-two");

    // manifest.json exists on disk and is the camelCase wire shape.
    let manifest_json: Value = serde_json::from_slice(
        &std::fs::read(dir.path().join(session).join("manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest_json["sessionId"], session);
    assert_eq!(manifest_json["chunks"], 3);
    assert_eq!(manifest_json["bytes"], 29);

    storage.delete(session).await.unwrap();
    assert!(storage.read_all(session).await.is_err());
}

#[tokio::test]
async fn disk_storage_rejects_unsafe_session_ids() {
    let dir = tempfile::tempdir().unwrap();
    let storage = DiskRecordingStorage::new(dir.path());
    for bad in ["..", ".", "", "../etc/passwd", "a/b"] {
        let err = storage.save_chunk(bad, b"x", 0).await.unwrap_err();
        assert_eq!(err.code, "invalid_request", "session {bad:?}");
    }
}

// ---------------------------------------------------------------------------
// SigV4 (port of packages/server/aws-sigv4.ts)
// ---------------------------------------------------------------------------

#[test]
fn sigv4_authorization_header_structure() {
    let signed = sign_v4(SignV4Options {
        method: "GET",
        url: "https://s3.us-east-1.amazonaws.com/my-bucket/path%20with%20spaces/obj?acl=public-read&x=1"
            .to_string(),
        headers: vec![],
        body: vec![],
        access_key_id: "AKIDEXAMPLE".to_string(),
        secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
        region: "us-east-1".to_string(),
        service: "s3".to_string(),
        amz_date: Some("20150830T123600Z".to_string()),
    });

    let auth = signed
        .headers
        .iter()
        .find(|(k, _)| k == "authorization")
        .expect("authorization header")
        .1
        .clone();
    assert!(auth.starts_with("AWS4-HMAC-SHA256 "), "auth: {auth}");
    assert!(auth.contains("Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request"));
    // Empty-body GET: the payload hash header is added for PUT/POST (and any
    // request with a body), mirroring packages/server/src/aws-sigv4.ts.
    assert!(
        auth.contains("SignedHeaders=host;x-amz-date"),
        "auth: {auth}"
    );
    let sig = auth.split("Signature=").nth(1).expect("signature present");
    assert_eq!(sig.len(), 64, "signature must be 64 hex chars");
    assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));

    // Determinism: same inputs → same signature.
    let again = sign_v4(SignV4Options {
        method: "GET",
        url: "https://s3.us-east-1.amazonaws.com/my-bucket/path%20with%20spaces/obj?acl=public-read&x=1"
            .to_string(),
        headers: vec![],
        body: vec![],
        access_key_id: "AKIDEXAMPLE".to_string(),
        secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
        region: "us-east-1".to_string(),
        service: "s3".to_string(),
        amz_date: Some("20150830T123600Z".to_string()),
    });
    let auth2 = again
        .headers
        .iter()
        .find(|(k, _)| k == "authorization")
        .unwrap()
        .1
        .clone();
    assert_eq!(auth, auth2);

    // A different body changes the signature (payload hash is signed).
    let other = sign_v4(SignV4Options {
        body: b"different".to_vec(),
        ..SignV4Options {
            method: "GET",
            url: "https://s3.us-east-1.amazonaws.com/my-bucket/path%20with%20spaces/obj?acl=public-read&x=1"
                .to_string(),
            headers: vec![],
            body: vec![],
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
            region: "us-east-1".to_string(),
            service: "s3".to_string(),
            amz_date: Some("20150830T123600Z".to_string()),
        }
    });
    let auth3 = other
        .headers
        .iter()
        .find(|(k, _)| k == "authorization")
        .unwrap()
        .1
        .clone();
    assert_ne!(auth, auth3, "payload must be signed");
}

#[test]
fn sigv4_put_payload_hash_header() {
    let signed = sign_v4(SignV4Options {
        method: "PUT",
        url: "https://my-bucket.s3.us-east-1.amazonaws.com/recordings/s1/chunk-000000".to_string(),
        headers: vec![("x-amz-acl".to_string(), "private".to_string())],
        body: b"hello".to_vec(),
        access_key_id: "AKID".to_string(),
        secret_access_key: "SECRET".to_string(),
        region: "us-east-1".to_string(),
        service: "s3".to_string(),
        amz_date: Some("20240101T000000Z".to_string()),
    });
    let headers: HashMap<&str, &str> = signed
        .headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert!(headers.contains_key("x-amz-content-sha256"));
    assert!(headers.contains_key("x-amz-date"));
    assert!(headers.contains_key("host"));
    // Extra headers are canonicalized + signed.
    assert!(headers["authorization"].contains("x-amz-acl"));
}

// ---------------------------------------------------------------------------
// S3 storage against an in-process mock (S3-compatible object server)
// ---------------------------------------------------------------------------

type ObjectStore = Arc<Mutex<HashMap<String, Vec<u8>>>>;

async fn spawn_mock_s3() -> (String, ObjectStore) {
    let objects: ObjectStore = Arc::new(Mutex::new(HashMap::new()));
    let objects2 = objects.clone();
    let app = Router::new().route(
        "/{*path}",
        any(
            move |method: Method,
                  axum::extract::Path(path): axum::extract::Path<String>,
                  body: axum::body::Bytes| {
                let objects = objects2.clone();
                async move {
                    let key = path.trim_start_matches('/').to_string();
                    let status = match method {
                        Method::PUT | Method::POST => {
                            objects.lock().unwrap().insert(key, body.to_vec());
                            StatusCode::OK
                        }
                        Method::GET | Method::HEAD => {
                            let found = objects.lock().unwrap().get(&key).cloned();
                            match found {
                                Some(bytes) => {
                                    // Real S3 HEAD returns Content-Length and an
                                    // empty body; the storage client reads the
                                    // length to compute the manifest bytes.
                                    let len = bytes.len().to_string();
                                    let mut resp = axum::response::Response::new(Body::from(bytes));
                                    resp.headers_mut().insert(
                                        axum::http::header::CONTENT_LENGTH,
                                        axum::http::HeaderValue::from_str(&len).unwrap(),
                                    );
                                    if method == Method::HEAD {
                                        *resp.body_mut() = Body::empty();
                                    }
                                    return resp;
                                }
                                None => StatusCode::NOT_FOUND,
                            }
                        }
                        Method::DELETE => {
                            objects.lock().unwrap().remove(&key);
                            StatusCode::NO_CONTENT
                        }
                        _ => StatusCode::METHOD_NOT_ALLOWED,
                    };
                    axum::response::Response::builder()
                        .status(status)
                        .body(Body::empty())
                        .unwrap()
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://127.0.0.1:{}", addr.port()), objects)
}

#[tokio::test]
async fn s3_storage_round_trip_against_mock() {
    let (endpoint, objects) = spawn_mock_s3().await;
    let cfg = S3RecordingStorageConfig {
        endpoint,
        bucket: "recordings".to_string(),
        region: "us-east-1".to_string(),
        access_key_id: "test-key".to_string(),
        secret_access_key: "test-secret".to_string(),
        prefix: Some("v1".to_string()),
        force_path_style: true, // MinIO-style path addressing (mock path matches)
        client: Some(reqwest::Client::new()),
    };
    let storage = S3RecordingStorage::new(cfg).unwrap();
    let session = "rec-s3-001";

    storage.save_chunk(session, b"part-a-", 0).await.unwrap();
    storage.save_chunk(session, b"part-b", 1).await.unwrap();
    let manifest = storage.finalize(session).await.unwrap();
    assert_eq!(manifest.chunks, 2);
    // "part-a-" (7) + "part-b" (6) = 13 bytes ("part-a-part-b").
    assert_eq!(manifest.bytes, 13);

    let all = storage.read_all(session).await.unwrap();
    assert_eq!(all, b"part-a-part-b");

    // Path-style addressing: the mock sees `bucket/prefix/...` keys.
    let keys: Vec<String> = objects.lock().unwrap().keys().cloned().collect();
    assert!(
        keys.iter()
            .any(|k| k == "recordings/v1/rec-s3-001/chunk-000000"),
        "keys: {keys:?}"
    );
    assert!(
        keys.iter()
            .any(|k| k == "recordings/v1/rec-s3-001/manifest.json"),
        "keys: {keys:?}"
    );

    storage.delete(session).await.unwrap();
    assert!(storage.read_all(session).await.is_err());
}
