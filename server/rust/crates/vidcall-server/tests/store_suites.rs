//! SHARED store test suite × every shipped [`Store`] implementation.
//!
//! The same `run_store_test_suite` matrix runs against each backend — the
//! server-side mirror of the client shared-adapter-suite pattern. PostgreSQL
//! runs only when `VIDCALL_TEST_POSTGRES_URL` is set (it needs a live server);
//! the rest run everywhere.

use std::sync::{Mutex, OnceLock};

use vidcall_server::shared_tests::{run_store_test_suite, StoreHarness};
use vidcall_server::store::Store;
use vidcall_server::stores::{InMemoryStore, PostgresStore, SqliteStore};

/// Keep temp dirs alive until the store holding a connection into them is
/// dropped (the suite hands the store to `destroy_store`).
static TEMP_DIRS: OnceLock<Mutex<Vec<tempfile::TempDir>>> = OnceLock::new();

fn keep_tempdir(dir: tempfile::TempDir) {
    TEMP_DIRS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap()
        .push(dir);
}

#[tokio::test]
async fn memory_passes_shared_suite() {
    run_store_test_suite(StoreHarness {
        name: "memory",
        create_store: Box::new(|| {
            Box::pin(async { Ok(Box::new(InMemoryStore::new()) as Box<dyn Store>) })
        }),
        destroy_store: None,
        room_prefix: Some("rust-shared".to_string()),
    })
    .await;
}

#[tokio::test]
async fn sqlite_passes_shared_suite() {
    run_store_test_suite(StoreHarness {
        name: "sqlite",
        create_store: Box::new(|| {
            Box::pin(async {
                let dir = tempfile::tempdir().expect("tempdir");
                let path = dir.path().join("vidcall.db");
                let store = SqliteStore::open(path.to_str().expect("utf8 path"))?;
                store.bootstrap().await?;
                keep_tempdir(dir);
                Ok(Box::new(store) as Box<dyn Store>)
            })
        }),
        destroy_store: None,
        room_prefix: Some("rust-shared".to_string()),
    })
    .await;
}

/// PostgreSQL suite — runs only with a live server:
/// `VIDCALL_TEST_POSTGRES_URL=postgres://user:pass@localhost/vidcall`
#[tokio::test]
async fn postgres_passes_shared_suite() {
    let Ok(url) = std::env::var("VIDCALL_TEST_POSTGRES_URL") else {
        eprintln!("skipping postgres suite: VIDCALL_TEST_POSTGRES_URL not set");
        return;
    };
    let url = url.trim().to_string();
    assert!(!url.is_empty(), "VIDCALL_TEST_POSTGRES_URL must not be empty");
    run_store_test_suite(StoreHarness {
        name: "postgres",
        create_store: Box::new(move || {
            let url = url.clone();
            Box::pin(async move {
                let store = PostgresStore::connect(&url).await?;
                store.bootstrap().await?;
                Ok(Box::new(store) as Box<dyn Store>)
            })
        }),
        destroy_store: None,
        room_prefix: Some("rust-shared".to_string()),
    })
    .await;
}

/// Smoke test that every store type can be constructed (all but postgres run
/// without any external service; postgres is skipped).
#[tokio::test]
async fn all_store_types_construct() {
    use vidcall_server::stores::{ConvexStore, HttpJsonStore, SupabaseStore};

    let _ = InMemoryStore::new();
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(dir.path().join("c.db").to_str().unwrap()).unwrap();
    store.bootstrap().await.unwrap();
    let _ = ConvexStore::new("https://example.convex.cloud").unwrap();
    let _ = SupabaseStore::new("https://example.supabase.co", "test-key").unwrap();
    let _ = HttpJsonStore::new(
        vidcall_server::stores::HttpJsonConfig::new("https://example.test/api"),
    )
    .unwrap();
}
