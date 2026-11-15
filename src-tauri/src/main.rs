// Kamishibai デスクトップアプリ（Tauri）の入口。
//
// 画面（app-dist/ = src/editor など）が「裏側」の処理（src/app/backend.js）も自分で動かすので、
// Rust 側はファイル操作などの小さな命令だけを持つ（src/app/tauri-host.js から呼ぶ）。
//   fs_*        … ファイルの読み書き（バイト列のまま受け渡す）
//   app_info    … 設定の置き場所・一時フォルダ・起動時に渡されたファイル（.kami）
//   print_pdf   … HTML を PDF に（Windows は WebView2 の印刷機能。pdf.rs）
// 2 つ目の起動（.kami をダブルクリックなど）は、すでに開いているウィンドウへ「open-paths」で渡す。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pdf;

use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stat {
    is_dir: bool,
    is_file: bool,
    size: u64,
    mtime: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    user_data: String,
    temp: String,
    platform: String,
    version: String,
    args: Vec<String>,
}

fn err(e: std::io::Error) -> String {
    e.to_string()
}

/// "%E3%81%82" などを元の文字列に戻す（書き込み先のパスはヘッダーで受け取るため）
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn fs_read(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(err)
}

#[tauri::command]
fn fs_write(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("x-path がありません")?;
    match request.body() {
        InvokeBody::Raw(bytes) => std::fs::write(&path, bytes).map_err(err),
        InvokeBody::Json(serde_json::Value::String(s)) => std::fs::write(&path, s.as_bytes()).map_err(err),
        _ => Err("書き込む内容が不正です".into()),
    }
}

#[tauri::command]
fn fs_stat(path: String) -> Option<Stat> {
    let m = std::fs::metadata(&path).ok()?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Some(Stat { is_dir: m.is_dir(), is_file: m.is_file(), size: m.len(), mtime })
}

#[tauri::command]
fn fs_list(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(&path).map_err(err)? {
        let e = e.map_err(err)?;
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(Entry { name: e.file_name().to_string_lossy().into_owned(), is_dir });
    }
    Ok(out)
}

#[tauri::command]
fn fs_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
fn fs_remove_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[tauri::command]
fn fs_remove_dir(path: String) -> Result<(), String> {
    match std::fs::remove_dir_all(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[tauri::command]
fn fs_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(err)
}

/// 起動時の引数のうち、ファイルとして存在するもの（.kami・フォルダ）
fn path_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && PathBuf::from(a).exists())
        .cloned()
        .collect()
}

/// 設定の置き場所: 環境変数 KAMISHIBAI_USERDATA（動作確認用）> Windows %APPDATA%\Kamishibai など
fn user_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("KAMISHIBAI_USERDATA") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    app.path()
        .data_dir()
        .map(|d| d.join("Kamishibai"))
        .unwrap_or_else(|_| std::env::temp_dir().join("Kamishibai"))
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let args: Vec<String> = std::env::args().collect();
    let mut paths = path_args(&args);
    if let Ok(p) = std::env::var("KAMISHIBAI_OPEN") {
        if !p.is_empty() {
            paths.insert(0, p);
        }
    }
    AppInfo {
        user_data: user_data_dir(&app).to_string_lossy().into_owned(),
        temp: std::env::temp_dir().to_string_lossy().into_owned(),
        platform: std::env::consts::OS.to_string(),
        version: app.package_info().version.to_string(),
        args: paths,
    }
}

/// 発表・資料プレビューのウィンドウを開く（同じ label があれば閉じて開き直す）。
/// 発表画面の「発表者ビュー」（S キー）は window.open で別ウィンドウを開くので、それを許可しておく。
// Windows では、同期の命令の中でウィンドウを作ると止まることがあるので async にする（Tauri の注意事項）
#[tauri::command]
async fn open_page(app: tauri::AppHandle, label: String, url: String, title: String, width: f64, height: f64) -> Result<(), String> {
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.destroy();
    }
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(title)
        .inner_size(width, height)
        .disable_drag_drop_handler()
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // 2 つ目の起動は、開いているウィンドウにファイルを渡して前に出す
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = path_args(&args);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !paths.is_empty() {
                let _ = app.emit_to("main", "open-paths", paths);
            }
        }))
        // エディタ（main）を閉じたら、発表・資料のウィンドウも閉じてアプリを終える
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs_read,
            fs_write,
            fs_stat,
            fs_list,
            fs_mkdir,
            fs_remove_file,
            fs_remove_dir,
            fs_rename,
            app_info,
            open_page,
            pdf::print_pdf
        ])
        .build(tauri::generate_context!())
        .expect("Kamishibai を起動できませんでした")
        .run(|_app, _event| {
            // macOS で .kami をダブルクリックしたとき（RunEvent::Opened）
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = _app.emit_to("main", "open-paths", paths);
            }
        });
}
