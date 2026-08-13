//! Store implementations: one per backing database, all passing the shared
//! suite (`crate::shared_tests::run_store_test_suite`).

pub mod convex;
pub mod http_json;
pub mod memory;
pub mod postgres;
pub mod sqlite;
pub mod supabase;

pub use convex::ConvexStore;
pub use http_json::{HttpJsonConfig, HttpJsonStore};
pub use memory::InMemoryStore;
pub use postgres::PostgresStore;
pub use sqlite::SqliteStore;
pub use supabase::SupabaseStore;
