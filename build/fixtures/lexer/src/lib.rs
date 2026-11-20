#!/usr/bin/env run-cargo-script
//! inner doc

/**
 * Block doc,
 * multi-line.
 */
pub struct BlockDoc {
    pub a: u8,
}

/*** not a doc */
//// not a doc either
/**/
pub struct Comments {
    /// line doc with trailing spaces   
    ///
    ///    indented
    pub a: u8,
}

/// doc with unicode: éè ☃ and an emoji 😀
pub struct Unicode {
    pub café: u8,
    #[serde(rename = "\u{e9}t\x41\n\t")]
    pub escaped: u8,
    #[serde(rename = "line \
        continued")]
    pub continued: u8,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn lexer(
    a: BlockDoc,
    b: Comments,
    c: Unicode,
) -> u8 {
    let chars = ['\'', '"', '\\', '\u{1F600}', '\x7f', 'a'];
    let strings = ("\"}", r"}\", r##"a "# b"##, b"}", br#"}"#, c"}");
    let nums = (1u8, 0xFF_u8, 0o7, 0b1010, 1_000.5e-3_f64, 1e10, 1.0, 2., x.0.1);
    let label = 'a: { break 'a 1 };
    let ops = a >>= 1 != 2 && b <= c || ::std::mem::take(&mut d);
    0
}

fn run() { generate_handler![lexer] }
