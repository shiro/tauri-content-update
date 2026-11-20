#[tauri::command] fn a() {}
fn run() { generate_handler![a, gone] }
