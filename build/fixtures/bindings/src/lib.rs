/// What the app reports.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// the version
    pub app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip)]
    pub secret: String,
    pub kind: Kind,
    pub pages: Page<String>,
}
#[serde(rename_all = "kebab-case")]
pub enum Kind { DesktopApp, Mobile }
#[serde(tag = "type")]
pub enum Event { Started { at: u64 }, Stopped }
pub struct Page<T> { items: Vec<T> }

/// Says hello.
#[tauri::command]
fn greet(app: AppHandle, r#type: String, user_name: Option<String>) -> String { todo!() }
#[tauri::command]
async fn info() -> Result<Info, Error> { todo!() }
#[tauri::command]
fn events(on_event: Channel<Event>) {}
fn run() { generate_handler![greet, info, events] }
