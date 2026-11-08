use crate::{
    error::{Error, Result, bad, unauthorized},
    state::{App, now},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub username: String,
    pub name: String,
}
pub fn session_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
pub fn token(headers: &HeaderMap) -> Result<String> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .find_map(|c| c.trim().strip_prefix("may_session="))
        })
        .filter(|s| s.len() == 64)
        .map(str::to_string)
        .ok_or_else(unauthorized)
}
pub async fn current(app: &App, headers: &HeaderMap) -> Result<User> {
    let t = token(headers)?;
    sqlx::query_as::<_,User>("SELECT u.id,u.username,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").bind(session_hash(&t)).bind(now()).fetch_optional(&app.db).await?.ok_or_else(unauthorized)
}
#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
    pub name: Option<String>,
}
fn validate(c: &Credentials) -> Result<()> {
    if c.username.len() < 3
        || c.username.len() > 32
        || !c
            .username
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return Err(bad(
            "Tên đăng nhập gồm 3–32 chữ cái không dấu, số hoặc dấu gạch dưới.",
        ));
    }
    if c.password.chars().count() < 8 || c.password.chars().count() > 128 {
        return Err(bad("Mật khẩu cần từ 8 đến 128 ký tự."));
    }
    Ok(())
}
async fn session(app: &App, user: User) -> Result<(HeaderMap, Json<User>)> {
    let t = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut tx = app.db.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at<=?")
        .bind(now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 4)").bind(&user.id).bind(&user.id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO sessions VALUES (?,?,?)")
        .bind(session_hash(&t))
        .bind(&user.id)
        .bind(now() + 604800)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        format!(
            "may_session={t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800{}",
            if app.secure { "; Secure" } else { "" }
        )
        .parse()
        .unwrap(),
    );
    Ok((headers, Json(user)))
}
pub async fn register(
    State(app): State<App>,
    Json(mut c): Json<Credentials>,
) -> Result<(HeaderMap, Json<User>)> {
    c.username = c.username.to_ascii_lowercase();
    validate(&c)?;
    let name = c.name.as_deref().unwrap_or(&c.username).trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(bad("Tên hiển thị cần từ 1 đến 60 ký tự."));
    }
    let slot = app.hash_slots.clone().try_acquire_owned().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Máy chủ đang bận, hãy thử lại sau vài giây.".into(),
        )
    })?;
    let password = c.password;
    let hash = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        Argon2::default()
            .hash_password(
                password.as_bytes(),
                &SaltString::generate(&mut rand_core::OsRng),
            )
            .map(|x| x.to_string())
    })
    .await
    .map_err(|_| bad("Không thể xử lý mật khẩu."))?
    .map_err(|_| bad("Không thể xử lý mật khẩu."))?;
    let u = User {
        id: Uuid::new_v4().to_string(),
        username: c.username,
        name,
    };
    sqlx::query("INSERT INTO users VALUES (?,?,?,?,?)")
        .bind(&u.id)
        .bind(&u.username)
        .bind(&u.name)
        .bind(hash)
        .bind(now())
        .execute(&app.db)
        .await?;
    session(&app, u).await
}
pub async fn login(
    State(app): State<App>,
    Json(c): Json<Credentials>,
) -> Result<(HeaderMap, Json<User>)> {
    validate(&c)?;
    let row: Option<(String, String, String, String)> =
        sqlx::query_as("SELECT id,username,name,password_hash FROM users WHERE username=?")
            .bind(c.username.to_ascii_lowercase())
            .fetch_optional(&app.db)
            .await?;
    // A valid fixed Argon2 hash keeps nonexistent usernames on the same verification path.
    let fallback = "$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0MTIzNDU2Nw$w0OxvKXH7aL35yyIA3h4AL0gVr0LGVk6vFvB5MwCsRE";
    let hash = row
        .as_ref()
        .map(|r| r.3.clone())
        .unwrap_or_else(|| fallback.into());
    let slot = app.hash_slots.clone().try_acquire_owned().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Hãy thử lại sau vài giây.".into(),
        )
    })?;
    let ok = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        PasswordHash::new(&hash).is_ok_and(|h| {
            Argon2::default()
                .verify_password(c.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !ok || row.is_none() {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "Tên đăng nhập hoặc mật khẩu không đúng.".into(),
        ));
    }
    let (id, username, name, _) = row.unwrap();
    session(&app, User { id, username, name }).await
}
pub async fn me(State(app): State<App>, headers: HeaderMap) -> Result<Json<User>> {
    Ok(Json(current(&app, &headers).await?))
}
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<HeaderMap> {
    let t = token(&headers)?;
    sqlx::query("DELETE FROM sessions WHERE token_hash=?")
        .bind(session_hash(&t))
        .execute(&app.db)
        .await?;
    let mut h = HeaderMap::new();
    h.insert(
        header::SET_COOKIE,
        "may_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            .parse()
            .unwrap(),
    );
    Ok(h)
}
