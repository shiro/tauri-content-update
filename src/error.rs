use serde::{ser::SerializeStruct, Serialize, Serializer};

/// Errors returned to JS as `{ code, message }`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// no manifest url given or configured
    #[error("no manifest url given or configured")]
    NoUrl,
    #[error("a download is already running")]
    Busy,
    #[error("no update is staged")]
    NoUpdate,
    #[error("{0}")]
    CheckFailed(String),
    #[error("{0}")]
    DownloadFailed(String),
    /// `wrap_assets()` wasn't called on the app's context
    #[error("tauri_plugin_content_update::wrap_assets() was not called on the app's context")]
    NotWrapped,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::NoUrl => "NO_URL",
            Error::Busy => "BUSY",
            Error::NoUpdate => "NO_UPDATE",
            Error::CheckFailed(_) => "CHECK_FAILED",
            Error::DownloadFailed(_) => "DOWNLOAD_FAILED",
            Error::NotWrapped => "NOT_WRAPPED",
            Error::Io(_) => "IO",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;
