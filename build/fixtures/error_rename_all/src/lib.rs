#[tauri::command(rename_all = 5)] fn a() {}
fn r() { generate_handler![a] }
