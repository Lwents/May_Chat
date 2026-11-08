use crate::{
    auth,
    error::{Error, Result, bad},
    state::{App, now},
};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use futures_util::StreamExt;
use serde_json::json;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

// Decimal MB, exclusive: exactly 100 MB is rejected on both client and server.
pub const MAX_FILE_BYTES: u64 = 100_000_000;
const DAILY_UPLOAD_BYTES: i64 = 1_000_000_000;
pub const MAX_REQUEST_BYTES: usize = MAX_FILE_BYTES as usize + 64 * 1024;

struct PartialFile(PathBuf);
impl Drop for PartialFile {
    fn drop(&mut self) {
        // Unlink on errors or request cancellation; never publish partial uploads.
        let _ = std::fs::remove_file(&self.0);
    }
}
fn too_large() -> Error {
    Error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Tệp đính kèm phải nhỏ hơn 100 MB.".into(),
    )
}
fn mime_for(prefix: &[u8]) -> &'static str {
    if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if prefix.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

pub async fn upload(
    State(app): State<App>,
    h: HeaderMap,
    Path(cid): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>> {
    let user = auth::current(&app, &h).await?;
    app.require_member(&cid, &user.id).await?;
    let _slot = app.file_slots.clone().try_acquire_owned().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Đang xử lý nhiều tệp. Hãy thử lại sau vài giây.".into(),
        )
    })?;
    let used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(size),0) FROM attachments WHERE owner_id=? AND created_at>?",
    )
    .bind(&user.id)
    .bind(now() - 86400)
    .fetch_one(&app.db)
    .await?;
    if used >= DAILY_UPLOAD_BYTES {
        return Err(bad("Đã đạt giới hạn tải lên 1 GB/ngày."));
    }
    let mut field = multipart
        .next_field()
        .await
        .map_err(|e| {
            Error(
                e.status(),
                "Tệp tải lên không hợp lệ hoặc vượt giới hạn.".into(),
            )
        })?
        .ok_or_else(|| bad("Chưa chọn tệp."))?;
    if field.name() != Some("file") {
        return Err(bad("Cần chọn một tệp đính kèm."));
    }
    let name = field
        .file_name()
        .unwrap_or("tep-dinh-kem")
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\')
        .take(120)
        .collect::<String>();
    let name = if name.is_empty() {
        "tep-dinh-kem".to_string()
    } else {
        name
    };
    let id = Uuid::new_v4().to_string();
    let partial = PartialFile(PathBuf::from(format!("{}/.{}.part", app.uploads, id)));
    let path = PathBuf::from(format!("{}/{}", app.uploads, id));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial.0)
        .await?;
    let mut size = 0_u64;
    let mut prefix = Vec::with_capacity(12);
    while let Some(chunk) = field.chunk().await.map_err(|e| {
        Error(
            e.status(),
            "Tệp bị gián đoạn hoặc vượt giới hạn 100 MB.".into(),
        )
    })? {
        size += chunk.len() as u64;
        if size >= MAX_FILE_BYTES {
            return Err(too_large());
        }
        if used + size as i64 > DAILY_UPLOAD_BYTES {
            return Err(bad("Đã đạt giới hạn tải lên 1 GB/ngày."));
        }
        let prefix_bytes = (12 - prefix.len()).min(chunk.len());
        prefix.extend_from_slice(&chunk[..prefix_bytes]);
        file.write_all(&chunk).await?;
    }
    if size == 0 {
        return Err(bad("Không thể gửi tệp rỗng."));
    }
    drop(field);
    if multipart
        .next_field()
        .await
        .map_err(|e| Error(e.status(), "Yêu cầu tải lên không hợp lệ.".into()))?
        .is_some()
    {
        return Err(bad("Mỗi lần chỉ gửi một tệp đính kèm."));
    }
    file.flush().await?;
    file.sync_data().await?;
    drop(file);
    let mime = mime_for(&prefix);
    // Hold SQLite's writer lock only for final quota validation and metadata, not upload I/O.
    let mut tx = app.db.begin_with("BEGIN IMMEDIATE").await?;
    let current_used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(size),0) FROM attachments WHERE owner_id=? AND created_at>?",
    )
    .bind(&user.id)
    .bind(now() - 86400)
    .fetch_one(&mut *tx)
    .await?;
    if current_used + size as i64 > DAILY_UPLOAD_BYTES {
        return Err(bad("Đã đạt giới hạn tải lên 1 GB/ngày."));
    }
    tokio::fs::rename(&partial.0, &path).await?;
    if let Err(e) = sqlx::query("INSERT INTO attachments(id,conversation_id,owner_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(&id).bind(&cid).bind(&user.id).bind(&name).bind(mime).bind(size as i64).bind(now())
        .execute(&mut *tx).await {
        let _ = tokio::fs::remove_file(path).await;
        return Err(e.into());
    }
    // Leave the completed file intact on an indeterminate commit error; never delete
    // a file whose metadata might already be committed.
    tx.commit().await?;
    Ok(Json(
        json!({"id": id, "name": name, "mime": mime, "size": size}),
    ))
}

pub async fn download(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse> {
    let user = auth::current(&app, &h).await?;
    let (cid, mime, name, size): (String, String, String, i64) =
        sqlx::query_as("SELECT conversation_id,mime,name,size FROM attachments WHERE id=?")
            .bind(&id)
            .fetch_optional(&app.db)
            .await?
            .ok_or_else(|| Error(StatusCode::NOT_FOUND, "Không tìm thấy tệp.".into()))?;
    app.require_member(&cid, &user.id).await?;
    let slot = app.file_slots.clone().try_acquire_owned().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Đang xử lý nhiều tệp. Hãy thử lại sau vài giây.".into(),
        )
    })?;
    let file = tokio::fs::File::open(format!("{}/{}", app.uploads, id)).await?;
    let reader = ReaderStream::with_capacity(file, 64 * 1024);
    // Retain the permit for the response's lifetime, including slow downloads.
    let stream =
        futures_util::stream::try_unfold((reader, slot), |(mut reader, slot)| async move {
            match reader.next().await {
                Some(Ok(chunk)) => Ok::<_, std::io::Error>(Some((chunk, (reader, slot)))),
                Some(Err(e)) => Err(e),
                None => Ok(None),
            }
        });
    let encoded_name: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{id}\"; filename*=UTF-8''{encoded_name}"),
            ),
            (header::CACHE_CONTROL, "private, no-store".into()),
        ],
        Body::from_stream(stream),
    ))
}
