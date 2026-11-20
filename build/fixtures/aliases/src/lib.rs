pub type Res<T> = std::result::Result<T, Error>;
pub type Res2<T, E = String> = Result<T, E>;
pub type Pair<A, B> = (A, B);
pub type Ids = Vec<u64>;
pub type Nested<T> = Res<Option<T>>;
pub type SelfRef = Vec<SelfRef>;
pub type Wrapped<T> = Page<T>;
pub type Unused<T> = T;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Error { NotFound { item_id: u64 }, Io(String) }

pub struct Page<T> { pub items: Vec<T>, pub next: Option<Box<Page<T>>> }
pub struct Wrapper<T, U> { pub t: T, pub u: Option<U> }
pub enum Either<L, R> { Left(L), Right(R) }

#[tauri::command]
fn alias_result() -> Res<Page<u8>> { todo!() }
#[tauri::command]
fn alias_default_param() -> Res2<u8> { todo!() }
#[tauri::command]
fn alias_both_params() -> Res2<u8, u32> { todo!() }
#[tauri::command]
fn alias_tuple(p: Pair<u8, String>) -> Pair<bool, Ids> { todo!() }
#[tauri::command]
fn alias_nested() -> Nested<Ids> { todo!() }
#[tauri::command]
fn alias_self_ref(s: SelfRef) -> SelfRef { todo!() }
#[tauri::command]
fn alias_wrapped(w: Wrapped<Wrapped<u8>>) -> Wrapped<Either<u8, String>> { todo!() }
#[tauri::command]
fn generics(w: Wrapper<u8, Vec<String>>, missing: Wrapper<u8>, e: Either<Page<bool>, ()>) -> Either<u8, Page<u8>> { todo!() }

fn run() {
    tauri::generate_handler![
        alias_result, alias_default_param, alias_both_params, alias_tuple,
        alias_nested, alias_self_ref, alias_wrapped, generics
    ]
}
