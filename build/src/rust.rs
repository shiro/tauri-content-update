//! Reads the app's commands from its sources: the commands registered with `generate_handler!`,
//! their canonical signatures (what the hashes are made of) and their TypeScript types.

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};

use proc_macro2::{Delimiter, TokenStream, TokenTree};
use quote::ToTokens;
use syn::{
    punctuated::Punctuated, visit::Visit, visit_mut::VisitMut, Attribute, Fields, FnArg,
    GenericArgument, ItemEnum, ItemFn, ItemStruct, ItemType, LitStr, Meta, Pat, PathArguments,
    ReturnType, Token, Type,
};

/// a command registered with `generate_handler!`
#[derive(Debug)]
pub struct Command {
    /// the name it is invoked with
    pub name: String,
    /// what its hash is made of: the command name, argument keys and the wire shapes of the
    /// argument, result and error types
    pub signature: String,
    /// `(js key, ts parameter name, ts type)`
    pub args: Vec<(String, String, String)>,
    /// the ts type the promise resolves to
    pub ret: String,
    pub docs: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Api {
    /// sorted by name
    pub commands: Vec<Command>,
    /// ts declarations of the custom types the commands use, by name
    pub types: BTreeMap<String, String>,
    /// a command takes a `tauri::ipc::Channel`
    pub uses_channel: bool,
}

/// reads all `.rs` files below `src`
pub fn scan(src: &Path) -> Result<Api, String> {
    let mut paths = Vec::new();
    collect_rs(src, &mut paths);
    paths.sort();
    let mut files = Vec::new();
    for path in paths {
        let code = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        files.push(syn::parse_file(&code).map_err(|e| format!("{}: {e}", path.display()))?);
    }
    analyze(&files)
}

fn collect_rs(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

// -------------------------------------------------------------------------------------------------
// collecting items

enum TypeItem<'a> {
    Struct(&'a ItemStruct),
    Enum(&'a ItemEnum),
    Alias(&'a ItemType),
}

#[derive(Default)]
struct Items<'a> {
    commands: HashMap<String, Vec<&'a ItemFn>>,
    types: HashMap<String, Vec<TypeItem<'a>>>,
    /// command paths of every `generate_handler![…]`
    handlers: Vec<syn::Path>,
    errors: Vec<String>,
}

impl<'a> Visit<'a> for Items<'a> {
    fn visit_item_fn(&mut self, f: &'a ItemFn) {
        if f.attrs.iter().any(is_command_attr) {
            self.commands
                .entry(ident(&f.sig.ident))
                .or_default()
                .push(f);
        }
        syn::visit::visit_item_fn(self, f);
    }

    fn visit_item_struct(&mut self, s: &'a ItemStruct) {
        let name = ident(&s.ident);
        self.types
            .entry(name)
            .or_default()
            .push(TypeItem::Struct(s));
    }

    fn visit_item_enum(&mut self, e: &'a ItemEnum) {
        let name = ident(&e.ident);
        self.types.entry(name).or_default().push(TypeItem::Enum(e));
    }

    fn visit_item_type(&mut self, t: &'a ItemType) {
        let name = ident(&t.ident);
        self.types.entry(name).or_default().push(TypeItem::Alias(t));
    }

    fn visit_macro(&mut self, m: &'a syn::Macro) {
        if m.path
            .segments
            .last()
            .is_some_and(|s| s.ident == "generate_handler")
        {
            match m.parse_body_with(Punctuated::<syn::Path, Token![,]>::parse_terminated) {
                Ok(paths) => self.handlers.extend(paths),
                Err(e) => self
                    .errors
                    .push(format!("can't read generate_handler![{}]: {e}", m.tokens)),
            }
        }
        syn::visit::visit_macro(self, m);
    }
}

fn is_command_attr(a: &Attribute) -> bool {
    a.path()
        .segments
        .last()
        .is_some_and(|s| s.ident == "command")
}

/// an identifier without its `r#`
fn ident(i: &syn::Ident) -> String {
    let s = i.to_string();
    s.strip_prefix("r#").map(String::from).unwrap_or(s)
}

pub fn analyze(files: &[syn::File]) -> Result<Api, String> {
    let mut items = Items::default();
    for f in files {
        items.visit_file(f);
    }
    if let Some(e) = items.errors.first() {
        return Err(e.clone());
    }
    let mut names: Vec<String> = items
        .handlers
        .iter()
        .filter_map(|p| p.segments.last().map(|s| ident(&s.ident)))
        .collect();
    names.sort();
    names.dedup();

    let mut cx = Cx {
        items: &items,
        api: Api::default(),
        stack: Vec::new(),
    };
    for name in names {
        let f = match items.commands.get(&name).map(Vec::as_slice) {
            Some([f]) => *f,
            Some(_) => return Err(format!("command `{name}` is defined more than once")),
            None => {
                return Err(format!(
                    "command `{name}` is registered with generate_handler! but no #[tauri::command] fn `{name}` was found in the app's sources"
                ))
            }
        };
        let command = cx.command(name, f)?;
        cx.api.commands.push(command);
    }
    Ok(cx.api)
}

// -------------------------------------------------------------------------------------------------
// commands and types

/// tauri injects these, they aren't sent by the frontend
const INJECTED: &[&str] = &[
    "AppHandle",
    "Window",
    "WebviewWindow",
    "Webview",
    "State",
    "Request",
    "CommandScope",
    "GlobalScope",
];

type Subst = HashMap<String, String>;

struct Cx<'a> {
    items: &'a Items<'a>,
    api: Api,
    /// custom types being expanded (recursion guard)
    stack: Vec<String>,
}

/// what a type is, for serialization
enum Shape<'t> {
    Prim(&'static str),
    Option(&'t Type),
    List(&'t Type),
    Map(&'t Type),
    Tuple(Vec<&'t Type>),
    Unit,
    Any,
    Channel(&'t Type),
    Result(&'t Type, Option<&'t Type>),
    /// a generic parameter
    Param(String),
    /// a struct/enum/alias defined in the app
    Custom(String, Vec<&'t Type>),
    /// anything else, by its path
    Opaque(String),
}

impl<'a> Cx<'a> {
    fn command(&mut self, name: String, f: &ItemFn) -> Result<Command, String> {
        let snake_keys = command_rename_all(f)?.is_some_and(|r| r == "snake_case");
        let mut sig_args = Vec::new();
        let mut args = Vec::new();
        for input in &f.sig.inputs {
            let FnArg::Typed(arg) = input else {
                return Err(format!("command `{name}` takes self"));
            };
            if injected(&arg.ty) {
                continue;
            }
            let Pat::Ident(pat) = &*arg.pat else {
                return Err(format!(
                    "command `{name}`: argument `{}` must be a plain identifier",
                    tokens(arg.pat.to_token_stream())
                ));
            };
            let rust_name = ident(&pat.ident);
            let key = if snake_keys {
                rust_name.clone()
            } else {
                rename("camelCase", &rust_name, false)
            };
            let canon = self.canon(&arg.ty, &Subst::new())?;
            sig_args.push(format!("{key}:{canon}"));
            let ts = self.ts(&arg.ty, &Subst::new())?;
            args.push((key, ts_param(&rename("camelCase", &rust_name, false)), ts));
        }
        let (ret_canon, ret) = match &f.sig.output {
            ReturnType::Default => ("null".to_string(), "void".to_string()),
            ReturnType::Type(_, ty) => (self.canon(ty, &Subst::new())?, self.ts_ret(ty)?),
        };
        Ok(Command {
            signature: format!("{name}({})->{ret_canon}", sig_args.join(",")),
            name,
            args,
            ret,
            docs: docs(&f.attrs),
        })
    }

    /// the ts type a command's promise resolves to: errors (`Result`) reject it
    fn ts_ret(&mut self, ty: &Type) -> Result<String, String> {
        let ty = self.unalias(ty, 0)?;
        Ok(match self.shape(&ty, &Subst::new())? {
            Shape::Unit => "void".into(),
            Shape::Result(ok, _) => return self.ts_ret(ok),
            _ => self.ts(&ty, &Subst::new())?,
        })
    }

    /// resolves the app's type aliases at the top of a type
    fn unalias(&self, ty: &Type, depth: usize) -> Result<Type, String> {
        if let Shape::Custom(name, args) = self.shape(ty, &Subst::new())? {
            if let TypeItem::Alias(a) = self.type_item(&name)? {
                if depth > 16 {
                    return Err(format!("type alias `{name}` is recursive"));
                }
                let params: HashMap<String, Type> = a
                    .generics
                    .type_params()
                    .map(|p| ident(&p.ident))
                    .zip(args.into_iter().cloned())
                    .collect();
                let mut out = (*a.ty).clone();
                SubstTypes(&params).visit_type_mut(&mut out);
                return self.unalias(&out, depth + 1);
            }
        }
        Ok(ty.clone())
    }

    fn shape<'t>(&self, ty: &'t Type, subst: &Subst) -> Result<Shape<'t>, String> {
        Ok(match ty {
            Type::Reference(r) => return self.shape(&r.elem, subst),
            Type::Paren(p) => return self.shape(&p.elem, subst),
            Type::Group(g) => return self.shape(&g.elem, subst),
            Type::Slice(s) => Shape::List(&s.elem),
            Type::Array(a) => Shape::List(&a.elem),
            Type::Tuple(t) if t.elems.is_empty() => Shape::Unit,
            Type::Tuple(t) => Shape::Tuple(t.elems.iter().collect()),
            Type::Path(p) if p.qself.is_none() => {
                let segs = &p.path.segments;
                let last = segs.last().ok_or("empty type path")?;
                let name = ident(&last.ident);
                let args: Vec<&Type> = match &last.arguments {
                    PathArguments::AngleBracketed(a) => a
                        .args
                        .iter()
                        .filter_map(|a| match a {
                            GenericArgument::Type(t) => Some(t),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                let local = segs.len() == 1
                    || matches!(
                        segs.first().map(|s| s.ident.to_string()).as_deref(),
                        Some("crate" | "self" | "super")
                    );
                if local && segs.len() == 1 && args.is_empty() && subst.contains_key(&name) {
                    return Ok(Shape::Param(name));
                }
                if local && self.items.types.contains_key(&name) {
                    return Ok(Shape::Custom(name, args));
                }
                let arg = |i: usize| args.get(i).copied();
                match (name.as_str(), arg(0)) {
                    ("String" | "str" | "char" | "PathBuf" | "Path" | "OsString", _) => {
                        Shape::Prim("string")
                    }
                    ("bool", _) => Shape::Prim("boolean"),
                    (
                        "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32"
                        | "i64" | "i128" | "isize" | "f32" | "f64",
                        _,
                    ) => Shape::Prim("number"),
                    ("Value", _) => Shape::Any,
                    ("Option", Some(t)) => Shape::Option(t),
                    (
                        "Vec" | "VecDeque" | "LinkedList" | "HashSet" | "BTreeSet" | "IndexSet",
                        Some(t),
                    ) => Shape::List(t),
                    ("HashMap" | "BTreeMap" | "IndexMap", Some(_)) if args.len() == 2 => {
                        Shape::Map(args[1])
                    }
                    ("Box" | "Arc" | "Rc" | "Cow", Some(t)) => return self.shape(t, subst),
                    ("Channel", Some(t)) => Shape::Channel(t),
                    ("Result", Some(t)) => Shape::Result(t, arg(1)),
                    _ => Shape::Opaque(tokens(ty.to_token_stream())),
                }
            }
            _ => Shape::Opaque(tokens(ty.to_token_stream())),
        })
    }

    fn type_item(&self, name: &str) -> Result<&'a TypeItem<'a>, String> {
        match self.items.types.get(name).map(Vec::as_slice) {
            Some([item]) => Ok(item),
            _ => Err(format!(
                "type `{name}` is defined more than once in the app's sources"
            )),
        }
    }

    // ---------------------------------------------------------------------------------------------
    // canonical form: the wire shape, independent of rust type names, docs and formatting. Part of
    // the hash format: changing it changes every hash.

    fn canon(&mut self, ty: &Type, subst: &Subst) -> Result<String, String> {
        Ok(match self.shape(ty, subst)? {
            Shape::Prim(p) => p.into(),
            Shape::Option(t) => format!("option<{}>", self.canon(t, subst)?),
            Shape::List(t) => format!("[{}]", self.canon(t, subst)?),
            Shape::Map(v) => format!("{{string:{}}}", self.canon(v, subst)?),
            Shape::Tuple(ts) => {
                let parts: Result<Vec<_>, _> = ts.iter().map(|t| self.canon(t, subst)).collect();
                format!("({})", parts?.join(","))
            }
            Shape::Unit => "null".into(),
            Shape::Any => "any".into(),
            Shape::Channel(t) => format!("channel<{}>", self.canon(t, subst)?),
            Shape::Result(ok, err) => {
                let err = match err {
                    Some(e) => self.canon(e, subst)?,
                    None => "?".into(),
                };
                format!("result<{},{err}>", self.canon(ok, subst)?)
            }
            Shape::Param(p) => subst[&p].clone(),
            Shape::Opaque(path) => format!("?{path}"),
            Shape::Custom(name, args) => {
                if self.stack.contains(&name) {
                    return Ok(format!("#{name}"));
                }
                let item = self.type_item(&name)?;
                let args: Result<Vec<String>, String> =
                    args.iter().map(|t| self.canon(t, subst)).collect();
                let args = args?;
                self.stack.push(name);
                let out = match item {
                    TypeItem::Struct(s) => {
                        let sub = bind(&s.generics, &args);
                        let fields = self.canon_fields(&s.fields, &sub)?;
                        format!("struct{{{};{fields}}}", serde_attrs(&s.attrs))
                    }
                    TypeItem::Enum(e) => {
                        let sub = bind(&e.generics, &args);
                        let mut variants = Vec::new();
                        for v in &e.variants {
                            let fields = self.canon_fields(&v.fields, &sub)?;
                            variants.push(format!(
                                "{}{}({fields})",
                                ident(&v.ident),
                                serde_attrs(&v.attrs)
                            ));
                        }
                        format!("enum{{{};{}}}", serde_attrs(&e.attrs), variants.join("|"))
                    }
                    TypeItem::Alias(a) => {
                        let sub = bind(&a.generics, &args);
                        self.canon(&a.ty, &sub)?
                    }
                };
                self.stack.pop();
                out
            }
        })
    }

    fn canon_fields(&mut self, fields: &Fields, subst: &Subst) -> Result<String, String> {
        let mut out = Vec::new();
        for f in fields {
            let name = f.ident.as_ref().map(|i| format!("{}:", ident(i)));
            out.push(format!(
                "{}{}{}",
                serde_attrs(&f.attrs),
                name.unwrap_or_default(),
                self.canon(&f.ty, subst)?
            ));
        }
        Ok(out.join(","))
    }

    // ---------------------------------------------------------------------------------------------
    // typescript

    fn ts(&mut self, ty: &Type, subst: &Subst) -> Result<String, String> {
        Ok(match self.shape(ty, subst)? {
            Shape::Prim(p) => p.into(),
            Shape::Option(t) => format!("{} | null", self.ts(t, subst)?),
            Shape::List(t) => {
                let inner = self.ts(t, subst)?;
                if inner.contains(' ') {
                    format!("({inner})[]")
                } else {
                    format!("{inner}[]")
                }
            }
            Shape::Map(v) => format!("Record<string, {}>", self.ts(v, subst)?),
            Shape::Tuple(ts) => {
                let parts: Result<Vec<_>, _> = ts.iter().map(|t| self.ts(t, subst)).collect();
                format!("[{}]", parts?.join(", "))
            }
            Shape::Unit => "null".into(),
            Shape::Any | Shape::Opaque(_) | Shape::Result(..) => "unknown".into(),
            Shape::Channel(t) => {
                self.api.uses_channel = true;
                format!("Channel<{}>", self.ts(t, subst)?)
            }
            Shape::Param(p) => subst[&p].clone(),
            Shape::Custom(name, args) => {
                let args: Result<Vec<String>, String> =
                    args.iter().map(|t| self.ts(t, subst)).collect();
                let args = args?;
                if let TypeItem::Alias(a) = self.type_item(&name)? {
                    if self.stack.contains(&name) {
                        return Ok("unknown".into());
                    }
                    self.stack.push(name);
                    let out = self.ts(&a.ty, &bind(&a.generics, &args));
                    self.stack.pop();
                    return out;
                }
                self.declare(&name)?;
                if args.is_empty() {
                    name
                } else {
                    format!("{name}<{}>", args.join(", "))
                }
            }
        })
    }

    /// adds the ts declaration of a struct/enum (once)
    fn declare(&mut self, name: &str) -> Result<(), String> {
        if self.api.types.contains_key(name) {
            return Ok(());
        }
        // placeholder first: recursive types refer to themselves
        self.api.types.insert(name.into(), String::new());
        let decl = match self.type_item(name)? {
            TypeItem::Struct(s) => self.ts_struct(s)?,
            TypeItem::Enum(e) => self.ts_enum(e)?,
            TypeItem::Alias(_) => unreachable!("aliases are inlined"),
        };
        self.api.types.insert(name.into(), decl);
        Ok(())
    }

    fn ts_struct(&mut self, s: &ItemStruct) -> Result<String, String> {
        let (params, sub) = ts_generics(&s.generics);
        let attrs = serde(&s.attrs);
        let head = format!(
            "{}export type {}{params} =",
            jsdoc(&docs(&s.attrs), ""),
            ident(&s.ident)
        );
        let body = match &s.fields {
            Fields::Unit => "null".to_string(),
            Fields::Unnamed(f) if f.unnamed.len() == 1 => self.ts(&f.unnamed[0].ty, &sub)?,
            Fields::Unnamed(f) => {
                let parts: Result<Vec<_>, _> =
                    f.unnamed.iter().map(|f| self.ts(&f.ty, &sub)).collect();
                format!("[{}]", parts?.join(", "))
            }
            Fields::Named(_) if attrs.transparent => {
                let f = s.fields.iter().find(|f| !serde(&f.attrs).skip);
                match f {
                    Some(f) => self.ts(&f.ty, &sub)?,
                    None => "null".into(),
                }
            }
            Fields::Named(_) => {
                self.ts_object(&s.fields, attrs.rename_all.as_deref(), &sub, None, false)?
            }
        };
        Ok(format!("{head} {body};\n"))
    }

    /// `{ key: T; … }` (& flattened types), `tag` is prepended to the members; `inline` puts it on
    /// one line (enum variants)
    fn ts_object(
        &mut self,
        fields: &Fields,
        rename_all: Option<&str>,
        sub: &Subst,
        tag: Option<String>,
        inline: bool,
    ) -> Result<String, String> {
        let mut members: Vec<(Vec<String>, String)> =
            tag.into_iter().map(|t| (vec![], t)).collect();
        let mut flattened = Vec::new();
        for f in fields {
            let a = serde(&f.attrs);
            if a.skip {
                continue;
            }
            if a.flatten {
                flattened.push(self.ts(&f.ty, sub)?);
                continue;
            }
            let rust_name = f.ident.as_ref().map(ident).unwrap_or_default();
            let key = a.rename.unwrap_or_else(|| {
                rename_all.map_or(rust_name.clone(), |r| rename(r, &rust_name, false))
            });
            let ty = self.ts(&f.ty, sub)?;
            let optional = if a.optional { "?" } else { "" };
            members.push((docs(&f.attrs), format!("{}{optional}: {ty}", ts_key(&key))));
        }
        let mut out = if inline {
            let m: Vec<_> = members.into_iter().map(|(_, m)| m).collect();
            format!("{{ {} }}", m.join("; "))
        } else {
            let mut out = String::from("{\n");
            for (doc, m) in members {
                out.push_str(&jsdoc(&doc, "  "));
                out.push_str(&format!("  {m};\n"));
            }
            out.push('}');
            out
        };
        for f in flattened {
            out.push_str(&format!(" & {f}"));
        }
        Ok(out)
    }

    fn ts_enum(&mut self, e: &ItemEnum) -> Result<String, String> {
        let (params, sub) = ts_generics(&e.generics);
        let attrs = serde(&e.attrs);
        let mut variants = Vec::new();
        for v in &e.variants {
            let va = serde(&v.attrs);
            if va.skip {
                continue;
            }
            let name = va.rename.clone().unwrap_or_else(|| {
                attrs
                    .rename_all
                    .as_deref()
                    .map_or(ident(&v.ident), |r| rename(r, &ident(&v.ident), true))
            });
            let lit = format!("{name:?}");
            let payload = match &v.fields {
                Fields::Unit => None,
                Fields::Unnamed(f) if f.unnamed.len() == 1 => {
                    Some(self.ts(&f.unnamed[0].ty, &sub)?)
                }
                Fields::Unnamed(f) => {
                    let parts: Result<Vec<_>, _> =
                        f.unnamed.iter().map(|f| self.ts(&f.ty, &sub)).collect();
                    Some(format!("[{}]", parts?.join(", ")))
                }
                Fields::Named(_) => {
                    Some(self.ts_object(&v.fields, va.rename_all.as_deref(), &sub, None, true)?)
                }
            };
            let named = matches!(v.fields, Fields::Named(_));
            variants.push(
                match (&attrs.tag, &attrs.content, attrs.untagged, payload) {
                    (_, _, true, None) => "null".into(),
                    (_, _, true, Some(p)) => p,
                    (Some(tag), Some(_), _, None) => format!("{{ {}: {lit} }}", ts_key(tag)),
                    (Some(tag), Some(content), _, Some(p)) => {
                        format!("{{ {}: {lit}; {}: {p} }}", ts_key(tag), ts_key(content))
                    }
                    (Some(tag), None, _, None) => format!("{{ {}: {lit} }}", ts_key(tag)),
                    (Some(tag), None, _, Some(_)) if named => self.ts_object(
                        &v.fields,
                        va.rename_all.as_deref(),
                        &sub,
                        Some(format!("{}: {lit}", ts_key(tag))),
                        true,
                    )?,
                    (Some(tag), None, _, Some(p)) => {
                        format!("({{ {}: {lit} }} & {p})", ts_key(tag))
                    }
                    (None, _, false, None) => lit,
                    (None, _, false, Some(p)) => format!("{{ {}: {p} }}", ts_key(&name)),
                },
            );
        }
        if variants.is_empty() {
            variants.push("never".into());
        }
        Ok(format!(
            "{}export type {}{params} =\n  | {};\n",
            jsdoc(&docs(&e.attrs), ""),
            ident(&e.ident),
            variants.join("\n  | ")
        ))
    }
}

/// replaces generic params in a type
struct SubstTypes<'p>(&'p HashMap<String, Type>);

impl VisitMut for SubstTypes<'_> {
    fn visit_type_mut(&mut self, ty: &mut Type) {
        if let Type::Path(p) = ty {
            if let Some(t) = p.path.get_ident().and_then(|i| self.0.get(&ident(i))) {
                *ty = t.clone();
                return;
            }
        }
        syn::visit_mut::visit_type_mut(self, ty);
    }
}

fn injected(ty: &Type) -> bool {
    match ty {
        Type::Reference(r) => injected(&r.elem),
        Type::Path(p) => p
            .path
            .segments
            .last()
            .is_some_and(|s| INJECTED.contains(&s.ident.to_string().as_str())),
        _ => false,
    }
}

/// `rename_all = "…"` of `#[tauri::command(…)]` (its other options, like `async`, aren't metas)
fn command_rename_all(f: &ItemFn) -> Result<Option<String>, String> {
    for a in f.attrs.iter().filter(|a| is_command_attr(a)) {
        let Meta::List(list) = &a.meta else {
            continue;
        };
        let tts: Vec<TokenTree> = list.tokens.clone().into_iter().collect();
        for w in tts.windows(3) {
            if let [TokenTree::Ident(i), TokenTree::Punct(p), TokenTree::Literal(l)] = w {
                if i == "rename_all" && p.as_char() == '=' {
                    let lit: LitStr = syn::parse_str(&l.to_string())
                        .map_err(|e| format!("#[command] of `{}`: {e}", f.sig.ident))?;
                    return Ok(Some(lit.value()));
                }
            }
        }
    }
    Ok(None)
}

/// generic params -> the given (canonical or ts) arguments
fn bind(generics: &syn::Generics, args: &[String]) -> Subst {
    generics
        .type_params()
        .enumerate()
        .map(|(i, p)| (ident(&p.ident), args.get(i).cloned().unwrap_or("?".into())))
        .collect()
}

/// `<T, U>` and the identity substitution for a declaration's own params
fn ts_generics(generics: &syn::Generics) -> (String, Subst) {
    let names: Vec<String> = generics.type_params().map(|p| ident(&p.ident)).collect();
    let sub = names.iter().map(|n| (n.clone(), n.clone())).collect();
    if names.is_empty() {
        (String::new(), sub)
    } else {
        (format!("<{}>", names.join(", ")), sub)
    }
}

// -------------------------------------------------------------------------------------------------
// attributes

/// the `#[serde(…)]` attributes, as stable token text
fn serde_attrs(attrs: &[Attribute]) -> String {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("serde"))
        .map(|a| format!("#[{}]", tokens(a.meta.to_token_stream())))
        .collect()
}

/// the serde attributes that change the ts types
#[derive(Default)]
struct Serde {
    rename: Option<String>,
    rename_all: Option<String>,
    tag: Option<String>,
    content: Option<String>,
    untagged: bool,
    transparent: bool,
    skip: bool,
    flatten: bool,
    /// `default` / `skip_serializing_if`: the key may be missing
    optional: bool,
}

fn serde(attrs: &[Attribute]) -> Serde {
    let mut s = Serde::default();
    for a in attrs.iter().filter(|a| a.path().is_ident("serde")) {
        let _ = a.parse_nested_meta(|meta| {
            let p = &meta.path;
            if p.is_ident("rename") || p.is_ident("rename_all") {
                let value = if meta.input.peek(Token![=]) {
                    Some(meta.value()?.parse::<LitStr>()?.value())
                } else {
                    // rename(serialize = "…", deserialize = "…"): the serialized name
                    let mut ser = None;
                    meta.parse_nested_meta(|m| {
                        let v = m.value()?.parse::<LitStr>()?.value();
                        if m.path.is_ident("serialize") {
                            ser = Some(v);
                        }
                        Ok(())
                    })?;
                    ser
                };
                if p.is_ident("rename") {
                    s.rename = value;
                } else {
                    s.rename_all = value;
                }
            } else if p.is_ident("tag") {
                s.tag = Some(meta.value()?.parse::<LitStr>()?.value());
            } else if p.is_ident("content") {
                s.content = Some(meta.value()?.parse::<LitStr>()?.value());
            } else if p.is_ident("untagged") {
                s.untagged = true;
            } else if p.is_ident("transparent") {
                s.transparent = true;
            } else if p.is_ident("skip") || p.is_ident("skip_serializing") {
                s.skip = true;
            } else if p.is_ident("flatten") {
                s.flatten = true;
            } else if p.is_ident("default") || p.is_ident("skip_serializing_if") {
                s.optional = true;
                skip_value(&meta)?;
            } else {
                skip_value(&meta)?;
            }
            Ok(())
        });
    }
    s
}

fn skip_value(meta: &syn::meta::ParseNestedMeta) -> syn::Result<()> {
    if meta.input.peek(Token![=]) {
        meta.value()?.parse::<syn::Expr>()?;
    } else if meta.input.peek(syn::token::Paren) {
        meta.parse_nested_meta(|m| skip_value(&m))?;
    }
    Ok(())
}

fn docs(attrs: &[Attribute]) -> Vec<String> {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("doc"))
        .filter_map(|a| match &a.meta {
            Meta::NameValue(nv) => match &nv.value {
                syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Str(s),
                    ..
                }) => Some(
                    s.value()
                        .strip_prefix(' ')
                        .map(String::from)
                        .unwrap_or(s.value()),
                ),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

pub fn jsdoc(lines: &[String], indent: &str) -> String {
    match lines {
        [] => String::new(),
        [line] => format!("{indent}/** {} */\n", line.replace("*/", "*\\/")),
        lines => {
            let mut out = format!("{indent}/**\n");
            for l in lines {
                out.push_str(
                    &format!("{indent} * {}\n", l.replace("*/", "*\\/")).replace(" \n", "\n"),
                );
            }
            out.push_str(&format!("{indent} */\n"));
            out
        }
    }
}

/// tokens as text, one space between tokens: independent of the source's formatting and of how a
/// proc-macro2 version prints token streams
fn tokens(ts: TokenStream) -> String {
    let mut out = Vec::new();
    for tt in ts {
        out.push(match tt {
            TokenTree::Ident(i) => i.to_string(),
            TokenTree::Punct(p) => p.as_char().to_string(),
            TokenTree::Literal(l) => l.to_string(),
            TokenTree::Group(g) => {
                let (open, close) = match g.delimiter() {
                    Delimiter::Parenthesis => ("(", ")"),
                    Delimiter::Brace => ("{", "}"),
                    Delimiter::Bracket => ("[", "]"),
                    Delimiter::None => ("", ""),
                };
                format!("{open}{}{close}", tokens(g.stream()))
            }
        });
    }
    out.join(" ")
}

// -------------------------------------------------------------------------------------------------
// names

/// serde's `rename_all` rules, for field (snake_case) or variant (PascalCase) names
pub fn rename(rule: &str, name: &str, variant: bool) -> String {
    let words: Vec<String> = if variant {
        let mut words = Vec::new();
        let mut cur = String::new();
        for c in name.chars() {
            if c.is_uppercase() && !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            cur.push(c);
        }
        words.push(cur);
        words.into_iter().map(|w| w.to_lowercase()).collect()
    } else {
        name.split('_').map(String::from).collect()
    };
    let cap = |w: &str| {
        let mut c = w.chars();
        c.next()
            .map(|f| f.to_uppercase().chain(c).collect::<String>())
            .unwrap_or_default()
    };
    match rule {
        "lowercase" if variant => name.to_lowercase(),
        "UPPERCASE" if variant => name.to_uppercase(),
        "lowercase" => name.into(),
        "UPPERCASE" => name.to_uppercase(),
        "PascalCase" => words.iter().map(|w| cap(w)).collect(),
        "camelCase" => {
            let pascal: String = words.iter().map(|w| cap(w)).collect();
            let mut c = pascal.chars();
            c.next()
                .map(|f| f.to_lowercase().chain(c).collect())
                .unwrap_or_default()
        }
        "snake_case" => words.join("_"),
        "SCREAMING_SNAKE_CASE" => words.join("_").to_uppercase(),
        "kebab-case" => words.join("-"),
        "SCREAMING-KEBAB-CASE" => words.join("-").to_uppercase(),
        _ => name.into(),
    }
}

const RESERVED: &[&str] = &[
    "arguments",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "eval",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
];

/// a valid ts parameter name
fn ts_param(name: &str) -> String {
    if RESERVED.contains(&name) {
        format!("{name}_")
    } else {
        name.into()
    }
}

/// an object key, quoted if needed
fn ts_key(key: &str) -> String {
    let ident = key
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if ident {
        key.into()
    } else {
        format!("{key:?}")
    }
}
