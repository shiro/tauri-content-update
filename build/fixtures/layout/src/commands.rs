/// listed twice in generate_handler! (by two paths): one command
#[tauri::command]
pub fn listed(item: Item) -> Option<Item> { None }

pub struct Item { pub id: u64 }
