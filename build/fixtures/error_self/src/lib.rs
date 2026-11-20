#[tauri::command] fn a(self: Box<Self>) {}
fn r() { generate_handler![a] }
