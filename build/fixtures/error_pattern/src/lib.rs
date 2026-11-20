#[tauri::command] fn a(app: AppHandle, (x, y): (u8, u8)) {}
fn r() { generate_handler![a] }
