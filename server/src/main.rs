mod attachments;
mod auth;
mod calls;
mod chat;
mod error;
mod state;
mod ws;
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use state::{App, now};
use std::{
    collections::HashMap,
    net::SocketAddr,
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "may_server=info,tower_http=info".into()),
        )
        .init();
    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://data/may.db".into());
    tokio::fs::create_dir_all("data").await?;
    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .pragma("cache_size", "-4096")
        .pragma("mmap_size", "0");
    let db = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&db).await?;
    sqlx::query("UPDATE calls SET status='ended',ended_at=? WHERE status!='ended'")
        .bind(now())
        .execute(&db)
        .await?;
    let origin = std::env::var("APP_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into());
    let app = App {
        db,
        hub: Arc::new(Mutex::new(HashMap::new())),
        hash_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        file_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        rates: Arc::new(Mutex::new(HashMap::new())),
        secure: origin.starts_with("https://"),
        origin,
        uploads: std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "data/uploads".into()),
        turn_urls: std::env::var("TURN_URLS")
            .unwrap_or_default()
            .split(',')
            .filter(|x| !x.is_empty())
            .map(str::to_string)
            .collect(),
        turn_secret: std::env::var("TURN_SECRET").unwrap_or_default(),
    };
    tokio::fs::create_dir_all(&app.uploads).await?;
    let maintenance = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            cleanup(&maintenance).await;
        }
    });
    let routes = Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"ok":true,"service":"may-rust","version":"0.1.0"})) }),
        )
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route("/api/users", get(chat::users))
        .route(
            "/api/conversations",
            get(chat::conversations).post(chat::create_conversation),
        )
        .route(
            "/api/conversations/{id}/messages",
            get(chat::history).post(chat::send),
        )
        .route("/api/conversations/{id}/read", post(chat::read))
        .route(
            "/api/conversations/{id}/attachments",
            post(attachments::upload).layer(DefaultBodyLimit::max(attachments::MAX_REQUEST_BYTES)),
        )
        .route("/api/attachments/{id}", get(attachments::download))
        .route("/api/calls", get(calls::active).post(calls::start))
        .route("/api/calls/history", get(calls::history))
        .route("/api/calls/{id}/join", post(calls::join))
        .route("/api/calls/{id}/leave", post(calls::leave))
        .route("/api/ice", get(calls::ice))
        .route("/api/ws", get(ws::upgrade))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .layer(
            tower_http::set_header::SetResponseHeaderLayer::if_not_present(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            ),
        )
        .layer(
            tower_http::set_header::SetResponseHeaderLayer::if_not_present(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        )
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(app);
    let address = std::env::var("BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address,"Mây backend ready");
    axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
async fn guard(State(app): State<App>, request: Request, next: Next) -> error::Result<Response> {
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && request
        .headers()
        .get("origin")
        .and_then(|h| h.to_str().ok())
        != Some(&app.origin)
    {
        return Err(error::denied());
    }
    let ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into());
    let ip = if std::env::var("TRUST_PROXY").as_deref() == Ok("true") {
        request
            .headers()
            .get("x-real-ip")
            .and_then(|h| h.to_str().ok())
            .filter(|s| s.parse::<std::net::IpAddr>().is_ok())
            .unwrap_or(&ip)
            .to_string()
    } else {
        ip
    };
    let auth = request.uri().path().starts_with("/api/auth/");
    if !app.rate(format!("http:{auth}:{ip}"), if auth { 15 } else { 360 }, 60) {
        return Err(error::Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Quá nhiều yêu cầu, hãy thử lại sau một phút.".into(),
        ));
    }
    Ok(next.run(request).await)
}
async fn cleanup(app: &App) {
    let _ = sqlx::query("DELETE FROM sessions WHERE expires_at<?")
        .bind(now())
        .execute(&app.db)
        .await;
    let stale:Vec<(String,String)>=sqlx::query_as("SELECT id,conversation_id FROM calls WHERE (status='ringing' AND created_at<?) OR (status='active' AND created_at<?)").bind(now()-90).bind(now()-14400).fetch_all(&app.db).await.unwrap_or_default();
    for (id, cid) in stale {
        if sqlx::query("UPDATE calls SET status='ended',ended_at=? WHERE id=? AND status!='ended'")
            .bind(now())
            .bind(&id)
            .execute(&app.db)
            .await
            .is_ok()
        {
            app.emit(
                &app.members(&cid).await.unwrap_or_default(),
                json!({"type":"call.ended","call_id":id}),
            );
        }
    }
    let orphans:Vec<String>=sqlx::query_scalar("SELECT id FROM attachments WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.attachment_id=attachments.id) LIMIT 100").bind(now()-86400).fetch_all(&app.db).await.unwrap_or_default();
    for id in orphans {
        if sqlx::query("DELETE FROM attachments WHERE id=? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.attachment_id=attachments.id)").bind(&id).execute(&app.db).await.is_ok_and(|r|r.rows_affected()>0){let _=tokio::fs::remove_file(format!("{}/{}",app.uploads,id)).await;}
    }
    app.rates
        .lock()
        .unwrap()
        .retain(|_, v| v.0.elapsed() < Duration::from_secs(600));
}
