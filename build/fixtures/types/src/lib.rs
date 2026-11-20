use std::collections::*;
use std::sync::Arc;

pub struct Local { pub a: u8 }
pub mod nested { pub struct Local2 { pub b: u8 } }

#[derive(Serialize)]
pub struct Everything<'a, T: Clone + 'a, const N: usize> {
    pub s: String,
    pub r: &'a str,
    pub c: char,
    pub path: std::path::PathBuf,
    pub os: std::ffi::OsString,
    pub b: bool,
    pub ints: (u8, u16, u32, u64, u128, usize),
    pub sints: (i8, i16, i32, i64, i128, isize),
    pub floats: (f32, f64),
    pub value: serde_json::Value,
    pub opt: Option<Option<u8>>,
    pub opt_list: Vec<Option<u8>>,
    pub lists: (Vec<u8>, VecDeque<u8>, LinkedList<u8>, HashSet<u8>, BTreeSet<u8>, indexmap::IndexSet<u8>),
    pub maps: (HashMap<String, u8>, BTreeMap<u32, Vec<u8>>, indexmap::IndexMap<String, Local>),
    pub map_one_arg: HashMap<String>,
    pub smart: (Box<u8>, Arc<str>, std::rc::Rc<String>, Cow<'a, str>, Box<[u8]>),
    pub slice: &'a [u8],
    pub mut_ref: &'a mut Vec<u8>,
    pub array: [u8; 32],
    pub array_expr: [Local; N * 2],
    pub tuple1: (u8,),
    pub unit: (),
    pub paren: (u8),
    pub generic: T,
    pub generic_list: Vec<T>,
    pub crate_path: crate::Local,
    pub self_path: self::Local,
    pub super_path: super::Local,
    pub foreign_path: other::Local,
    pub nested_path: nested::Local2,
    pub nested_local: Local2,
    pub duration: std::time::Duration,
    pub with_lifetime: Foo<'a, T>,
    pub turbofish: Vec::<u8>,
    pub leading: ::std::string::String,
    pub dyn_box: Box<dyn std::error::Error + Send + Sync + 'static>,
    pub bare_trait: Box<Error + Send>,
    pub impl_trait: impl Iterator<Item = u8>,
    pub fn_ptr: fn(u8) -> u8,
    pub unsafe_fn: unsafe extern "C" fn(*const u8),
    pub hr_fn: for<'b> fn(&'b u8) -> &'b u8,
    pub hr_trait: Box<dyn for<'b> Fn(&'b u8) -> u8>,
    pub ptr: *mut u8,
    pub never: !,
    pub infer: Vec<_>,
    pub qself: <T as Iterator>::Item,
    pub assoc: T::Output,
    pub macro_type: my_macro!(u8),
    pub option_bare: Option,
    pub result: Result<u8, String>,
    pub io_result: std::io::Result<u8>,
    pub const_arg: Array<u8, 3>,
    pub bool_arg: Flag<true>,
    pub block_arg: Array<u8, { 1 + 2 }>,
    pub channel_field: tauri::ipc::Channel<u8>,
    pub raw_type: r#Local,
    pub fn_trait: Box<dyn FnMut(u8, String) -> Result<(), String> + Send>,
    pub nested_generic: Vec<HashMap<String, Vec<(u8, Option<String>)>>>,
}

pub struct Tree { pub children: Vec<Tree>, pub parent: Option<Box<Tree>> }
pub struct A { pub b: Option<Box<B>> }
pub struct B { pub a: Vec<A> }

#[tauri::command(rename_all = "snake_case")]
pub async fn everything(
    app_handle: tauri::AppHandle<tauri::Wry>,
    window: tauri::Window,
    webview_window: WebviewWindow,
    webview: &tauri::Webview,
    state: State<'_, Mutex<u8>>,
    request: tauri::ipc::Request<'_>,
    scope: CommandScope<Foo>,
    global: GlobalScope<Foo>,
    all_types: Everything<'static, Local, 4>,
    mut tree: Tree,
    ref a_ref: A,
    r#type: String,
    default: u8,
    function: bool,
    plain_name: u8,
) -> Result<Vec<Option<(u8, String)>>, Error> {
    todo!()
}

#[tauri::command]
fn returns_unit() -> () {}
#[tauri::command]
fn returns_result_unit() -> Result<(), String> { Ok(()) }
#[tauri::command]
fn returns_io_result() -> std::io::Result<String> { todo!() }
#[tauri::command]
fn returns_opaque() -> tauri::ipc::Response { todo!() }
#[tauri::command]
fn returns_box() -> Box<Result<u8, String>> { todo!() }
#[tauri::command]
fn returns_ref<'a>(x: &'a str) -> &'a str { x }
#[tauri::command]
fn returns_list() -> Vec<String> { vec![] }
#[tauri::command]
fn returns_impl() -> impl Serialize { 1 }
#[tauri::command]
fn returns_value() -> serde_json::Value { todo!() }
#[tauri::command]
fn generic_fn<R: tauri::Runtime, T>(app: AppHandle<R>, value: u8) -> Result<u8, String> where T: Clone { todo!() }
#[tauri::command]
fn channel_arg(on_progress: tauri::ipc::Channel<Progress>, on_raw: Channel<Vec<u8>>) {}
#[tauri::command]
fn result_arg(r: Result<u8, String>, tuple_arg: (u8, String), list_of_options: Vec<Option<String>>) {}

pub struct Progress { pub done: u64, pub total: Option<u64> }

fn run() {
    let handler = tauri::generate_handler![
        everything,
        returns_unit,
        returns_result_unit,
        returns_io_result,
        returns_opaque,
        returns_box,
        returns_ref,
        returns_list,
        returns_impl,
        returns_value,
        generic_fn,
        channel_arg,
        result_arg,
    ];
}
