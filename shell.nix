# Dev environment (NixOS): `nix-shell --run 'cargo test --workspace && pnpm test'`
# - Rust (stable, via oxalica/rust-overlay)
# - Node + pnpm (JS API, bundler CLI and its tests)
# - WebKitGTK 4.1 + GTK 3: the plugin crate links tauri, which needs them on Linux even for tests
let
  rust_overlay = import (builtins.fetchTarball "https://github.com/oxalica/rust-overlay/archive/master.tar.gz");
  pkgs = import <nixpkgs> { overlays = [ rust_overlay ]; };
in
pkgs.mkShell {
  packages = [
    pkgs.nodejs_24
    pkgs.pnpm
    (pkgs.rust-bin.stable.latest.default.override {
      extensions = [ "clippy" "rustfmt" "rust-src" ];
    })
    pkgs.pkg-config
  ];
  buildInputs = with pkgs; [
    webkitgtk_4_1
    gtk3
    libsoup_3
    glib
    cairo
    pango
    gdk-pixbuf
    atk
    dbus
    librsvg
  ];
  RUST_BACKTRACE = 1;
}
