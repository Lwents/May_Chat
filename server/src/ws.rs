use crate::{
    auth,
    error::{Error, Result, denied},
    state::{App, Peer, now},
};
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;
pub async fn upgrade(
    State(app): State<App>,
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    if h.get("origin").and_then(|x| x.to_str().ok()) != Some(&app.origin) {
        return Err(denied());
    }
    let u = auth::current(&app, &h).await?;
    let session = auth::session_hash(&auth::token(&h)?);
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<Arc<str>>(64);
    let (stop, stop_rx) = watch::channel(false);
    {
        let mut hub = app.hub.lock().unwrap();
        let total: usize = hub.values().map(|p| p.len()).sum();
        if total >= 256 {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Máy chủ đã đạt giới hạn kết nối thử nghiệm.".into(),
            ));
        }
        let peers = hub.entry(u.id.clone()).or_default();
        if peers.len() >= 3 {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Tối đa 3 kết nối cho mỗi tài khoản.".into(),
            ));
        }
        peers.insert(id.clone(), Peer { tx, stop });
    }
    let failed_app = app.clone();
    let failed_uid = u.id.clone();
    let failed_id = id.clone();
    Ok(ws
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_failed_upgrade(move |_| {
            let mut hub = failed_app.hub.lock().unwrap();
            if let Some(peers) = hub.get_mut(&failed_uid) {
                peers.remove(&failed_id);
                if peers.is_empty() {
                    hub.remove(&failed_uid);
                }
            }
        })
        .on_upgrade(move |socket| run(socket, app, u, id, session, rx, stop_rx)))
}
async fn run(
    socket: WebSocket,
    app: App,
    u: auth::User,
    id: String,
    session: String,
    mut rx: mpsc::Receiver<Arc<str>>,
    mut stop: watch::Receiver<bool>,
) {
    let peers = app.peers_of(&u.id).await;
    app.emit(
        &peers,
        json!({"type":"presence","user_id":u.id,"online":true}),
    );
    let (mut sender, mut receiver) = socket.split();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
             _=stop.changed()=>{break;}
             value=rx.recv()=>{let Some(value)=value else{break};if !matches!(tokio::time::timeout(Duration::from_secs(10),sender.send(Message::Text(value.to_string().into()))).await,Ok(Ok(()))){break}}
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), sender.close()).await;
    });
    let mut tick = tokio::time::interval(Duration::from_secs(20));
    let mut last = std::time::Instant::now();
    loop {
        tokio::select! {
         _=tick.tick()=>{
          if writer.is_finished()||last.elapsed()>Duration::from_secs(65){break}
          let valid:i64=sqlx::query_scalar("SELECT count(*) FROM sessions WHERE token_hash=? AND expires_at>?").bind(&session).bind(now()).fetch_one(&app.db).await.unwrap_or(0);
          if valid==0 {break}
          app.emit(std::slice::from_ref(&u.id),json!({"type":"ping"}));
         }
         incoming=receiver.next()=>{
          match incoming {
           Some(Ok(Message::Text(text)))=>{
            last=std::time::Instant::now();
            if !app.rate(format!("ws:{}",u.id),240,60){break}
            let Ok(v)=serde_json::from_str::<Value>(&text)else{break};
            if let Err(e)=event(&app,&u,v).await {app.emit(std::slice::from_ref(&u.id),json!({"type":"error","error":e.1}));}
           }
           Some(Ok(Message::Pong(_)))|Some(Ok(Message::Ping(_)))=>{last=std::time::Instant::now();}
           Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
           _=>{}
          }
         }
        }
    }
    writer.abort();
    {
        let mut hub = app.hub.lock().unwrap();
        if let Some(peers) = hub.get_mut(&u.id) {
            peers.remove(&id);
            if peers.is_empty() {
                hub.remove(&u.id);
            }
        }
    }
    if !app.online(&u.id) {
        let active: Vec<String> = sqlx::query_scalar("SELECT m.call_id FROM call_members m JOIN calls c ON c.id=m.call_id WHERE m.user_id=? AND m.status='joined' AND c.status!='ended'").bind(&u.id).fetch_all(&app.db).await.unwrap_or_default();
        for call_id in active {
            let _ = crate::calls::leave_user(&app, &u.id, &call_id).await;
        }
    }
    app.emit(
        &app.peers_of(&u.id).await,
        json!({"type":"presence","user_id":u.id,"online":app.online(&u.id)}),
    );
}
async fn event(app: &App, u: &auth::User, v: Value) -> Result<()> {
    let value = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "pong" => {}
        "typing" => {
            let cid = value("conversation_id");
            app.require_member(&cid, &u.id).await?;
            if app.rate(format!("typing:{}", u.id), 20, 60) {
                let members = app
                    .members(&cid)
                    .await?
                    .into_iter()
                    .filter(|id| id != &u.id)
                    .collect::<Vec<_>>();
                app.emit(
                    &members,
                    json!({"type":"typing","conversation_id":cid,"user_id":u.id}),
                );
            }
        }
        "message.send" => {
            let cid = value("conversation_id");
            let m = serde_json::from_value::<crate::chat::NewMessage>(v.clone())
                .map_err(|_| crate::error::bad("Tin nhắn không hợp lệ."))?;
            let saved = crate::chat::persist(app, u, &cid, m).await?;
            app.emit(
                std::slice::from_ref(&u.id),
                json!({"type":"message.ack","message":saved}),
            );
        }
        "call.signal" => {
            crate::calls::signal(
                app,
                &u.id,
                &value("call_id"),
                &value("to"),
                v.get("data").cloned().unwrap_or(Value::Null),
            )
            .await?;
        }
        _ => return Err(crate::error::bad("Sự kiện không được hỗ trợ.")),
    }
    Ok(())
}
