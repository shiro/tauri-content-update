// Typed TypeScript bindings of a tauri app's commands: a JS port of `tauri-plugin-content-update-build`
// (build/src/rust.rs + render() of build/src/lib.rs), so the bindings can be generated
// before the frontend is built (`content-update bindings`, run in the app's `beforeBuildCommand`), while the
// app's build.rs keeps regenerating them on every cargo build and computing the hashes the app
// provides. Both must produce byte-identical output for the same sources: the build crate's tests and
// lib/bindings.test.mjs check the shared cases in build/fixtures against the same expected
// files.
//
// Reads the sources like syn does for the subset that matters: the token rules of proc-macro2, the
// items `syn::visit` reaches (items in modules and blocks, not in macro bodies or attributes) and
// the shapes of the types used by the registered commands. It doesn't validate the Rust code: on
// invalid code (which cargo rejects anyway) the output is unspecified.
import fs from "node:fs";
import path from "node:path";
import { nativeApiHash } from "./bundle.mjs";

/** prefix of the ids in the bindings: `native-api:<command>:<hash>` */
export const MARKER = "native-api";

class RustSyntaxError extends Error {}

// -------------------------------------------------------------------------------------------------
// tokens (proc-macro2's fallback lexer)

const OP = "~!@#$%^&*-=+|;:,<.>/?'";
const CLOSE = { "(": ")", "[": "]", "{": "}" };
const ID_START = /^[\p{XID_Start}_]$/u;
const ID_CONTINUE = /^\p{XID_Continue}$/u;
const WHITESPACE = /^[\p{White_Space}‎‏]$/u;

/**
 * Token trees: `{ k: "ident" | "punct" | "lit", s }` (`joint` for puncts directly followed by
 * another punct, `str` for doc comments: their value) and `{ k: "group", d: "(" | "[" | "{", t }`.
 */
export function tokenize(src) {
  if (src.startsWith("﻿")) src = src.slice(1);
  // a shebang line, not an inner attribute
  if (src.startsWith("#!") && !/^#!\s*\[/.test(src)) {
    const nl = src.indexOf("\n");
    src = nl < 0 ? "" : src.slice(nl);
  }
  const stack = [];
  let toks = [];
  let i = 0;
  const at = (j) => {
    const c = src.codePointAt(j);
    return c === undefined ? "" : String.fromCodePoint(c);
  };
  const is = (re, j) => j < src.length && re.test(src[j]);
  const fail = (msg) => {
    throw new RustSyntaxError(
      `${msg} (line ${src.slice(0, i).split("\n").length})`,
    );
  };
  const identEnd = (j) => {
    while (j < src.length && ID_CONTINUE.test(at(j))) j += at(j).length;
    return j;
  };
  const lit = (end) => {
    toks.push({ k: "lit", s: src.slice(i, identEnd(end)) });
    i = identEnd(end);
  };
  const doc = (value, inner) => {
    toks.push({ k: "punct", s: "#", joint: false });
    if (inner) toks.push({ k: "punct", s: "!", joint: false });
    toks.push({
      k: "group",
      d: "[",
      t: [
        { k: "ident", s: "doc" },
        { k: "punct", s: "=", joint: false },
        { k: "lit", s: debugStr(value), str: value },
      ],
    });
  };
  const sticky = (re) => {
    re.lastIndex = i;
    return re.exec(src);
  };

  while (i < src.length) {
    const c = at(i);
    if (WHITESPACE.test(c)) {
      i += c.length;
      continue;
    }
    if (src.startsWith("//", i)) {
      let end = src.indexOf("\n", i);
      if (end < 0) end = src.length;
      let text = src.slice(i, end);
      if (end < src.length && text.endsWith("\r")) text = text.slice(0, -1);
      if (text.startsWith("//!")) doc(text.slice(3), true);
      else if (text.startsWith("///") && !text.startsWith("////"))
        doc(text.slice(3), false);
      i = end;
      continue;
    }
    if (src.startsWith("/*", i)) {
      if (src.startsWith("/**/", i)) {
        i += 4;
        continue;
      }
      let depth = 0;
      let j = i;
      for (;;) {
        if (j + 1 >= src.length) fail("unterminated block comment");
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      const text = src.slice(i, j);
      if (text.startsWith("/*!")) doc(text.slice(3, -2), true);
      else if (text.startsWith("/**") && !text.startsWith("/***"))
        doc(text.slice(3, -2), false);
      i = j;
      continue;
    }
    let m;
    // raw (byte/c) strings
    if ((m = sticky(/[bc]?r(#*)"/y))) {
      const close = `"${m[1]}`;
      const end = src.indexOf(close, i + m[0].length);
      if (end < 0) fail("unterminated raw string");
      lit(end + close.length);
      continue;
    }
    // (byte/c) strings
    if ((m = sticky(/[bc]?"/y))) {
      let j = i + m[0].length;
      while (src[j] !== '"') {
        if (j >= src.length) fail("unterminated string");
        j += src[j] === "\\" ? 2 : 1;
      }
      lit(j + 1);
      continue;
    }
    // chars (and byte chars) or lifetimes
    if (c === "'" || src.startsWith("b'", i)) {
      const q = c === "'" ? i : i + 1;
      if (src[q + 1] === "\\") {
        let j = q + 2;
        j += at(j).length;
        while (j < src.length && src[j] !== "'") j++;
        if (j >= src.length) fail("unterminated character literal");
        lit(j + 1);
        continue;
      }
      const ch = at(q + 1);
      if (ch && src[q + 1 + ch.length] === "'") {
        lit(q + 2 + ch.length);
        continue;
      }
      if (c === "'") {
        // a lifetime: `'` + ident
        toks.push({ k: "punct", s: "'", joint: true });
        i++;
        continue;
      }
    }
    if (src.startsWith("r#", i) && ID_START.test(at(i + 2))) {
      const end = identEnd(i + 2);
      toks.push({ k: "ident", s: src.slice(i, end) });
      i = end;
      continue;
    }
    if (ID_START.test(c)) {
      const end = identEnd(i);
      toks.push({ k: "ident", s: src.slice(i, end) });
      i = end;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (sticky(/0[xob]/y)) {
        j += 2;
        while (is(/[0-9a-fA-F_]/, j)) j++;
      } else {
        while (is(/[0-9_]/, j)) j++;
        if (
          src[j] === "." &&
          src[j + 1] !== "." &&
          !ID_START.test(at(j + 1) || " ")
        ) {
          j++;
          while (is(/[0-9_]/, j)) j++;
        }
        const exp = /[eE][+-]?[0-9_]*[0-9]/y;
        exp.lastIndex = j;
        if (exp.exec(src)) j = exp.lastIndex;
      }
      lit(j);
      continue;
    }
    if (OP.includes(c)) {
      toks.push({ k: "punct", s: c, joint: OP.includes(src[i + 1] ?? "\0") });
      i++;
      continue;
    }
    if (CLOSE[c]) {
      stack.push({ d: c, toks });
      toks = [];
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const open = stack.pop();
      if (!open || CLOSE[open.d] !== c) fail(`unexpected \`${c}\``);
      open.toks.push({ k: "group", d: open.d, t: toks });
      toks = open.toks;
      i++;
      continue;
    }
    fail(`unexpected character \`${c}\``);
  }
  if (stack.length) fail(`unclosed \`${stack.at(-1).d}\``);
  return toks;
}

/** tokens as text, one space between tokens (like `tokens()` of rust.rs) */
function tokens(toks) {
  return toks
    .map((t) => (t.k === "group" ? `${t.d}${tokens(t.t)}${CLOSE[t.d]}` : t.s))
    .join(" ");
}

/** rust's `{:?}` of a str */
function debugStr(s) {
  let out = '"';
  for (const ch of s) {
    const esc = {
      "\0": "\\0",
      "\t": "\\t",
      "\r": "\\r",
      "\n": "\\n",
      "\\": "\\\\",
      '"': '\\"',
    }[ch];
    if (esc) out += esc;
    else if (
      /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Mn}\p{Me}]$/u.test(ch)
    )
      out += `\\u{${ch.codePointAt(0).toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** the value of a string literal token (`"…"`, `r#"…"#`), null for other tokens (like syn's LitStr) */
function litStr(t) {
  if (t?.k !== "lit") return null;
  if (t.str !== undefined) return t.str;
  const s = t.s;
  const raw = /^r(#*)"/.exec(s);
  if (raw) return s.slice(raw[0].length, s.lastIndexOf('"'));
  if (s[0] !== '"') return null;
  let out = "";
  let j = 1;
  while (s[j] !== '"') {
    if (s[j] === "\\") {
      const b = s[j + 1];
      j += 2;
      if (b === "x") {
        out += String.fromCharCode(parseInt(s.slice(j, j + 2), 16));
        j += 2;
      } else if (b === "u") {
        const end = s.indexOf("}", j);
        out += String.fromCodePoint(
          parseInt(s.slice(j + 1, end).replaceAll("_", ""), 16),
        );
        j = end + 1;
      } else if (b === "\n" || b === "\r") {
        while (" \t\n\r".includes(s[j])) j++;
      } else {
        out += {
          n: "\n",
          r: "\r",
          t: "\t",
          "\\": "\\",
          0: "\0",
          "'": "'",
          '"': '"',
        }[b];
      }
    } else if (s[j] === "\r" && s[j + 1] === "\n") {
      out += "\n";
      j += 2;
    } else {
      const ch = String.fromCodePoint(s.codePointAt(j));
      out += ch;
      j += ch.length;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// parsing

const isP = (t, s) => t?.k === "punct" && t.s === s;
const isG = (t, d) => t?.k === "group" && t.d === d;
const isI = (t, s) => t?.k === "ident" && t.s === s;

/** an identifier without its `r#` */
const ident = (s) => (s.startsWith("r#") ? s.slice(2) : s);

const KEYWORDS = new Set(
  (
    "as async await break const continue crate dyn else enum extern false fn for if impl in let " +
    "loop match mod move mut pub ref return self Self static struct super trait true type unsafe " +
    "use where while abstract become box do final macro override priv typeof unsized virtual " +
    "yield try gen"
  ).split(" "),
);

class Cursor {
  constructor(toks) {
    this.toks = toks;
    this.i = 0;
  }
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  eof() {
    return this.i >= this.toks.length;
  }
  next() {
    return this.toks[this.i++];
  }
  p(s, o = 0) {
    return isP(this.peek(o), s);
  }
  /** `::` */
  colon2(o = 0) {
    return this.p(":", o) && this.peek(o).joint && this.p(":", o + 1);
  }
  /** `->` */
  arrow(o = 0) {
    return this.p("-", o) && this.peek(o).joint && this.p(">", o + 1);
  }
  fail(msg) {
    const t = this.peek();
    throw new RustSyntaxError(
      `${msg}, found ${t ? `\`${tokens([t])}\`` : "the end"}`,
    );
  }
  expect(s) {
    if (!this.p(s)) this.fail(`expected \`${s}\``);
    this.next();
  }
  /** skips `<…>` */
  angles() {
    let depth = 0;
    do {
      if (this.eof()) this.fail("expected `>`");
      if (this.arrow()) this.i++;
      else if (this.p("<")) depth++;
      else if (this.p(">")) depth--;
      this.next();
    } while (depth > 0);
  }
  /** skips to (not past) the first token at angle depth 0 for which `stop` is true */
  skipTo(stop) {
    let depth = 0;
    while (!this.eof() && !(depth === 0 && stop(this))) {
      if (this.arrow()) this.i++;
      else if (this.p("<")) depth++;
      else if (this.p(">")) depth--;
      this.next();
    }
  }
}

/** a type, like syn::Type: `{ t, toks, … }` */
function parseType(c, allowPlus = true) {
  const start = c.i;
  const done = (node) => {
    node.toks = c.toks.slice(start, c.i);
    return node;
  };
  const other = () => done({ t: "other" });
  const t = c.peek();
  if (!t) c.fail("expected a type");
  if (isG(t, "(")) {
    c.next();
    const s = new Cursor(t.t);
    const elems = [];
    let trailing = false;
    while (!s.eof()) {
      elems.push(parseType(s, true));
      if (s.eof()) break;
      s.expect(",");
      trailing = true;
      if (!s.eof()) trailing = false;
    }
    if (elems.length === 1 && !trailing) {
      if (allowPlus && c.p("+")) {
        c.next();
        bounds(c, true);
        return other();
      }
      return done({ t: "paren", elem: elems[0] });
    }
    return done({ t: "tuple", elems });
  }
  if (isG(t, "[")) {
    c.next();
    const s = new Cursor(t.t);
    const elem = parseType(s, true);
    if (s.eof()) return done({ t: "slice", elem });
    s.expect(";");
    return done({ t: "array", elem });
  }
  if (isP(t, "&")) {
    c.next();
    if (c.p("'")) c.i += 2;
    if (isI(c.peek(), "mut")) c.next();
    return done({ t: "ref", elem: parseType(c, false) });
  }
  if (isP(t, "*")) {
    c.i += 2;
    parseType(c, false);
    return other();
  }
  if (isP(t, "!")) {
    c.next();
    return other();
  }
  if (isP(t, "<")) {
    // a qualified path `<T as Trait>::Name`
    c.angles();
    while (c.colon2()) {
      c.i += 2;
      segment(c, true);
    }
    return other();
  }
  if (t.k === "ident" || c.colon2()) {
    if (isI(t, "_")) {
      c.next();
      return other();
    }
    if (isI(t, "dyn") || isI(t, "impl")) {
      c.next();
      bounds(c, allowPlus);
      return other();
    }
    if (["fn", "unsafe", "extern", "for"].includes(t.s)) {
      if (isI(t, "for")) {
        c.next();
        c.angles();
        if (!["fn", "unsafe", "extern"].includes(c.peek()?.s)) {
          bounds(c, allowPlus);
          return other();
        }
      }
      bareFn(c);
      return other();
    }
    const p = parsePath(c, true);
    if (c.p("!") && c.peek(1)?.k === "group") {
      c.i += 2;
      return other();
    }
    if (allowPlus && c.p("+")) {
      c.next();
      bounds(c, true);
      return other();
    }
    return done({ t: "path", ...p });
  }
  c.fail("expected a type");
}

function bareFn(c) {
  if (isI(c.peek(), "unsafe")) c.next();
  if (isI(c.peek(), "extern")) {
    c.next();
    if (c.peek()?.k === "lit") c.next();
  }
  if (!isI(c.peek(), "fn")) c.fail("expected `fn`");
  c.next();
  if (!isG(c.peek(), "(")) c.fail("expected `(`");
  c.next();
  if (c.arrow()) {
    c.i += 2;
    parseType(c, false);
  }
}

/** trait bounds `A + 'a + ?Sized + …` */
function bounds(c, allowPlus) {
  for (;;) {
    if (c.p("'")) c.i += 2;
    else if (isG(c.peek(), "(")) c.next();
    else {
      if (c.p("?")) c.next();
      if (c.p("~")) c.i += 2;
      if (isI(c.peek(), "const") || isI(c.peek(), "async")) c.next();
      if (isI(c.peek(), "for")) {
        c.next();
        c.angles();
      }
      parsePath(c, true);
    }
    if (!allowPlus || !c.p("+")) return;
    c.next();
    const n = c.peek();
    if (
      !n ||
      isP(n, ",") ||
      isP(n, ">") ||
      isP(n, "=") ||
      isP(n, ";") ||
      isG(n, "{")
    )
      return;
  }
}

/** a path (`{ segs: [{ ident, args, paren }], leading }`); `paren`: `Fn(A) -> B` arguments */
function parsePath(c, paren) {
  const leading = c.colon2();
  if (leading) c.i += 2;
  const segs = [];
  for (;;) {
    segs.push(segment(c, paren));
    if (c.colon2() && (c.peek(2)?.k === "ident" || c.p("<", 2))) {
      c.i += 2;
      continue;
    }
    return { segs, leading };
  }
}

function segment(c, paren) {
  const id = c.next();
  if (id?.k !== "ident") {
    c.i--;
    c.fail("expected an identifier");
  }
  const seg = { ident: id.s, args: null, paren: false };
  if (c.colon2() && c.p("<", 2)) c.i += 2;
  if (c.p("<") && !(c.peek().joint && c.p("=", 1))) seg.args = angleArgs(c);
  else if (paren && isG(c.peek(), "(")) {
    c.next();
    seg.args = [];
    seg.paren = true;
    if (c.arrow()) {
      c.i += 2;
      parseType(c, false);
    }
  }
  return seg;
}

/** `<…>` generic arguments: `{ k: "type", ty }` or `{ k: "other" }` (lifetimes, consts, bindings) */
function angleArgs(c) {
  c.expect("<");
  const args = [];
  for (;;) {
    if (c.p(">")) {
      c.next();
      return args;
    }
    const t = c.peek();
    if (isP(t, "'")) {
      c.i += 2;
      args.push({ k: "other" });
    } else if (
      t?.k === "lit" ||
      isI(t, "true") ||
      isI(t, "false") ||
      isG(t, "{")
    ) {
      c.next();
      args.push({ k: "other" });
    } else if (isP(t, "-")) {
      c.i += 2;
      args.push({ k: "other" });
    } else {
      const ty = parseType(c, true);
      if (c.p("=") && !(c.peek().joint && c.p("=", 1))) {
        c.next();
        if (isG(c.peek(), "{") || c.peek()?.k === "lit") c.next();
        else parseType(c, true);
        args.push({ k: "other" });
      } else if (c.p(":") && !c.colon2()) {
        c.next();
        bounds(c, true);
        args.push({ k: "other" });
      } else args.push({ k: "type", ty });
    }
    if (c.p(",")) c.next();
    else if (!c.p(">")) c.fail("expected `,` or `>`");
  }
}

/** the type parameter names of `<…>` (not lifetimes or consts) */
function genericsDecl(c) {
  if (!c.p("<")) return [];
  const start = c.i;
  c.angles();
  const inner = c.toks.slice(start + 1, c.i - 1);
  const names = [];
  let depth = 0;
  let param = [];
  const flush = () => {
    let k = 0;
    while (isP(param[k], "#") && isG(param[k + 1], "[")) k += 2;
    const t = param[k];
    if (t?.k === "ident" && t.s !== "const") names.push(ident(t.s));
    param = [];
  };
  for (let k = 0; k < inner.length; k++) {
    const t = inner[k];
    if (isP(t, "-") && t.joint && isP(inner[k + 1], ">")) {
      param.push(t, inner[++k]);
      continue;
    }
    if (isP(t, "<")) depth++;
    else if (isP(t, ">")) depth--;
    else if (isP(t, ",") && depth === 0) {
      flush();
      continue;
    }
    param.push(t);
  }
  if (param.length) flush();
  return names;
}

/** `#[…]`: `{ segs, leading, kind: "path" | "list" | "nv", list, value, meta }` */
function parseAttr(meta) {
  const c = new Cursor(meta);
  const attr = {
    segs: [],
    leading: false,
    kind: "path",
    list: null,
    value: null,
    meta,
  };
  try {
    if (isI(c.peek(), "unsafe") && isG(c.peek(1), "("))
      return parseAttr(c.peek(1).t);
    const p = parsePath(c, false);
    attr.segs = p.segs.map((s) => s.ident);
    attr.leading = p.leading;
  } catch (e) {
    if (e instanceof RustSyntaxError) return attr;
    throw e;
  }
  if (c.peek()?.k === "group") {
    attr.kind = "list";
    attr.list = c.peek().t;
  } else if (c.p("=")) {
    attr.kind = "nv";
    attr.value = c.toks.slice(c.i + 1);
  }
  return attr;
}

const attrIs = (a, name) =>
  !a.leading && a.segs.length === 1 && a.segs[0] === name;
const isCommandAttr = (a) => a.segs.at(-1) === "command";

function outerAttrs(c) {
  const attrs = [];
  while (c.p("#") && isG(c.peek(1), "[")) {
    attrs.push(parseAttr(c.peek(1).t));
    c.i += 2;
  }
  return attrs;
}

function visibility(c) {
  if (!isI(c.peek(), "pub")) return;
  c.next();
  const g = c.peek();
  if (
    isG(g, "(") &&
    (isI(g.t[0], "in") ||
      (g.t.length === 1 && ["crate", "self", "super"].includes(g.t[0]?.s)))
  )
    c.next();
}

// -------------------------------------------------------------------------------------------------
// collecting items (what `syn::visit` reaches)

const QUALIFIERS = new Set([
  "pub",
  "const",
  "async",
  "unsafe",
  "extern",
  "default",
  "safe",
]);

class Items {
  /** name -> [{ name, sig, attrs }] of the `#[command]` fns */
  commands = new Map();
  /** name -> [{ kind, toks, attrs }] of every struct, enum and type alias */
  types = new Map();
  /** command names of every `generate_handler![…]` */
  handlers = [];
  errors = [];

  add(map, name, item) {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(item);
  }
}

/** the index of the first token at angle depth 0 for which `stop` is true (or `toks.length`) */
function findTop(toks, from, stop) {
  const c = new Cursor(toks);
  c.i = from;
  c.skipTo(stop);
  return c.i;
}

/**
 * Visits the items and macros of a token list: `block` = a file, module or block (statements and
 * expressions), `assoc` = an impl/trait body, `foreign` = an extern block.
 */
function scanBlock(toks, mode, items) {
  let attrs = [];
  for (let i = 0; i < toks.length;) {
    const [t, n1, n2] = [toks[i], toks[i + 1], toks[i + 2]];
    if (isP(t, "#") && isG(n1, "[")) {
      attrs.push(parseAttr(n1.t));
      i += 2;
      continue;
    }
    if (isP(t, "#") && isP(n1, "!") && isG(n2, "[")) {
      i += 3;
      continue;
    }
    if (t.k === "ident") {
      const s = t.s;
      if (
        s === "macro_rules" &&
        isP(n1, "!") &&
        n2?.k === "ident" &&
        toks[i + 3]?.k === "group"
      ) {
        i += 4;
        attrs = [];
        continue;
      }
      if (s === "fn" && n1?.k === "ident") {
        i = fnItem(toks, i, attrs, mode, items);
        attrs = [];
        continue;
      }
      if (
        mode === "block" &&
        n1?.k === "ident" &&
        ["struct", "enum", "type"].includes(s)
      ) {
        const end =
          findTop(toks, i + 2, (c) =>
            s === "type" ? c.p(";") : c.p(";") || isG(c.peek(), "{"),
          ) + 1;
        // `type X;` isn't a type alias
        if (s !== "type" || toks.slice(i, end).some((x) => isP(x, "="))) {
          items.add(items.types, ident(n1.s), {
            kind: s,
            toks: toks.slice(i, end),
            attrs,
          });
        }
        i = end;
        attrs = [];
        continue;
      }
      if (mode === "block" && (s === "impl" || s === "trait")) {
        const end = findTop(toks, i + 1, (c) => c.p(";") || isG(c.peek(), "{"));
        if (end < toks.length) {
          scanBlock(toks.slice(i + 1, end), "block", items);
          if (isG(toks[end], "{")) scanBlock(toks[end].t, "assoc", items);
          i = end + 1;
          attrs = [];
          continue;
        }
      }
      if (mode === "block" && s === "extern") {
        const j = toks[i + 1]?.k === "lit" ? i + 2 : i + 1;
        if (isG(toks[j], "{")) {
          scanBlock(toks[j].t, "foreign", items);
          i = j + 1;
          attrs = [];
          continue;
        }
      }
      if (QUALIFIERS.has(s)) {
        i++;
        if (s === "pub") {
          const c = new Cursor(toks);
          c.i = i - 1;
          visibility(c);
          i = c.i;
        }
        if (s === "extern" && toks[i]?.k === "lit") i++;
        continue;
      }
      if (!KEYWORDS.has(s) && isP(n1, "!") && n2?.k === "group") {
        macro(s, n2, items);
        i += 3;
        attrs = [];
        continue;
      }
    } else if (t.k === "group") {
      scanBlock(t.t, "block", items);
    }
    attrs = [];
    i++;
  }
}

function fnItem(toks, i, attrs, mode, items) {
  const name = toks[i + 1].s;
  const end = findTop(toks, i + 2, (c) => c.p(";") || isG(c.peek(), "{"));
  const sig = toks.slice(i + 2, end);
  scanBlock(sig, "block", items);
  const body = isG(toks[end], "{") ? toks[end].t : null;
  if (body) {
    // inner attributes of the body are attributes of the fn
    const all = [...attrs];
    let k = 0;
    while (
      isP(body[k], "#") &&
      isP(body[k + 1], "!") &&
      isG(body[k + 2], "[")
    ) {
      all.push(parseAttr(body[k + 2].t));
      k += 3;
    }
    if (mode === "block" && all.some(isCommandAttr)) {
      items.add(items.commands, ident(name), { name, sig, attrs: all });
    }
    scanBlock(body.slice(k), "block", items);
  }
  return end + 1;
}

function macro(name, group, items) {
  if (name !== "generate_handler") return;
  const c = new Cursor(group.t);
  const names = [];
  try {
    while (!c.eof()) {
      const p = parsePath(c, false);
      if (
        p.segs.some(
          (s) =>
            KEYWORDS.has(s.ident) &&
            !["self", "super", "crate"].includes(s.ident),
        )
      )
        throw new RustSyntaxError(`expected identifier, found keyword`);
      names.push(ident(p.segs.at(-1).ident));
      if (c.eof()) break;
      c.expect(",");
    }
  } catch (e) {
    if (!(e instanceof RustSyntaxError)) throw e;
    items.errors.push(
      `can't read generate_handler![${tokens(group.t)}]: ${e.message}`,
    );
    return;
  }
  items.handlers.push(...names);
}

// the items themselves are parsed when a command uses them

/** `{ params: [{ receiver } | { pat, patIdent, ty }], ret }` */
function parseSig(sig) {
  const c = new Cursor(sig);
  if (c.p("<")) c.angles();
  if (!isG(c.peek(), "(")) c.fail("expected `(`");
  const params = parseParams(c.next().t);
  const ret = c.arrow() ? ((c.i += 2), parseType(c, true)) : null;
  return { params, ret };
}

function parseParams(toks) {
  const c = new Cursor(toks);
  const params = [];
  while (!c.eof()) {
    outerAttrs(c);
    let k = 0;
    if (c.p("&", k)) {
      k++;
      if (c.p("'", k)) k += 2;
    }
    if (isI(c.peek(k), "mut")) k++;
    if (
      isI(c.peek(k), "self") &&
      (!c.peek(k + 1) ||
        c.p(",", k + 1) ||
        (c.p(":", k + 1) && !c.colon2(k + 1)))
    ) {
      c.i += k + 1;
      if (c.p(":")) {
        c.next();
        parseType(c, true);
      }
      params.push({ receiver: true });
    } else if (c.p(".") && c.p(".", 1) && c.p(".", 2)) {
      c.i += 3;
    } else {
      const start = c.i;
      while (!c.eof() && !(c.p(":") && !c.colon2())) c.i += c.colon2() ? 2 : 1;
      const pat = toks.slice(start, c.i);
      c.expect(":");
      params.push({ pat, patIdent: patIdent(pat), ty: parseType(c, true) });
    }
    if (!c.eof()) c.expect(",");
  }
  return params;
}

/** the identifier of a `[ref] [mut] ident [@ subpattern]` pattern (syn's Pat::Ident) */
function patIdent(pat) {
  let k = 0;
  if (isI(pat[k], "ref")) k++;
  if (isI(pat[k], "mut")) k++;
  const t = pat[k];
  if (t?.k !== "ident" || t.s === "_" || KEYWORDS.has(t.s)) return null;
  if (k + 1 < pat.length && !isP(pat[k + 1], "@")) return null;
  return ident(t.s);
}

function parseTypeItem(item) {
  const c = new Cursor(item.toks);
  c.next();
  const name = ident(c.next().s);
  const generics = genericsDecl(c);
  const base = { kind: item.kind, name, attrs: item.attrs, generics };
  const skipWhere = (stop) => {
    if (isI(c.peek(), "where")) c.skipTo(stop);
  };
  if (item.kind === "type") {
    skipWhere((c) => c.p("="));
    c.expect("=");
    return { ...base, ty: parseType(c, true) };
  }
  skipWhere((c) => isG(c.peek(), "{") || c.p(";"));
  if (item.kind === "struct") return { ...base, fields: parseFields(c) };
  if (!isG(c.peek(), "{")) c.fail("expected `{`");
  const v = new Cursor(c.next().t);
  const variants = [];
  while (!v.eof()) {
    const attrs = outerAttrs(v);
    visibility(v);
    const id = v.next();
    if (id?.k !== "ident") v.fail("expected a variant");
    variants.push({ name: ident(id.s), attrs, fields: parseFields(v) });
    if (v.p("=")) v.skipTo((c) => c.p(","));
    if (!v.eof()) v.expect(",");
  }
  return { ...base, variants };
}

/** `{ kind: "named" | "unnamed" | "unit", list: [{ name, attrs, ty }] }` */
function parseFields(c) {
  const g = c.peek();
  if (!isG(g, "{") && !isG(g, "(")) return { kind: "unit", list: [] };
  c.next();
  const named = g.d === "{";
  const f = new Cursor(g.t);
  const list = [];
  while (!f.eof()) {
    const attrs = outerAttrs(f);
    visibility(f);
    let name = null;
    if (named) {
      const id = f.next();
      if (id?.k !== "ident") f.fail("expected a field");
      name = ident(id.s);
      f.expect(":");
    }
    list.push({ name, attrs, ty: parseType(f, true) });
    if (!f.eof()) f.expect(",");
  }
  return { kind: named ? "named" : "unnamed", list };
}

// -------------------------------------------------------------------------------------------------
// attributes

/** the `#[serde(…)]` attributes, as stable token text */
const serdeAttrs = (attrs) =>
  attrs
    .filter((a) => attrIs(a, "serde"))
    .map((a) => `#[${tokens(a.meta)}]`)
    .join("");

class MetaError extends Error {}

/** syn's parse_nested_meta: `path [= value | (…)], …` */
function nestedMeta(c, logic) {
  for (;;) {
    let p;
    try {
      p = parsePath(c, false);
    } catch (e) {
      if (e instanceof RustSyntaxError) throw new MetaError(e.message);
      throw e;
    }
    logic({
      is: (s) =>
        !p.leading &&
        p.segs.length === 1 &&
        p.segs[0].ident === s &&
        !p.segs[0].args,
      c,
    });
    if (c.eof()) return;
    if (!c.p(",")) throw new MetaError("expected `,`");
    c.next();
    if (c.eof()) return;
  }
}

function metaValue(c) {
  if (!c.p("=")) throw new MetaError("expected `=`");
  c.next();
}

function metaLitStr(c) {
  const v = litStr(c.peek());
  if (v === null) throw new MetaError("expected string literal");
  c.next();
  return v;
}

function metaParens(c, logic) {
  if (!isG(c.peek(), "(")) throw new MetaError("expected parentheses");
  nestedMeta(new Cursor(c.next().t), logic);
}

function skipValue(c) {
  if (c.p("=")) {
    c.next();
    if (c.eof() || c.p(",")) throw new MetaError("expected an expression");
    c.skipTo((c) => c.p(","));
  } else if (isG(c.peek(), "(")) {
    metaParens(c, (m) => skipValue(m.c));
  }
}

/** the serde attributes that change the ts types */
function serde(attrs) {
  const s = {
    rename: null,
    renameAll: null,
    tag: null,
    content: null,
    untagged: false,
    transparent: false,
    skip: false,
    flatten: false,
    optional: false,
  };
  for (const a of attrs.filter((a) => attrIs(a, "serde"))) {
    try {
      if (a.kind !== "list")
        throw new MetaError("expected attribute arguments in parentheses");
      nestedMeta(new Cursor(a.list), (meta) => {
        const c = meta.c;
        if (meta.is("rename") || meta.is("rename_all")) {
          let value;
          if (c.p("=")) {
            c.next();
            value = metaLitStr(c);
          } else {
            // rename(serialize = "…", deserialize = "…"): the serialized name
            value = null;
            metaParens(c, (m) => {
              metaValue(m.c);
              const v = metaLitStr(m.c);
              if (m.is("serialize")) value = v;
            });
          }
          if (meta.is("rename")) s.rename = value;
          else s.renameAll = value;
        } else if (meta.is("tag")) {
          metaValue(c);
          s.tag = metaLitStr(c);
        } else if (meta.is("content")) {
          metaValue(c);
          s.content = metaLitStr(c);
        } else if (meta.is("untagged")) s.untagged = true;
        else if (meta.is("transparent")) s.transparent = true;
        else if (meta.is("skip") || meta.is("skip_serializing")) s.skip = true;
        else if (meta.is("flatten")) s.flatten = true;
        else if (meta.is("default") || meta.is("skip_serializing_if")) {
          s.optional = true;
          skipValue(c);
        } else skipValue(c);
      });
    } catch (e) {
      if (!(e instanceof MetaError)) throw e;
    }
  }
  return s;
}

function docs(attrs) {
  const out = [];
  for (const a of attrs) {
    if (!attrIs(a, "doc") || a.kind !== "nv" || a.value.length !== 1) continue;
    const v = litStr(a.value[0]);
    if (v !== null) out.push(v.startsWith(" ") ? v.slice(1) : v);
  }
  return out;
}

function jsdoc(lines, indent) {
  const esc = (l) => l.replaceAll("*/", "*\\/");
  if (!lines.length) return "";
  if (lines.length === 1) return `${indent}/** ${esc(lines[0])} */\n`;
  let out = `${indent}/**\n`;
  for (const l of lines)
    out += `${indent} * ${esc(l)}\n`.replaceAll(" \n", "\n");
  return `${out}${indent} */\n`;
}

/** `rename_all = "…"` of `#[tauri::command(…)]` */
function commandRenameAll(f) {
  for (const a of f.attrs.filter(isCommandAttr)) {
    if (a.kind !== "list") continue;
    const t = a.list;
    for (let k = 0; k + 2 < t.length; k++) {
      if (
        isI(t[k], "rename_all") &&
        isP(t[k + 1], "=") &&
        t[k + 2].k === "lit"
      ) {
        const v = litStr(t[k + 2]);
        if (v === null)
          throw new Error(
            `#[command] of \`${f.name}\`: expected string literal`,
          );
        return v;
      }
    }
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// names

const chars = (s) => Array.from(s);
const isUpper = (c) => /^\p{Uppercase}$/u.test(c);

/** serde's `rename_all` rules, for field (snake_case) or variant (PascalCase) names */
export function rename(rule, name, variant) {
  let words;
  if (variant) {
    words = [];
    let cur = "";
    for (const c of chars(name)) {
      if (isUpper(c) && cur) {
        words.push(cur);
        cur = "";
      }
      cur += c;
    }
    words.push(cur);
    words = words.map((w) => w.toLowerCase());
  } else words = name.split("_");
  const cap = (w) => {
    const [f, ...rest] = chars(w);
    return f === undefined ? "" : f.toUpperCase() + rest.join("");
  };
  if (rule === "lowercase") return variant ? name.toLowerCase() : name;
  if (rule === "UPPERCASE") return name.toUpperCase();
  switch (rule) {
    case "PascalCase":
      return words.map(cap).join("");
    case "camelCase": {
      const [f, ...rest] = chars(words.map(cap).join(""));
      return f === undefined ? "" : f.toLowerCase() + rest.join("");
    }
    case "snake_case":
      return words.join("_");
    case "SCREAMING_SNAKE_CASE":
      return words.join("_").toUpperCase();
    case "kebab-case":
      return words.join("-");
    case "SCREAMING-KEBAB-CASE":
      return words.join("-").toUpperCase();
    default:
      return name;
  }
}

const RESERVED = new Set(
  (
    "arguments await break case catch class const continue debugger default delete do else enum " +
    "eval export extends false finally for function if implements import in instanceof interface " +
    "let new null package private protected public return static super switch this throw true try " +
    "typeof var void while with yield"
  ).split(" "),
);

/** a valid ts parameter name */
const tsParam = (name) => (RESERVED.has(name) ? `${name}_` : name);

/** an object key, quoted if needed */
const tsKey = (key) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : debugStr(key);

/** byte-wise string order, like rust's String */
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// -------------------------------------------------------------------------------------------------
// commands and types

/** tauri injects these, they aren't sent by the frontend */
const INJECTED = new Set([
  "AppHandle",
  "Window",
  "WebviewWindow",
  "Webview",
  "State",
  "Request",
  "CommandScope",
  "GlobalScope",
]);

function injected(ty) {
  if (ty.t === "ref") return injected(ty.elem);
  return ty.t === "path" && INJECTED.has(ty.segs.at(-1).ident);
}

/** generic params -> the given (canonical or ts) arguments */
function bind(generics, args) {
  return new Map(generics.map((p, i) => [p, args[i] ?? "?"]));
}

/** replaces generic params in a type (syn's VisitMut over the types) */
function substTypes(ty, params) {
  const sub = (t) => substTypes(t, params);
  switch (ty.t) {
    case "path": {
      const s = ty.segs[0];
      if (
        !ty.leading &&
        ty.segs.length === 1 &&
        s.args === null &&
        params.has(ident(s.ident))
      )
        return params.get(ident(s.ident));
      return {
        ...ty,
        segs: ty.segs.map((seg) => ({
          ...seg,
          args:
            seg.args &&
            seg.args.map((a) => (a.k === "type" ? { ...a, ty: sub(a.ty) } : a)),
        })),
      };
    }
    case "ref":
    case "paren":
    case "slice":
    case "array":
      return { ...ty, elem: sub(ty.elem) };
    case "tuple":
      return { ...ty, elems: ty.elems.map(sub) };
    default:
      return ty;
  }
}

class Cx {
  constructor(items) {
    this.items = items;
    this.api = { commands: [], types: new Map(), usesChannel: false };
    /** custom types being expanded (recursion guard) */
    this.stack = [];
    this.parsed = new Map();
  }

  command(name, f) {
    const snakeKeys = commandRenameAll(f) === "snake_case";
    const { params, ret: output } = parseSig(f.sig);
    const sigArgs = [];
    const args = [];
    for (const p of params) {
      if (p.receiver) throw new Error(`command \`${name}\` takes self`);
      if (injected(p.ty)) continue;
      if (p.patIdent === null)
        throw new Error(
          `command \`${name}\`: argument \`${tokens(p.pat)}\` must be a plain identifier`,
        );
      const key = snakeKeys
        ? p.patIdent
        : rename("camelCase", p.patIdent, false);
      sigArgs.push(`${key}:${this.canon(p.ty, new Map())}`);
      const ts = this.ts(p.ty, new Map());
      args.push([key, tsParam(rename("camelCase", p.patIdent, false)), ts]);
    }
    let retCanon = "null";
    let ret = "void";
    if (output) {
      retCanon = this.canon(output, new Map());
      ret = this.tsRet(output);
    }
    return {
      name,
      signature: `${name}(${sigArgs.join(",")})->${retCanon}`,
      args,
      ret,
      docs: docs(f.attrs),
    };
  }

  /** the ts type a command's promise resolves to: errors (`Result`) reject it */
  tsRet(ty) {
    ty = this.unalias(ty, 0);
    const s = this.shape(ty, new Map());
    if (s.k === "unit") return "void";
    if (s.k === "result") return this.tsRet(s.ok);
    return this.ts(ty, new Map());
  }

  /** resolves the app's type aliases at the top of a type */
  unalias(ty, depth) {
    const s = this.shape(ty, new Map());
    if (s.k === "custom") {
      const a = this.typeItem(s.name);
      if (a.kind === "type") {
        if (depth > 16)
          throw new Error(`type alias \`${s.name}\` is recursive`);
        const params = new Map();
        a.generics.forEach((p, i) => {
          if (i < s.args.length) params.set(p, s.args[i]);
        });
        return this.unalias(substTypes(a.ty, params), depth + 1);
      }
    }
    return ty;
  }

  shape(ty, subst) {
    switch (ty.t) {
      case "ref":
      case "paren":
        return this.shape(ty.elem, subst);
      case "slice":
      case "array":
        return { k: "list", t: ty.elem };
      case "tuple":
        return ty.elems.length ? { k: "tuple", ts: ty.elems } : { k: "unit" };
      case "path": {
        const segs = ty.segs;
        const last = segs.at(-1);
        const name = ident(last.ident);
        const args =
          last.args && !last.paren
            ? last.args.filter((a) => a.k === "type").map((a) => a.ty)
            : [];
        const local =
          segs.length === 1 ||
          ["crate", "self", "super"].includes(segs[0].ident);
        if (local && segs.length === 1 && !args.length && subst.has(name))
          return { k: "param", name };
        if (local && this.items.types.has(name))
          return { k: "custom", name, args };
        const [a0] = args;
        switch (name) {
          case "String":
          case "str":
          case "char":
          case "PathBuf":
          case "Path":
          case "OsString":
            return { k: "prim", p: "string" };
          case "bool":
            return { k: "prim", p: "boolean" };
          case "Value":
            return { k: "any" };
        }
        if (
          /^(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64)$/.test(
            name,
          )
        )
          return { k: "prim", p: "number" };
        if (a0) {
          if (name === "Option") return { k: "option", t: a0 };
          if (
            /^(Vec|VecDeque|LinkedList|HashSet|BTreeSet|IndexSet)$/.test(name)
          )
            return { k: "list", t: a0 };
          if (/^(HashMap|BTreeMap|IndexMap)$/.test(name) && args.length === 2)
            return { k: "map", t: args[1] };
          if (/^(Box|Arc|Rc|Cow)$/.test(name)) return this.shape(a0, subst);
          if (name === "Channel") return { k: "channel", t: a0 };
          if (name === "Result")
            return { k: "result", ok: a0, err: args[1] ?? null };
        }
        return { k: "opaque", path: tokens(ty.toks) };
      }
      default:
        return { k: "opaque", path: tokens(ty.toks) };
    }
  }

  typeItem(name) {
    const list = this.items.types.get(name);
    if (list?.length !== 1)
      throw new Error(
        `type \`${name}\` is defined more than once in the app's sources`,
      );
    if (!this.parsed.has(name)) this.parsed.set(name, parseTypeItem(list[0]));
    return this.parsed.get(name);
  }

  // canonical form: the wire shape, independent of rust type names, docs and formatting. Part of
  // the hash format: changing it changes every hash.

  canon(ty, subst) {
    const s = this.shape(ty, subst);
    switch (s.k) {
      case "prim":
        return s.p;
      case "option":
        return `option<${this.canon(s.t, subst)}>`;
      case "list":
        return `[${this.canon(s.t, subst)}]`;
      case "map":
        return `{string:${this.canon(s.t, subst)}}`;
      case "tuple":
        return `(${s.ts.map((t) => this.canon(t, subst)).join(",")})`;
      case "unit":
        return "null";
      case "any":
        return "any";
      case "channel":
        return `channel<${this.canon(s.t, subst)}>`;
      case "result": {
        const err = s.err ? this.canon(s.err, subst) : "?";
        return `result<${this.canon(s.ok, subst)},${err}>`;
      }
      case "param":
        return subst.get(s.name);
      case "opaque":
        return `?${s.path}`;
      case "custom": {
        if (this.stack.includes(s.name)) return `#${s.name}`;
        const item = this.typeItem(s.name);
        const args = s.args.map((t) => this.canon(t, subst));
        this.stack.push(s.name);
        let out;
        if (item.kind === "struct") {
          const fields = this.canonFields(
            item.fields,
            bind(item.generics, args),
          );
          out = `struct{${serdeAttrs(item.attrs)};${fields}}`;
        } else if (item.kind === "enum") {
          const sub = bind(item.generics, args);
          const variants = item.variants.map(
            (v) =>
              `${v.name}${serdeAttrs(v.attrs)}(${this.canonFields(v.fields, sub)})`,
          );
          out = `enum{${serdeAttrs(item.attrs)};${variants.join("|")}}`;
        } else out = this.canon(item.ty, bind(item.generics, args));
        this.stack.pop();
        return out;
      }
    }
  }

  canonFields(fields, subst) {
    return fields.list
      .map(
        (f) =>
          `${serdeAttrs(f.attrs)}${f.name !== null ? `${f.name}:` : ""}${this.canon(f.ty, subst)}`,
      )
      .join(",");
  }

  // typescript

  ts(ty, subst) {
    const s = this.shape(ty, subst);
    switch (s.k) {
      case "prim":
        return s.p;
      case "option":
        return `${this.ts(s.t, subst)} | null`;
      case "list": {
        const inner = this.ts(s.t, subst);
        return inner.includes(" ") ? `(${inner})[]` : `${inner}[]`;
      }
      case "map":
        return `Record<string, ${this.ts(s.t, subst)}>`;
      case "tuple":
        return `[${s.ts.map((t) => this.ts(t, subst)).join(", ")}]`;
      case "unit":
        return "null";
      case "any":
      case "opaque":
      case "result":
        return "unknown";
      case "channel":
        this.api.usesChannel = true;
        return `Channel<${this.ts(s.t, subst)}>`;
      case "param":
        return subst.get(s.name);
      case "custom": {
        const args = s.args.map((t) => this.ts(t, subst));
        const item = this.typeItem(s.name);
        if (item.kind === "type") {
          if (this.stack.includes(s.name)) return "unknown";
          this.stack.push(s.name);
          try {
            return this.ts(item.ty, bind(item.generics, args));
          } finally {
            this.stack.pop();
          }
        }
        this.declare(s.name);
        return args.length ? `${s.name}<${args.join(", ")}>` : s.name;
      }
    }
  }

  /** adds the ts declaration of a struct/enum (once) */
  declare(name) {
    if (this.api.types.has(name)) return;
    // placeholder first: recursive types refer to themselves
    this.api.types.set(name, "");
    const item = this.typeItem(name);
    this.api.types.set(
      name,
      item.kind === "struct" ? this.tsStruct(item) : this.tsEnum(item),
    );
  }

  tsStruct(s) {
    const [params, sub] = tsGenerics(s.generics);
    const attrs = serde(s.attrs);
    const head = `${jsdoc(docs(s.attrs), "")}export type ${s.name}${params} =`;
    const f = s.fields;
    let body;
    if (f.kind === "unit") body = "null";
    else if (f.kind === "unnamed" && f.list.length === 1)
      body = this.ts(f.list[0].ty, sub);
    else if (f.kind === "unnamed")
      body = `[${f.list.map((x) => this.ts(x.ty, sub)).join(", ")}]`;
    else if (attrs.transparent) {
      const first = f.list.find((x) => !serde(x.attrs).skip);
      body = first ? this.ts(first.ty, sub) : "null";
    } else body = this.tsObject(f, attrs.renameAll, sub, null, false);
    return `${head} ${body};\n`;
  }

  /** `{ key: T; … }` (& flattened types), `tag` is prepended to the members; `inline` puts it on
   * one line (enum variants) */
  tsObject(fields, renameAll, sub, tag, inline) {
    const members = tag === null ? [] : [[[], tag]];
    const flattened = [];
    for (const f of fields.list) {
      const a = serde(f.attrs);
      if (a.skip) continue;
      if (a.flatten) {
        flattened.push(this.ts(f.ty, sub));
        continue;
      }
      const rustName = f.name ?? "";
      const key =
        a.rename ??
        (renameAll === null ? rustName : rename(renameAll, rustName, false));
      const ty = this.ts(f.ty, sub);
      members.push([
        docs(f.attrs),
        `${tsKey(key)}${a.optional ? "?" : ""}: ${ty}`,
      ]);
    }
    let out;
    if (inline) out = `{ ${members.map(([, m]) => m).join("; ")} }`;
    else {
      out = "{\n";
      for (const [doc, m] of members) out += `${jsdoc(doc, "  ")}  ${m};\n`;
      out += "}";
    }
    for (const f of flattened) out += ` & ${f}`;
    return out;
  }

  tsEnum(e) {
    const [params, sub] = tsGenerics(e.generics);
    const attrs = serde(e.attrs);
    const variants = [];
    for (const v of e.variants) {
      const va = serde(v.attrs);
      if (va.skip) continue;
      const name =
        va.rename ??
        (attrs.renameAll === null
          ? v.name
          : rename(attrs.renameAll, v.name, true));
      const lit = debugStr(name);
      const f = v.fields;
      let payload = null;
      if (f.kind === "unnamed" && f.list.length === 1)
        payload = this.ts(f.list[0].ty, sub);
      else if (f.kind === "unnamed")
        payload = `[${f.list.map((x) => this.ts(x.ty, sub)).join(", ")}]`;
      else if (f.kind === "named")
        payload = this.tsObject(f, va.renameAll, sub, null, true);
      const named = f.kind === "named";
      const { tag, content, untagged } = attrs;
      let out;
      if (untagged) out = payload ?? "null";
      else if (tag !== null && content !== null)
        out =
          payload === null
            ? `{ ${tsKey(tag)}: ${lit} }`
            : `{ ${tsKey(tag)}: ${lit}; ${tsKey(content)}: ${payload} }`;
      else if (tag !== null && payload === null)
        out = `{ ${tsKey(tag)}: ${lit} }`;
      else if (tag !== null && named)
        out = this.tsObject(
          f,
          va.renameAll,
          sub,
          `${tsKey(tag)}: ${lit}`,
          true,
        );
      else if (tag !== null) out = `({ ${tsKey(tag)}: ${lit} } & ${payload})`;
      else out = payload === null ? lit : `{ ${tsKey(name)}: ${payload} }`;
      variants.push(out);
    }
    if (!variants.length) variants.push("never");
    return `${jsdoc(docs(e.attrs), "")}export type ${e.name}${params} =\n  | ${variants.join("\n  | ")};\n`;
  }
}

/** `<T, U>` and the identity substitution for a declaration's own params */
function tsGenerics(names) {
  const sub = new Map(names.map((n) => [n, n]));
  return [names.length ? `<${names.join(", ")}>` : "", sub];
}

// -------------------------------------------------------------------------------------------------
// api

/**
 * The commands registered with `generate_handler!` in the given sources (file contents), like
 * `tauri_plugin_content_update_build::analyze`. Throws on the same errors.
 */
export function analyze(sources) {
  const items = new Items();
  for (const src of sources) scanBlock(tokenize(src), "block", items);
  return analyzeItems(items);
}

/** path components, compared like rust's PathBuf */
function comparePaths(a, b) {
  const x = a.split(path.sep);
  const y = b.split(path.sep);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = byBytes(x[i], y[i]);
    if (c) return c;
  }
  return x.length - y.length;
}

function collectRs(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectRs(p, out);
    else {
      const dot = name.lastIndexOf(".");
      if (dot > 0 && name.slice(dot + 1) === "rs") out.push(p);
    }
  }
}

/** reads all `.rs` files below `src` (like `tauri_plugin_content_update_build::scan`) */
export function scan(src) {
  const paths = [];
  collectRs(src, paths);
  paths.sort(comparePaths);
  const items = new Items();
  for (const p of paths) {
    try {
      scanBlock(tokenize(fs.readFileSync(p, "utf-8")), "block", items);
    } catch (e) {
      if (e instanceof RustSyntaxError) throw new Error(`${p}: ${e.message}`);
      throw e;
    }
  }
  return analyzeItems(items);
}

function analyzeItems(items) {
  if (items.errors.length) throw new Error(items.errors[0]);
  const names = [...new Set(items.handlers)].sort(byBytes);
  const cx = new Cx(items);
  for (const name of names) {
    const fns = items.commands.get(name);
    if (!fns)
      throw new Error(
        `command \`${name}\` is registered with generate_handler! but no #[tauri::command] fn \`${name}\` was found in the app's sources`,
      );
    if (fns.length > 1)
      throw new Error(`command \`${name}\` is defined more than once`);
    cx.api.commands.push(cx.command(name, fns[0]));
  }
  return cx.api;
}

/** the typescript bindings file */
export function render(api) {
  let out =
    "// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.\n" +
    "// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.\n";
  out += `import { ${api.usesChannel ? "Channel, invoke" : "invoke"} } from "@tauri-apps/api/core";\n\n`;
  out +=
    "function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {\n" +
    '  return invoke<T>(id.split(":")[1], args);\n}\n';
  for (const name of [...api.types.keys()].sort(byBytes))
    out += `\n${api.types.get(name)}`;
  for (const c of api.commands) {
    const params = c.args.map(([, param, ty]) => `${param}: ${ty}`);
    const fields = c.args.map(([key, param]) =>
      key === param ? key : `${key}: ${param}`,
    );
    const args = fields.length ? `, { ${fields.join(", ")} }` : "";
    out += `\n${jsdoc(c.docs, "")}`;
    out +=
      `export function ${rename("camelCase", c.name, false)}(${params.join(", ")}): Promise<${c.ret}> {\n` +
      `  return call<${c.ret}>("${MARKER}:${c.name}:${nativeApiHash(c.signature)}"${args});\n}\n`;
  }
  return out;
}

/**
 * Generates the bindings of the app crate in `crateDir` (its `src/**.rs`) to `out`, writes the
 * file only if it changed. Returns whether it changed.
 */
export function writeBindings(crateDir, out) {
  const text = render(scan(path.join(crateDir, "src")));
  let old = null;
  try {
    old = fs.readFileSync(out, "utf-8");
  } catch {}
  if (old === text) return false;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  return true;
}
