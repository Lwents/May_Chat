use serde_json::Value;
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Semaphore, mpsc, watch};
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
#[derive(Clone)]
pub struct Peer {
    pub tx: mpsc::Sender<Arc<str>>,
    pub stop: watch::Sender<bool>,
}
pub type Hub = HashMap<String, HashMap<String, Peer>>;
#[derive(Clone)]
pub struct App {
    pub db: SqlitePool,
    pub hub: Arc<Mutex<Hub>>,
    pub hash_slots: Arc<Semaphore>,
    pub file_slots: Arc<Semaphore>,
    pub rates: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
    pub origin: String,
    pub secure: bool,
    pub uploads: String,
    pub turn_urls: Vec<String>,
    pub turn_secret: String,
}
impl App {
    pub fn emit(&self, users: &[String], event: Value) {
        let data: Arc<str> = event.to_string().into();
        let mut hub = self.hub.lock().unwrap();
        for uid in users {
            if let Some(peers) = hub.get_mut(uid) {
                peers.retain(|_, p| {
                    if p.tx.try_send(data.clone()).is_err() {
                        let _ = p.stop.send(true);
                        false
                    } else {
                        true
                    }
                });
            }
        }
    }
    pub fn online(&self, uid: &str) -> bool {
        self.hub
            .lock()
            .unwrap()
            .get(uid)
            .is_some_and(|x| !x.is_empty())
    }
    pub fn rate(&self, key: String, limit: u32, seconds: u64) -> bool {
        let mut rates = self.rates.lock().unwrap();
        if rates.len() > 4096 {
            rates.retain(|_, v| v.0.elapsed() < Duration::from_secs(600));
        }
        if rates.len() > 8192 && !rates.contains_key(&key) {
            return false;
        }
        let entry = rates.entry(key).or_insert((Instant::now(), 0));
        if entry.0.elapsed() >= Duration::from_secs(seconds) {
            *entry = (Instant::now(), 0);
        }
        entry.1 += 1;
        entry.1 <= limit
    }
    pub async fn members(&self, cid: &str) -> crate::error::Result<Vec<String>> {
        Ok(
            sqlx::query_scalar("SELECT user_id FROM members WHERE conversation_id=?")
                .bind(cid)
                .fetch_all(&self.db)
                .await?,
        )
    }
    pub async fn require_member(&self, cid: &str, uid: &str) -> crate::error::Result<()> {
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM members WHERE conversation_id=? AND user_id=?",
        )
        .bind(cid)
        .bind(uid)
        .fetch_one(&self.db)
        .await?;
        if n == 0 {
            return Err(crate::error::denied());
        }
        Ok(())
    }
    pub async fn peers_of(&self, uid: &str) -> Vec<String> {
        sqlx::query_scalar("SELECT DISTINCT b.user_id FROM members a JOIN members b ON a.conversation_id=b.conversation_id WHERE a.user_id=?").bind(uid).fetch_all(&self.db).await.unwrap_or_default()
    }
}
