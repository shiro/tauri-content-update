#[tauri::command] fn a(_: u8) {}
fn r() { generate_handler![a] }
