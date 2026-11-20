const COMMANDS: &[&str] = &[
    "get_state",
    "notify_ready",
    "check",
    "download",
    "apply",
    "reset",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
