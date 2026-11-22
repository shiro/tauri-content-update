# Dev environment:
# - Node 24 (required by @solidjs/start 2), pnpm
# - JDK 21 (AGP 9 / Gradle 9 of the generated Tauri android project)
# - Rust via oxalica/rust-overlay, version + targets from src-tauri/rust-toolchain.toml
# - Android SDK/NDK/emulator/system image composed by nixpkgs androidenv (read-only store SDK)
# - Linux desktop: WebKitGTK 4.1 + GTK 3 (tauri's linux webview), tauri-driver + Xvfb for the desktop e2e
let
  rust_overlay = import (builtins.fetchTarball "https://github.com/oxalica/rust-overlay/archive/master.tar.gz");
  pkgs = import <nixpkgs> {
    overlays = [ rust_overlay ];
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  };
  ndkVersion = "27.2.12479018";
  # emulator API level (pnpm android:dev + e2e), set in scripts/emulator.ts
  e2eApiLevel = builtins.head (builtins.match ".*ANDROID_API_LEVEL = \"([0-9.]+)\";.*"
    (builtins.readFile ./scripts/emulator.ts));
  # build SDK: tauri's own android library compiles against 36, the generated app against 37
  # (src-tauri/gen/android/app/build.gradle.kts), build-tools 36 is AGP 9.3's default
  android = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "36" "37.0" ];
    buildToolsVersions = [ "36.0.0" ];
    ndkVersions = [ ndkVersion ];
    includeNDK = true;
  };
  # emulator SDK (pnpm android:dev + e2e): emulator + only its system image (system images are installed for every platform of a
  # composition, so the build SDK doesn't include any)
  e2eAndroid = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ e2eApiLevel ];
    includeEmulator = true;
    includeSystemImages = true;
    systemImageTypes = [ "google_apis" ];
    abiVersions = [ "x86_64" ];
  };
  sdk = "${android.androidsdk}/libexec/android-sdk";
  e2eSdk = "${e2eAndroid.androidsdk}/libexec/android-sdk";
  aapt2 = "${sdk}/build-tools/36.0.0/aapt2";
  rust = pkgs.rust-bin.fromRustupToolchainFile ./src-tauri/rust-toolchain.toml;
  # WebDriver server for tauri apps (desktop e2e), not in nixpkgs
  tauri-driver = pkgs.rustPlatform.buildRustPackage rec {
    pname = "tauri-driver";
    version = "2.1.0";
    src = pkgs.fetchCrate {
      inherit pname version;
      hash = "sha256-Ttik3t/IUnze3SHcpH9zPS1UwW9B/V70Wvel+eBHhOE=";
    };
    cargoHash = "sha256-x7cz2KLNLJRlPqahV/BwyYJcncfUyhIp6/gORhvudZI=";
  };
in
pkgs.mkShell {
  packages = [
    pkgs.nodejs_24
    pkgs.pnpm
    pkgs.jdk21
    rust
    android.androidsdk
    pkgs.pkg-config
    # shows the (headless) emulator of `pnpm android:dev`, without the emulator's own toolbar
    pkgs.scrcpy
    # desktop e2e: tauri-driver drives the app through WebKitWebDriver, Xvfb is its headless display
    tauri-driver
    pkgs.webkitgtk_4_1 # provides WebKitWebDriver
    pkgs.xvfb-run
  ];
  # linux desktop build (pkg-config finds them through buildInputs)
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
  shellHook = ''
    export JAVA_HOME="${pkgs.jdk21.home}"
    export ANDROID_AVD_HOME="$HOME/.android/avd" # avdmanager defaults to XDG, the emulator to ~/.android
    export PATH="$ANDROID_HOME/platform-tools:$PATH"
    # GTK's gsettings schemas (desktop app)
    export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:''${XDG_DATA_DIRS:-}"
  '';
  # TLS for the desktop webview (glib-networking)
  GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules";
  ANDROID_HOME = sdk;
  ANDROID_SDK_ROOT = sdk;
  NDK_HOME = "${sdk}/ndk/${ndkVersion}";
  # emulator, avdmanager and the system image of pnpm android:dev and the e2e tests (scripts/emulator.ts)
  ANDROID_E2E_SDK = e2eSdk;
  # AGP downloads an aapt2 that can't run on NixOS, use the SDK's (applies to the gradle builds the
  # tauri cli starts).
  # No gradle daemon: a daemon keeps the environment of the shell that started it, and a later build
  # from another nix-shell reuses it with a deleted TMPDIR (clang: "unable to make temporary file")
  # and stale store paths.
  GRADLE_OPTS = "-Dorg.gradle.daemon=false -Dorg.gradle.project.android.aapt2FromMavenOverride=${aapt2}";
  # the @tauri-apps/cli native binary links liblzma, the `tauri` package script adds this to LD_LIBRARY_PATH
  TAURI_CLI_LIBRARY_PATH = "${pkgs.xz.out}/lib";
  # playwright's downloaded ffmpeg doesn't run on NixOS; playwright.config.ts links this one in instead
  PLAYWRIGHT_FFMPEG_PATH = "${pkgs.ffmpeg-headless}/bin/ffmpeg";
  RUST_BACKTRACE = 1;
}
