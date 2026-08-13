//! Minimal AWS Signature Version 4 (SigV4) request signer — enough for S3
//! `PutObject` / `GetObject` / `DeleteObject` over reqwest, with **no AWS
//! SDK dependency**. Implements the algorithm from
//! <https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html>.
//!
//! Port of `packages/server/src/aws-sigv4.ts` (header-based auth only;
//! query strings are canonicalized but only used for object keys that may
//! contain query characters).

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

/// Signature options (mirrors the TS `SignV4Options`).
pub struct SignV4Options {
    /// HTTP method (uppercase), e.g. `"PUT"`.
    pub method: &'static str,
    /// Absolute URL (scheme://host/path?query).
    pub url: String,
    /// Canonical headers to sign. `host`, `x-amz-date` and
    /// `x-amz-content-sha256` are added automatically.
    pub headers: Vec<(String, String)>,
    /// Request body bytes (hashed into the signature).
    pub body: Vec<u8>,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
    pub service: String,
    /// ISO8601 `YYYYMMDDTHHMMSSZ`; defaults to now.
    pub amz_date: Option<String>,
}

/// Signed headers, including `Authorization`, `x-amz-date`, `host`.
pub struct SignedRequest {
    pub headers: Vec<(String, String)>,
    /// The `x-amz-date` used (useful for tests + retries).
    pub amz_date: String,
}

/// RFC 3986 encode (S3 wants `%20` for spaces, not `+`).
fn uri_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn canonical_query(url: &url::Url) -> String {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (uri_encode(&k), uri_encode(&v)))
        .collect();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn canonical_headers(headers: &[(String, String)]) -> (String, String) {
    let mut keys: Vec<String> = headers.iter().map(|(k, _)| k.to_lowercase()).collect();
    keys.sort();
    keys.dedup();
    let canonical = keys
        .iter()
        .map(|k| {
            let value = headers
                .iter()
                .find(|(hk, _)| hk.to_lowercase() == *k)
                .map(|(_, v)| v.trim().split_whitespace().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            format!("{k}:{value}")
        })
        .collect::<Vec<_>>()
        .join("
");
    let signed = keys.join(";");
    (canonical, signed)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex_lower(&Sha256::digest(data))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Sign a request; returns headers ready to attach to a reqwest call.
pub fn sign_v4(opts: SignV4Options) -> SignedRequest {
    let url = url::Url::parse(&opts.url).expect("valid URL");
    let amz_date = opts.amz_date.unwrap_or_else(|| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock");
        // Format as YYYYMMDDTHHMMSSZ (UTC).
        let secs = now.as_secs();
        let days = secs / 86400;
        let (y, m, d) = civil_from_days(days as i64);
        let rem = secs % 86400;
        let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
        format!("{y:04}{m:02}{d:02}T{h:02}{mi:02}{s:02}Z")
    });
    let date_stamp = &amz_date[..8];

    let host = url.host_str().unwrap_or("").to_string();
    let payload_hash = sha256_hex(&opts.body);
    let mut all_headers: Vec<(String, String)> = vec![
        ("host".to_string(), host),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    for (k, v) in &opts.headers {
        all_headers.push((k.to_lowercase(), v.clone()));
    }
    if opts.method == "PUT" || opts.method == "POST" || !opts.body.is_empty() {
        all_headers.push(("x-amz-content-sha256".to_string(), payload_hash.clone()));
    }

    let (canonical, signed) = canonical_headers(&all_headers);

    let canonical_request = [
        opts.method,
        &uri_encode(url.path()),
        &canonical_query(&url),
        &canonical,
        "",
        &signed,
        &payload_hash,
    ]
    .join("
");

    let scope = format!("{date_stamp}/{}/{}/aws4_request", opts.region, opts.service);
    let string_to_sign = [
        "AWS4-HMAC-SHA256",
        &amz_date,
        &scope,
        &sha256_hex(canonical_request.as_bytes()),
    ]
    .join("
");

    let k_date = hmac_sha256(format!("AWS4{}", opts.secret_access_key).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, opts.region.as_bytes());
    let k_service = hmac_sha256(&k_region, opts.service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex_lower(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    all_headers.push((
        "authorization".to_string(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            opts.access_key_id, scope, signed, signature
        ),
    ));

    SignedRequest {
        headers: all_headers,
        amz_date,
    }
}

/// Days-to-civil-date conversion (Howard Hinnant's algorithm), used for the
/// `x-amz-date` stamp. Returns (year, month, day).
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
