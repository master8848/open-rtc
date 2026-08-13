//! `vidcall-server` — the standalone vidcall backend sidecar binary.
//!
//! A tiny, language-agnostic HTTP/WS server that any app backend can attach
//! to (Express/Fastify via proxy, Django/Laravel/Rails via a
//! `location /vidcall/` reverse proxy — see `integrations/ATTACH.md`).
//!
//! ```
//! vidcall-server --addr 127.0.0.1:8787 --route-prefix /vidcall
//! vidcall-server --store sqlite --sqlite-path ./vidcall.db --recordings-dir ./recordings
//! vidcall-server --store postgres --database-url "postgres://user:pass@localhost/vidcall"
//! vidcall-server --store convex --convex-url "https://<deployment>.convex.cloud"
//! vidcall-server --store supabase --supabase-url "https://<ref>.supabase.co" --supabase-key "$SB_KEY"
//! ```
//!
//! Store selection: `--store memory|sqlite|postgres|convex|supabase|http-json`
//! (default `memory`). Configuration can also come from the environment
//! (`VIDCALL_STORE`, `VIDCALL_DATABASE_URL`, `VIDCALL_CONVEX_URL`,
//! `VIDCALL_SUPABASE_URL`, `VIDCALL_SUPABASE_KEY`, `VIDCALL_RECORDINGS_DIR`,
//! `VIDCALL_ADDR`, `VIDCALL_ROUTE_PREFIX`).

use std::process::ExitCode;
use std::sync::Arc;

use axum::Router;
use vidcall_server::http::{router_with_state, AppState};
use vidcall_server::recording::{DiskRecordingStorage, RecordingStorage};
use vidcall_server::store::Store;
use vidcall_server::stores::{
    ConvexStore, HttpJsonStore, InMemoryStore, PostgresStore, SqliteStore, SupabaseStore,
};
use vidcall_server::VidcallError;

const USAGE: &str = r#"vidcall-server — vidcall backend sidecar (rooms, signaling relay, recordings)

USAGE:
    vidcall-server [OPTIONS]

OPTIONS:
    --addr <HOST:PORT>        Listen address (default: 127.0.0.1:8787)
    --route-prefix <PREFIX>   Route prefix for REST + WS (default: /v1)
    --store <NAME>            memory | sqlite | postgres | convex | supabase | http-json
                              (default: memory; env VIDCALL_STORE)
    --sqlite-path <PATH>      SQLite database file (store=sqlite; default: vidcall.db)
    --database-url <URL>      Postgres connection string (store=postgres; env VIDCALL_DATABASE_URL)
    --convex-url <URL>        Convex deployment URL (store=convex; env VIDCALL_CONVEX_URL)
    --supabase-url <URL>      Supabase project URL (store=supabase; env VIDCALL_SUPABASE_URL)
    --supabase-key <KEY>      Supabase API key (store=supabase; env VIDCALL_SUPABASE_KEY)
    --http-json-url <URL>     Generic REST backend base URL (store=http-json; env VIDCALL_HTTP_JSON_URL)
    --recordings-dir <DIR>    Enable disk recording storage (env VIDCALL_RECORDINGS_DIR)
    --poll-interval-ms <N>    Change-feed polling interval for remote stores (default: 250)
    --auth-secret <KEY>       Enable HMAC token auth (env VIDCALL_AUTH_SECRET);
                              room routes require Authorization: Bearer <token>
                              (REST) or ?token=<token> (WS); POST /auth/token
                              issues room-scoped participant tokens
    --auth-admin-token <KEY>  Admin issuance secret for POST /auth/token (env
                              VIDCALL_AUTH_ADMIN_TOKEN); when set, issuance
                              requires an adminToken header and role=admin
                              always does
    -h, --help                Print this help and exit
    -V, --version             Print version and exit

ENVIRONMENT:
    VIDCALL_STORE, VIDCALL_ADDR, VIDCALL_ROUTE_PREFIX, VIDCALL_DATABASE_URL,
    VIDCALL_CONVEX_URL, VIDCALL_SUPABASE_URL, VIDCALL_SUPABASE_KEY,
    VIDCALL_HTTP_JSON_URL, VIDCALL_RECORDINGS_DIR, VIDCALL_AUTH_SECRET,
    VIDCALL_AUTH_ADMIN_TOKEN

EXAMPLES:
    vidcall-server --addr 127.0.0.1:8787                    # in-memory, /v1/*
    vidcall-server --route-prefix /vidcall                  # /vidcall/rooms etc.
    vidcall-server --store sqlite --sqlite-path ./v.db
    vidcall-server --store postgres --database-url "postgres://u:p@localhost/vidcall"
"#;

struct Cli {
    addr: String,
    route_prefix: String,
    store: String,
    sqlite_path: String,
    database_url: Option<String>,
    convex_url: Option<String>,
    supabase_url: Option<String>,
    supabase_key: Option<String>,
    http_json_url: Option<String>,
    recordings_dir: Option<String>,
    poll_interval_ms: u64,
    auth_secret: Option<String>,
    auth_admin_token: Option<String>,
    help: bool,
    version: bool,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn parse_args() -> Result<Cli, String> {
    let mut cli = Cli {
        addr: env_or("VIDCALL_ADDR", "127.0.0.1:8787"),
        route_prefix: env_or("VIDCALL_ROUTE_PREFIX", "/v1"),
        store: env_or("VIDCALL_STORE", "memory"),
        sqlite_path: "vidcall.db".to_string(),
        database_url: std::env::var("VIDCALL_DATABASE_URL").ok(),
        convex_url: std::env::var("VIDCALL_CONVEX_URL").ok(),
        supabase_url: std::env::var("VIDCALL_SUPABASE_URL").ok(),
        supabase_key: std::env::var("VIDCALL_SUPABASE_KEY").ok(),
        http_json_url: std::env::var("VIDCALL_HTTP_JSON_URL").ok(),
        recordings_dir: std::env::var("VIDCALL_RECORDINGS_DIR").ok(),
        poll_interval_ms: 250,
        auth_secret: std::env::var("VIDCALL_AUTH_SECRET")
            .ok()
            .filter(|s| !s.is_empty()),
        auth_admin_token: std::env::var("VIDCALL_AUTH_ADMIN_TOKEN")
            .ok()
            .filter(|s| !s.is_empty()),
        help: false,
        version: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => cli.help = true,
            "-V" | "--version" => cli.version = true,
            "--addr" => cli.addr = args.next().ok_or("--addr needs a value")?,
            "--route-prefix" => {
                cli.route_prefix = args.next().ok_or("--route-prefix needs a value")?
            }
            "--store" => cli.store = args.next().ok_or("--store needs a value")?,
            "--sqlite-path" => {
                cli.sqlite_path = args.next().ok_or("--sqlite-path needs a value")?
            }
            "--database-url" => {
                cli.database_url = Some(args.next().ok_or("--database-url needs a value")?)
            }
            "--convex-url" => {
                cli.convex_url = Some(args.next().ok_or("--convex-url needs a value")?)
            }
            "--supabase-url" => {
                cli.supabase_url = Some(args.next().ok_or("--supabase-url needs a value")?)
            }
            "--supabase-key" => {
                cli.supabase_key = Some(args.next().ok_or("--supabase-key needs a value")?)
            }
            "--http-json-url" => {
                cli.http_json_url = Some(args.next().ok_or("--http-json-url needs a value")?)
            }
            "--recordings-dir" => {
                cli.recordings_dir = Some(args.next().ok_or("--recordings-dir needs a value")?)
            }
            "--poll-interval-ms" => {
                cli.poll_interval_ms = args
                    .next()
                    .ok_or("--poll-interval-ms needs a value")?
                    .parse()
                    .map_err(|_| "invalid --poll-interval-ms".to_string())?
            }
            "--auth-secret" => {
                cli.auth_secret = Some(args.next().ok_or("--auth-secret needs a value")?)
            }
            "--auth-admin-token" => {
                cli.auth_admin_token = Some(args.next().ok_or("--auth-admin-token needs a value")?)
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(cli)
}

fn main() -> ExitCode {
    match parse_args() {
        Err(message) => {
            eprintln!("vidcall-server: {message}");
            eprintln!();
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
        Ok(cli) => match (cli.help, cli.version) {
            (true, _) => {
                println!("{USAGE}");
                ExitCode::SUCCESS
            }
            (_, true) => {
                println!("vidcall-server {}", env!("CARGO_PKG_VERSION"));
                ExitCode::SUCCESS
            }
            _ => match run(cli) {
                Ok(()) => ExitCode::SUCCESS,
                Err(message) => {
                    eprintln!("vidcall-server: {message}");
                    ExitCode::FAILURE
                }
            },
        },
    }
}

#[tokio::main]
async fn run(cli: Cli) -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let store: Arc<dyn Store> = build_store(&cli).await?;
    let recording_storage: Option<Arc<dyn RecordingStorage>> = match &cli.recordings_dir {
        Some(dir) => Some(Arc::new(DiskRecordingStorage::new(dir))),
        None => None,
    };

    let auth = cli
        .auth_secret
        .as_ref()
        .map(|secret| vidcall_server::http::AuthConfig {
            secret: secret.clone(),
            admin_token: cli.auth_admin_token.clone(),
            default_token_ttl_ms: None,
        });
    let state = AppState {
        store,
        recording_storage,
        hub: Arc::new(vidcall_server::ws::RoomHub::new()),
        auth,
    };
    let app: Router = router_with_state(&cli.route_prefix, state);

    let listener = tokio::net::TcpListener::bind(&cli.addr)
        .await
        .map_err(|e| format!("cannot bind {addr}: {e}", addr = cli.addr))?;
    let local = listener
        .local_addr()
        .map_err(|e| format!("cannot read local addr: {e}"))?;
    tracing::info!(
        addr = %local,
        prefix = %cli.route_prefix,
        store = %cli.store,
        "vidcall-server listening (REST + WS)"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| format!("server error: {e}"))?;
    tracing::info!("vidcall-server stopped");
    Ok(())
}

async fn build_store(cli: &Cli) -> Result<Arc<dyn Store>, String> {
    let interval = std::time::Duration::from_millis(cli.poll_interval_ms);
    match cli.store.as_str() {
        "memory" => Ok(Arc::new(InMemoryStore::new())),
        "sqlite" => {
            let store = SqliteStore::open(&cli.sqlite_path).map_err(|e: VidcallError| e.message)?;
            store
                .bootstrap()
                .await
                .map_err(|e: VidcallError| e.message)?;
            Ok(Arc::new(store))
        }
        "postgres" => {
            let url = cli
                .database_url
                .clone()
                .ok_or("store=postgres requires --database-url (or VIDCALL_DATABASE_URL)")?;
            let store = PostgresStore::connect(&url)
                .await
                .map_err(|e: VidcallError| e.message)?;
            store
                .bootstrap()
                .await
                .map_err(|e: VidcallError| e.message)?;
            Ok(Arc::new(store))
        }
        "convex" => {
            let url = cli
                .convex_url
                .clone()
                .ok_or("store=convex requires --convex-url (or VIDCALL_CONVEX_URL)")?;
            let store = ConvexStore::new(url).map_err(|e: VidcallError| e.message)?;
            Ok(Arc::new(store))
        }
        "supabase" => {
            let url = cli
                .supabase_url
                .clone()
                .ok_or("store=supabase requires --supabase-url (or VIDCALL_SUPABASE_URL)")?;
            let key = cli
                .supabase_key
                .clone()
                .ok_or("store=supabase requires --supabase-key (or VIDCALL_SUPABASE_KEY)")?;
            let store = SupabaseStore::new(url, key).map_err(|e: VidcallError| e.message)?;
            Ok(Arc::new(store))
        }
        "http-json" => {
            let url = cli
                .http_json_url
                .clone()
                .ok_or("store=http-json requires --http-json-url (or VIDCALL_HTTP_JSON_URL)")?;
            let mut cfg = vidcall_server::stores::HttpJsonConfig::new(url);
            cfg.poll_interval = interval;
            let store = HttpJsonStore::new(cfg).map_err(|e: VidcallError| e.message)?;
            Ok(Arc::new(store))
        }
        other => Err(format!(
            "unknown store {other:?} (expected memory|sqlite|postgres|convex|supabase|http-json)"
        )),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
