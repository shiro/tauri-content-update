type A = B;
type B = A;
#[tauri::command] fn a() -> A { todo!() }
fn r() { generate_handler![a] }
