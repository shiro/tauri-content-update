mod x { #[command] fn a() {} }
mod y { #[command] fn a() {} }
fn r() { generate_handler![x::a] }
