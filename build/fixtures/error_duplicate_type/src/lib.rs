mod x { pub struct T { a: u8 } }
mod y { pub enum T { A } }
#[tauri::command] fn a(t: T) {}
fn r() { generate_handler![a] }
