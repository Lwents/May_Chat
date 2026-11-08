use crate::{
    auth,
    error::{Result, bad, denied},
    state::{App, now},
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
#[derive(Serialize, sqlx::FromRow)]
pub struct Call {
    pub id: String,
    pub conversation_id: String,
    pub started_by: String,
    pub mode: String,
    pub status: String,
    pub created_at: i64,
}
// Reconnect recovery must not ring calls already answered on another tab/device.
pub async fn active(State(app): State<App>, h: HeaderMap) -> Result<Json<Vec<Call>>> {
    let u = auth::current(&app, &h).await?;
    Ok(Json(sqlx::query_as("SELECT c.id,c.conversation_id,c.started_by,c.mode,c.status,c.created_at FROM calls c JOIN call_members cm ON cm.call_id=c.id WHERE cm.user_id=? AND cm.status='invited' AND c.status!='ended' ORDER BY c.created_at DESC").bind(u.id).fetch_all(&app.db).await?))
}
pub async fn history(State(app): State<App>, h: HeaderMap) -> Result<Json<Vec<Call>>> {
    let u = auth::current(&app, &h).await?;
    Ok(Json(sqlx::query_as("SELECT c.id,c.conversation_id,c.started_by,c.mode,c.status,c.created_at FROM calls c JOIN call_members cm ON cm.call_id=c.id WHERE cm.user_id=? ORDER BY c.created_at DESC LIMIT 100").bind(u.id).fetch_all(&app.db).await?))
}
#[derive(Deserialize)]
pub struct Start {
    pub conversation_id: String,
    pub mode: String,
}
pub async fn start(
    State(app): State<App>,
    h: HeaderMap,
    Json(c): Json<Start>,
) -> Result<Json<Call>> {
    let u = auth::current(&app, &h).await?;
    app.require_member(&c.conversation_id, &u.id).await?;
    if !matches!(c.mode.as_str(), "audio" | "video") {
        return Err(bad("Chế độ gọi không hợp lệ."));
    }
    let members = app.members(&c.conversation_id).await?;
    if members.len() > 5 {
        return Err(bad(
            "Gọi mesh hỗ trợ tối đa 5 thành viên. Nhóm lớn cần tích hợp SFU.",
        ));
    }
    let mut tx = app.db.begin_with("BEGIN IMMEDIATE").await?;
    let busy:i64=sqlx::query_scalar("SELECT count(*) FROM call_members m JOIN calls c ON c.id=m.call_id WHERE m.user_id=? AND m.status='joined' AND c.status!='ended'").bind(&u.id).fetch_one(&mut *tx).await?;
    if busy > 0 {
        return Err(bad("Bạn đang ở trong một cuộc gọi khác."));
    }
    let call = Call {
        id: Uuid::new_v4().to_string(),
        conversation_id: c.conversation_id,
        started_by: u.id.clone(),
        mode: c.mode,
        status: "ringing".into(),
        created_at: now(),
    };
    sqlx::query("INSERT INTO calls(id,conversation_id,started_by,mode,status,created_at) VALUES (?,?,?,?,?,?)").bind(&call.id).bind(&call.conversation_id).bind(&call.started_by).bind(&call.mode).bind(&call.status).bind(call.created_at).execute(&mut *tx).await?;
    for uid in &members {
        sqlx::query("INSERT INTO call_members VALUES (?,?,?)")
            .bind(&call.id)
            .bind(uid)
            .bind(if uid == &u.id { "joined" } else { "invited" })
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    app.emit(&members, json!({"type":"call.invite","call":call}));
    Ok(Json(call))
}
pub async fn join(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let u = auth::current(&app, &h).await?;
    let mut tx = app.db.begin_with("BEGIN IMMEDIATE").await?;
    let member:i64=sqlx::query_scalar("SELECT count(*) FROM call_members m JOIN calls c ON c.id=m.call_id WHERE m.call_id=? AND m.user_id=? AND m.status!='left' AND c.status!='ended'").bind(&id).bind(&u.id).fetch_one(&mut *tx).await?;
    if member == 0 {
        return Err(denied());
    }
    let busy:i64=sqlx::query_scalar("SELECT count(*) FROM call_members m JOIN calls c ON c.id=m.call_id WHERE m.user_id=? AND m.status='joined' AND c.status!='ended' AND c.id!=?").bind(&u.id).bind(&id).fetch_one(&mut *tx).await?;
    if busy > 0 {
        return Err(bad("Bạn đang ở trong một cuộc gọi khác."));
    }
    let peers: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM call_members WHERE call_id=? AND status='joined' AND user_id!=?",
    )
    .bind(&id)
    .bind(&u.id)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("UPDATE calls SET status='active' WHERE id=? AND status!='ended'")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE call_members SET status='joined' WHERE call_id=? AND user_id=?")
        .bind(&id)
        .bind(&u.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let members: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM call_members WHERE call_id=?")
            .bind(&id)
            .fetch_all(&app.db)
            .await?;
    app.emit(
        &members,
        json!({"type":"call.accepted","call_id":id,"user_id":u.id}),
    );
    app.emit(
        &peers,
        json!({"type":"call.peer_joined","call_id":id,"user_id":u.id}),
    );
    Ok(Json(json!({"peers":peers})))
}
pub async fn leave(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let u = auth::current(&app, &h).await?;
    leave_user(&app, &u.id, &id).await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn leave_user(app: &App, uid: &str, id: &str) -> Result<()> {
    let mut tx = app.db.begin_with("BEGIN IMMEDIATE").await?;
    let row:Option<(String,String)>=sqlx::query_as("SELECT c.conversation_id,c.started_by FROM calls c JOIN call_members m ON m.call_id=c.id WHERE c.id=? AND m.user_id=?").bind(&id).bind(uid).fetch_optional(&mut *tx).await?;
    let (cid, _) = row.ok_or_else(denied)?;
    sqlx::query("UPDATE call_members SET status='left' WHERE call_id=? AND user_id=?")
        .bind(&id)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM call_members WHERE call_id=? AND status='joined'")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM call_members WHERE call_id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let ended = count == 0 || total == 2;
    if ended {
        sqlx::query("UPDATE calls SET status='ended',ended_at=? WHERE id=?")
            .bind(now())
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    app.emit(
        &app.members(&cid).await?,
        json!({"type":if ended{"call.ended"}else{"call.peer_left"},"call_id":id,"user_id":uid}),
    );
    Ok(())
}
pub async fn signal(app: &App, uid: &str, id: &str, target: &str, data: Value) -> Result<()> {
    if data.to_string().len() > 48 * 1024
        || !matches!(
            data.get("kind").and_then(Value::as_str),
            Some("offer" | "answer" | "ice")
        )
    {
        return Err(bad("Tín hiệu cuộc gọi không hợp lệ."));
    }
    let n:i64=sqlx::query_scalar("SELECT count(*) FROM call_members m JOIN calls c ON c.id=m.call_id WHERE m.call_id=? AND m.status='joined' AND m.user_id IN (?,?) AND c.status!='ended'").bind(id).bind(uid).bind(target).fetch_one(&app.db).await?;
    if n != 2 || uid == target {
        return Err(denied());
    }
    app.emit(
        &[target.into()],
        json!({"type":"call.signal","call_id":id,"from":uid,"data":data}),
    );
    Ok(())
}
pub async fn ice(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let u = auth::current(&app, &h).await?;
    let mut servers = vec![json!({"urls":["stun:stun.l.google.com:19302"]})];
    if !app.turn_secret.is_empty() && !app.turn_urls.is_empty() {
        let username = format!("{}:{}", now() + 3600, u.id);
        let mut mac = Hmac::<sha1::Sha1>::new_from_slice(app.turn_secret.as_bytes())
            .map_err(|_| bad("TURN chưa được cấu hình."))?;
        mac.update(username.as_bytes());
        servers.push(json!({"urls":app.turn_urls,"username":username,"credential":STANDARD.encode(mac.finalize().into_bytes())}));
    }
    Ok(Json(json!({"iceServers":servers})))
}
