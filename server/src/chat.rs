use crate::{
    auth::{self, User},
    error::{Error, Result, bad, denied},
    state::{App, now},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
#[derive(Serialize, sqlx::FromRow, Clone)]
pub struct Message {
    pub seq: i64,
    pub id: String,
    pub conversation_id: String,
    pub sender_id: String,
    pub client_message_id: String,
    pub body: String,
    pub attachment_id: Option<String>,
    pub created_at: i64,
    pub attachment_name: Option<String>,
    pub attachment_mime: Option<String>,
    pub attachment_size: Option<i64>,
}
const MESSAGE_SELECT: &str = "SELECT m.*,a.name attachment_name,a.mime attachment_mime,a.size attachment_size FROM messages m LEFT JOIN attachments a ON a.id=m.attachment_id";
#[derive(Serialize)]
pub struct Person {
    #[serde(flatten)]
    pub user: User,
    pub online: bool,
}
#[derive(Serialize)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub members: Vec<Person>,
    pub last_message: Option<Message>,
    pub unread: i64,
    pub read_seq: i64,
}
pub async fn conversations(
    State(app): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<Conversation>>> {
    let u = auth::current(&app, &h).await?;
    let rows:Vec<(String,String,String,i64)>=sqlx::query_as("SELECT c.id,c.name,c.kind,mb.last_read_seq FROM conversations c JOIN members mb ON mb.conversation_id=c.id WHERE mb.user_id=? ORDER BY COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id=c.id),0) DESC,c.created_at DESC LIMIT 200").bind(&u.id).fetch_all(&app.db).await?;
    let mut out = Vec::new();
    for (id, name, kind, read_seq) in rows {
        let people=sqlx::query_as::<_,User>("SELECT u.id,u.username,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.conversation_id=?").bind(&id).fetch_all(&app.db).await?;
        let members = people
            .into_iter()
            .map(|user| Person {
                online: app.online(&user.id),
                user,
            })
            .collect();
        let last_message = sqlx::query_as::<_, Message>(&format!(
            "{MESSAGE_SELECT} WHERE m.conversation_id=? ORDER BY m.seq DESC LIMIT 1"
        ))
        .bind(&id)
        .fetch_optional(&app.db)
        .await?;
        let unread = sqlx::query_scalar(
            "SELECT count(*) FROM messages WHERE conversation_id=? AND seq>? AND sender_id!=?",
        )
        .bind(&id)
        .bind(read_seq)
        .bind(&u.id)
        .fetch_one(&app.db)
        .await?;
        out.push(Conversation {
            id,
            name,
            kind,
            members,
            last_message,
            unread,
            read_seq,
        });
    }
    Ok(Json(out))
}
#[derive(Deserialize)]
pub struct Search {
    pub q: Option<String>,
}
pub async fn users(
    State(app): State<App>,
    h: HeaderMap,
    Query(q): Query<Search>,
) -> Result<Json<Vec<Person>>> {
    let u = auth::current(&app, &h).await?;
    let q = q.q.unwrap_or_default().trim().to_string();
    if q.chars().count() < 2 || q.len() > 64 {
        return Ok(Json(vec![]));
    }
    let q = q.replace('!', "!!").replace('%', "!%").replace('_', "!_");
    let people=sqlx::query_as::<_,User>("SELECT id,username,name FROM users WHERE id!=? AND (username LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!') ORDER BY username LIMIT 20").bind(u.id).bind(format!("{q}%")).bind(format!("{q}%")).fetch_all(&app.db).await?;
    Ok(Json(
        people
            .into_iter()
            .map(|user| Person {
                online: app.online(&user.id),
                user,
            })
            .collect(),
    ))
}
#[derive(Deserialize)]
pub struct NewConversation {
    pub members: Vec<String>,
    pub name: Option<String>,
    pub kind: String,
}
pub async fn create_conversation(
    State(app): State<App>,
    h: HeaderMap,
    Json(c): Json<NewConversation>,
) -> Result<Json<serde_json::Value>> {
    let u = auth::current(&app, &h).await?;
    let mut ids = c.members;
    ids.push(u.id.clone());
    ids.sort();
    ids.dedup();
    if ids.len() < 2
        || ids.len() > 50
        || !matches!(c.kind.as_str(), "direct" | "group")
        || (c.kind == "direct" && ids.len() != 2)
    {
        return Err(bad(
            "Chọn 1 người để chat riêng, hoặc 2–49 người để tạo nhóm.",
        ));
    }
    let name = c.name.unwrap_or_default().trim().to_string();
    if name.chars().count() > 80 || (c.kind == "group" && name.is_empty()) {
        return Err(bad("Tên nhóm cần từ 1 đến 80 ký tự."));
    }
    let mut tx = app.db.begin_with("BEGIN IMMEDIATE").await?;
    for uid in &ids {
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=?")
            .bind(uid)
            .fetch_one(&mut *tx)
            .await?;
        if exists == 0 {
            return Err(bad("Thành viên không tồn tại."));
        }
    }
    let key = if c.kind == "direct" {
        Some(ids.join(":"))
    } else {
        None
    };
    if let Some(ref key) = key {
        if let Some(id) =
            sqlx::query_scalar::<_, String>("SELECT id FROM conversations WHERE direct_key=?")
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
        {
            return Ok(Json(json!({"id":id})));
        }
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO conversations VALUES (?,?,?,?,?,?)")
        .bind(&id)
        .bind(name)
        .bind(&c.kind)
        .bind(key)
        .bind(&u.id)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    for uid in &ids {
        sqlx::query("INSERT INTO members(conversation_id,user_id) VALUES (?,?)")
            .bind(&id)
            .bind(uid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    app.emit(
        &ids,
        json!({"type":"conversation.new","conversation_id":id}),
    );
    Ok(Json(json!({"id":id})))
}
#[derive(Deserialize)]
pub struct Cursor {
    pub before: Option<i64>,
    pub after: Option<i64>,
}
pub async fn history(
    State(app): State<App>,
    h: HeaderMap,
    Path(cid): Path<String>,
    Query(c): Query<Cursor>,
) -> Result<Json<Vec<Message>>> {
    let u = auth::current(&app, &h).await?;
    app.require_member(&cid, &u.id).await?;
    let mut rows = if let Some(after) = c.after {
        sqlx::query_as::<_, Message>(&format!(
            "{MESSAGE_SELECT} WHERE m.conversation_id=? AND m.seq>? ORDER BY m.seq ASC LIMIT 50"
        ))
        .bind(&cid)
        .bind(after)
        .fetch_all(&app.db)
        .await?
    } else {
        sqlx::query_as::<_, Message>(&format!(
            "{MESSAGE_SELECT} WHERE m.conversation_id=? AND m.seq<? ORDER BY m.seq DESC LIMIT 50"
        ))
        .bind(&cid)
        .bind(c.before.unwrap_or(i64::MAX))
        .fetch_all(&app.db)
        .await?
    };
    rows.sort_by_key(|m| m.seq);
    Ok(Json(rows))
}
#[derive(Deserialize)]
pub struct NewMessage {
    pub body: String,
    pub client_message_id: String,
    pub attachment_id: Option<String>,
}
pub async fn persist(app: &App, u: &User, cid: &str, m: NewMessage) -> Result<Message> {
    app.require_member(cid, &u.id).await?;
    if m.body.len() > 4000
        || (m.body.trim().is_empty() && m.attachment_id.is_none())
        || Uuid::parse_str(&m.client_message_id).is_err()
    {
        return Err(bad("Tin nhắn tối đa 4.000 byte và cần mã gửi hợp lệ."));
    }
    if !app.rate(format!("message:{}", u.id), 60, 60) {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Bạn đang gửi quá nhanh. Hãy chờ một chút.".into(),
        ));
    }
    if let Some(ref aid) = m.attachment_id {
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM attachments WHERE id=? AND conversation_id=? AND owner_id=?",
        )
        .bind(aid)
        .bind(cid)
        .bind(&u.id)
        .fetch_one(&app.db)
        .await?;
        if n == 0 {
            return Err(denied());
        }
    }
    let result=sqlx::query("INSERT INTO messages(id,conversation_id,sender_id,client_message_id,body,attachment_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(sender_id,client_message_id) DO NOTHING").bind(Uuid::new_v4().to_string()).bind(cid).bind(&u.id).bind(&m.client_message_id).bind(&m.body).bind(&m.attachment_id).bind(now()).execute(&app.db).await?;
    let saved = sqlx::query_as::<_, Message>(&format!(
        "{MESSAGE_SELECT} WHERE m.sender_id=? AND m.client_message_id=?"
    ))
    .bind(&u.id)
    .bind(&m.client_message_id)
    .fetch_one(&app.db)
    .await?;
    if saved.conversation_id != cid
        || saved.body != m.body
        || saved.attachment_id != m.attachment_id
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "Mã gửi đã được sử dụng cho một tin nhắn khác.".into(),
        ));
    }
    // Autocommit finished before either the event or HTTP/WS acknowledgement.
    if result.rows_affected() > 0 {
        app.emit(
            &app.members(cid).await?,
            json!({"type":"message.new","message":saved}),
        );
    }
    Ok(saved)
}
pub async fn send(
    State(app): State<App>,
    h: HeaderMap,
    Path(cid): Path<String>,
    Json(m): Json<NewMessage>,
) -> Result<Json<Message>> {
    let u = auth::current(&app, &h).await?;
    Ok(Json(persist(&app, &u, &cid, m).await?))
}
#[derive(Deserialize)]
pub struct Read {
    pub seq: i64,
}
pub async fn read(
    State(app): State<App>,
    h: HeaderMap,
    Path(cid): Path<String>,
    Json(r): Json<Read>,
) -> Result<Json<serde_json::Value>> {
    let u = auth::current(&app, &h).await?;
    app.require_member(&cid, &u.id).await?;
    let max: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(seq),0) FROM messages WHERE conversation_id=?")
            .bind(&cid)
            .fetch_one(&app.db)
            .await?;
    let seq = r.seq.max(0).min(max);
    sqlx::query("UPDATE members SET last_read_seq=MAX(last_read_seq,?) WHERE conversation_id=? AND user_id=?").bind(seq).bind(&cid).bind(&u.id).execute(&app.db).await?;
    app.emit(
        &app.members(&cid).await?,
        json!({"type":"message.read","conversation_id":cid,"user_id":u.id,"seq":seq}),
    );
    Ok(Json(json!({"ok":true})))
}
