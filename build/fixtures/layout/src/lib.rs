//! The crate docs (an inner attribute).
#![allow(unused)]

mod commands;
mod deep;

use std::fmt;

// fn commented_out() { tauri::generate_handler![not_a_command] }
/* struct InComment; generate_handler![nope] /* nested */ still a comment */

const _: () = {
    #[tauri::command]
    fn in_const() -> u8 { 1 }
};

pub fn run() {
    let s = "generate_handler![in_string] struct InString;";
    let r = r#"generate_handler![in_raw] "quoted" { unbalanced"#;
    let c = '{';
    let b = b'}';
    let lt: &'static str = "x";
    'outer: loop { break 'outer; }

    // registered in a closure, nested calls and blocks
    let builder = || {
        tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![
                commands::listed,
                crate::commands::listed,
                deep::deeper::from_deep,
                in_const,
                nested_in_fn,
                in_impl_body,
                in_trait_default,
                r#raw_command,
            ])
    };

    #[tauri::command]
    fn nested_in_fn() -> NestedInFn {
        todo!()
    }

    struct NestedInFn {
        value: u8,
    }

    // not visited by syn: macro bodies
    vec![tauri::generate_handler![in_vec_macro]];
    macro_rules! make {
        () => {
            struct FromMacro;
            tauri::generate_handler![in_macro_rules];
        };
    }
}

pub struct Thing;

impl Thing {
    /// methods aren't commands, even with the attribute
    #[tauri::command]
    fn method(&self) -> u8 { 1 }

    fn with_body(&self) {
        #[tauri::command]
        fn in_impl_body(x: InImpl) {}
        struct InImpl { a: u8 }
    }
}

impl fmt::Display for Thing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { Ok(()) }
}

impl<T: Fn() -> u8> From<T> for Thing where T: Clone {
    fn from(_: T) -> Self { Thing }
}

pub trait Tr {
    type Assoc;
    fn required(&self);
    fn provided(&self) {
        #[tauri::command]
        fn in_trait_default() -> Vec<InTrait> { vec![] }
        struct InTrait(u8, bool);
    }
}

extern "C" {
    fn foreign(x: u8) -> u8;
}

#[tauri::command]
fn r#raw_command(r#struct: u8) {}

#[tauri::command]
fn not_registered(x: DoesNotExist) {}

#[cfg(test)]
mod tests {
    // types defined twice aren't an error while no command uses them
    struct Thing;
}
