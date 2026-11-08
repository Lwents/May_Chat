use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
pub struct Error(pub StatusCode, pub String);
pub type Result<T> = std::result::Result<T, Error>;
pub fn bad(s: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, s.into())
}
pub fn denied() -> Error {
    Error(
        StatusCode::FORBIDDEN,
        "Bạn không có quyền thực hiện thao tác này.".into(),
    )
}
pub fn unauthorized() -> Error {
    Error(StatusCode::UNAUTHORIZED, "Vui lòng đăng nhập lại.".into())
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(ref d) = e {
            if d.is_unique_violation() {
                return Error(
                    StatusCode::CONFLICT,
                    "Dữ liệu đã tồn tại hoặc thao tác đang được thực hiện.".into(),
                );
            }
        }
        tracing::error!(error=%e,"database failure");
        Error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Không thể xử lý dữ liệu. Vui lòng thử lại.".into(),
        )
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        tracing::error!(error=%e,"storage failure");
        Error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Không thể lưu hoặc đọc tệp.".into(),
        )
    }
}
