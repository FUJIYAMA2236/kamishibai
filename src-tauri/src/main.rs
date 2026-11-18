// Kamishibai デスクトップアプリ（Tauri）の入口。
//
// 画面（app-dist/ = src/editor など）が「裏側」の処理（src/app/backend.js）も自分で動かすので、
// Rust 側はファイル操作などの小さな命令だけを持つ（src/app/tauri-host.js から呼ぶ）。
//   fs_*          … ファイルの読み書き（バイト列のまま受け渡す）。**許可した場所の中だけ**（下の「許可した場所」）
//   pick          … ファイル / フォルダを選ぶ OS のダイアログ。選ばれた場所を許可した場所に加える
//   confirm_open  … 許可していない場所（古い「最近使ったもの」など）を開くとき、OS の確認ダイアログで聞いてから許可する
//   open_exported … 書き出したファイル（.html / .pdf / .pptx など）を既定のアプリで開く
//   app_info      … 設定の置き場所・一時フォルダ・起動時に渡されたファイル（.kami）
//   print_pdf     … HTML を PDF に（Windows は WebView2 の印刷機能。pdf.rs）
// 2 つ目の起動（.kami をダブルクリックなど）は、すでに開いているウィンドウへ「open-paths」で渡す。
//
// ---- セキュリティの考え方 ----
// 原稿（.kami）は他人から受け取ることがあるので、画面の中の JavaScript が乗っ取られても被害が広がらないようにする。
//   ・命令は main ウィンドウだけが呼べる（build.rs の AppManifest + capabilities/default.json）
//   ・ファイル操作は「許可した場所」の中だけ: 設定の置き場所・専用の一時フォルダ・利用者が OS のダイアログで選んだ場所・
//     起動時に渡されたファイル。許可は <設定の置き場所>/.grants.json に Rust だけが書く（画面からは読み書きできない）
//   ・asset プロトコル（画像の表示）も、同じ「許可した場所」だけ
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pdf;

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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

// ==================================================================
// 許可した場所
// ==================================================================
const DENIED: &str = "KS_DENIED: この場所にはアクセスできません（Kamishibai で開いた・保存した場所の外です）";
const GRANTS_FILE: &str = ".grants.json";

#[derive(Default)]
struct Scope {
    roots: Mutex<Vec<PathBuf>>,
}

/// パスを正規化する（存在しない部分は、存在する親を正規化してから付け足す。「..」は認めない）
fn canon(p: &Path) -> Option<PathBuf> {
    if !p.is_absolute() {
        return None;
    }
    if let Ok(c) = std::fs::canonicalize(p) {
        return Some(c);
    }
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        match cur.file_name() {
            Some(name) => {
                rest.push(name.to_os_string());
                if !cur.pop() {
                    return None;
                }
            }
            None => return None,
        }
        if let Ok(mut c) = std::fs::canonicalize(&cur) {
            for name in rest.iter().rev() {
                let comp = Path::new(name);
                if comp.components().any(|x| !matches!(x, Component::Normal(_))) {
                    return None;
                }
                c.push(name);
            }
            return Some(c);
        }
    }
}

fn has_parent_dir(p: &str) -> bool {
    Path::new(p).components().any(|c| matches!(c, Component::ParentDir))
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
/// PDF の下書きなどに使う専用の一時フォルダ
fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("Kamishibai")
}
fn grants_file(app: &tauri::AppHandle) -> PathBuf {
    user_data_dir(app).join(GRANTS_FILE)
}

/// 許可した場所に加える（画像の表示＝asset プロトコルにも）。persist なら .grants.json にも残す
fn grant(app: &tauri::AppHandle, p: &Path, persist: bool) {
    let Some(c) = canon(p) else { return };
    let scope = app.state::<Scope>();
    let mut roots = scope.roots.lock().unwrap();
    if roots.iter().any(|r| c.starts_with(r)) {
        return;
    }
    let asset = app.asset_protocol_scope();
    let _ = asset.allow_directory(&c, true);
    let _ = asset.allow_file(&c);
    roots.push(c.clone());
    if persist {
        let list: Vec<String> = roots.iter().map(|r| r.to_string_lossy().into_owned()).collect();
        drop(roots);
        let file = grants_file(app);
        let _ = std::fs::create_dir_all(file.parent().unwrap_or(Path::new(".")));
        let _ = std::fs::write(&file, serde_json::to_vec_pretty(&list).unwrap_or_default());
    }
}

/// ファイルを選んだときの許可: そのファイル・保存の途中のファイル（.saving）・HTML の「_files」フォルダ
fn grant_file(app: &tauri::AppHandle, p: &Path) {
    grant(app, p, true);
    let s = p.to_string_lossy().into_owned();
    grant(app, Path::new(&(s.clone() + ".saving")), true);
    if let (Some(dir), Some(stem)) = (p.parent(), p.file_stem()) {
        grant(app, &dir.join(format!("{}_files", stem.to_string_lossy())), true);
    }
}

/// path が許可した場所の中なら、正規化したパスを返す
fn check(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || has_parent_dir(path) {
        return Err(DENIED.into());
    }
    let c = canon(Path::new(path)).ok_or(DENIED)?;
    // 許可の一覧そのものは、画面からは触らせない
    if let Some(g) = canon(&grants_file(app)) {
        if c == g {
            return Err(DENIED.into());
        }
    }
    let scope = app.state::<Scope>();
    let roots = scope.roots.lock().unwrap();
    if roots.iter().any(|r| c.starts_with(r)) {
        Ok(c)
    } else {
        Err(DENIED.into())
    }
}
pub(crate) fn check_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    check(app, path)
}

fn init_scope(app: &tauri::AppHandle) {
    let ud = user_data_dir(app);
    let _ = std::fs::create_dir_all(&ud);
    let _ = std::fs::create_dir_all(temp_dir());
    grant(app, &ud, false);
    grant(app, &temp_dir(), false);
    // 前に許可した場所（.grants.json）。まだ無ければ、これまでの「最近使ったもの」を引き継ぐ（この版より前に開いたもの）
    let gf = grants_file(app);
    let saved: Option<Vec<String>> = std::fs::read(&gf).ok().and_then(|b| serde_json::from_slice(&b).ok());
    match saved {
        Some(list) => {
            for p in list {
                grant(app, Path::new(&p), false);
            }
        }
        None => {
            #[derive(Deserialize)]
            struct Recent {
                path: String,
            }
            let recent: Vec<Recent> = std::fs::read(ud.join("recent.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            for r in recent {
                grant_file(app, Path::new(&r.path));
            }
            // 1 件も無くても、引き継ぎは済んだことにする
            let scope = app.state::<Scope>();
            let list: Vec<String> = scope.roots.lock().unwrap().iter().map(|r| r.to_string_lossy().into_owned()).collect();
            let _ = std::fs::write(&gf, serde_json::to_vec_pretty(&list).unwrap_or_default());
        }
    }
}

// ==================================================================
// ファイル操作（許可した場所の中だけ）
// ==================================================================
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
fn fs_read(app: tauri::AppHandle, path: String) -> Result<Response, String> {
    let p = check(&app, &path)?;
    std::fs::read(p).map(Response::new).map_err(err)
}

#[tauri::command]
fn fs_write(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("x-path がありません")?;
    let p = check(&app, &path)?;
    match request.body() {
        InvokeBody::Raw(bytes) => std::fs::write(&p, bytes).map_err(err),
        InvokeBody::Json(serde_json::Value::String(s)) => std::fs::write(&p, s.as_bytes()).map_err(err),
        _ => Err("書き込む内容が不正です".into()),
    }
}

#[tauri::command]
fn fs_stat(app: tauri::AppHandle, path: String) -> Result<Option<Stat>, String> {
    // 許可していない場所は「無い」と答える（中身は見せない）
    let Ok(p) = check(&app, &path) else { return Ok(None) };
    let Ok(m) = std::fs::metadata(&p) else { return Ok(None) };
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(Some(Stat { is_dir: m.is_dir(), is_file: m.is_file(), size: m.len(), mtime }))
}

#[tauri::command]
fn fs_list(app: tauri::AppHandle, path: String) -> Result<Vec<Entry>, String> {
    let p = check(&app, &path)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&p).map_err(err)? {
        let e = e.map_err(err)?;
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(Entry { name: e.file_name().to_string_lossy().into_owned(), is_dir });
    }
    Ok(out)
}

#[tauri::command]
fn fs_mkdir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = check(&app, &path)?;
    std::fs::create_dir_all(p).map_err(err)
}

#[tauri::command]
fn fs_remove_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = check(&app, &path)?;
    match std::fs::remove_file(&p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[tauri::command]
fn fs_remove_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = check(&app, &path)?;
    // 許可した場所そのもの（設定の置き場所・選んだフォルダ）は消さない。消せるのはその中だけ
    {
        let scope = app.state::<Scope>();
        if scope.roots.lock().unwrap().iter().any(|r| *r == p) {
            return Err(DENIED.into());
        }
    }
    match std::fs::remove_dir_all(&p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[tauri::command]
fn fs_rename(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    let a = check(&app, &from)?;
    let b = check(&app, &to)?;
    std::fs::rename(a, b).map_err(err)
}

// ==================================================================
// ダイアログ（選んだ場所を許可する）
// ==================================================================
#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

/// kind: "file"（開く）/ "folder"（フォルダを開く）/ "save"（保存先・新しく作る場所）
#[tauri::command]
async fn pick(app: tauri::AppHandle, kind: String, title: Option<String>, default_path: Option<String>, filters: Option<Vec<Filter>>) -> Result<Option<String>, String> {
    let mut d = app.dialog().file();
    if let Some(t) = title {
        d = d.set_title(t);
    }
    if let Some(dp) = default_path {
        let p = PathBuf::from(&dp);
        if p.is_absolute() {
            if let Some(dir) = p.parent() {
                d = d.set_directory(dir);
            }
            if let Some(name) = p.file_name() {
                d = d.set_file_name(name.to_string_lossy());
            }
        } else if !dp.is_empty() {
            d = d.set_file_name(dp);
        }
    }
    let filters = filters.unwrap_or_default();
    let all_exts: Vec<String> = filters.iter().flat_map(|f| f.extensions.iter().map(|e| e.to_lowercase())).collect();
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        d = d.add_filter(f.name.clone(), &exts);
    }
    let chosen = match kind.as_str() {
        "folder" => d.blocking_pick_folder(),
        "save" => d.blocking_save_file(),
        _ => d.blocking_pick_file(),
    };
    let Some(fp) = chosen else { return Ok(None) };
    let mut path = fp.into_path().map_err(|e| e.to_string())?;
    // 保存先に拡張子が無ければ、ここで付ける（画面側が後から付けると、許可した名前と食い違うため）
    if kind == "save" && !all_exts.is_empty() {
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !all_exts.contains(&ext) {
            let mut s = path.into_os_string();
            s.push(format!(".{}", all_exts[0]));
            path = PathBuf::from(s);
        }
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if kind == "folder" {
        grant(&app, &path, true);
    } else if kind == "file" && (name == "slides.md" || name == "theme.json") {
        // slides.md・theme.json を選んだときは、そのフォルダ（プロジェクト・テーマ）を開く
        if let Some(dir) = path.parent() {
            grant(&app, dir, true);
        }
    } else {
        grant_file(&app, &path);
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 許可していない場所を開いてよいか、OS のダイアログで利用者に聞く（「最近使ったもの」が前の版のものだった場合など）
#[tauri::command]
async fn confirm_open(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    if !Path::new(&path).is_absolute() || has_parent_dir(&path) {
        return Ok(false);
    }
    if check(&app, &path).is_ok() {
        return Ok(true);
    }
    let ok = app
        .dialog()
        .message(format!("次の場所を開きますか？\n\n{}", path))
        .title("Kamishibai")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("開く".into(), "やめる".into()))
        .blocking_show();
    if ok {
        let p = PathBuf::from(&path);
        if p.is_dir() {
            grant(&app, &p, true);
        } else {
            grant_file(&app, &p);
        }
    }
    Ok(ok)
}

/// 書き出したファイルを既定のアプリで開く（書き出しの形式だけ。実行ファイルなどは開かない）
#[tauri::command]
fn open_exported(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = check(&app, &path)?;
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["html", "pdf", "pptx", "docx", "odp", "odt"].contains(&ext.as_str()) {
        return Err(DENIED.into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// エクスプローラーで場所を表示する（許可した場所の中だけ）
#[tauri::command]
fn reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = check(&app, &path)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

/// 起動時の引数のうち、ファイルとして存在するもの（.kami・フォルダ）
fn path_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && PathBuf::from(a).exists())
        .cloned()
        .collect()
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
    // 起動時に渡されたファイルは、利用者が開こうとしたもの（ダブルクリックなど）なので許可する
    for p in &paths {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            grant(&app, &pb, true);
        } else {
            grant_file(&app, &pb);
        }
    }
    AppInfo {
        user_data: user_data_dir(&app).to_string_lossy().into_owned(),
        temp: temp_dir().to_string_lossy().into_owned(),
        platform: std::env::consts::OS.to_string(),
        version: app.package_info().version.to_string(),
        args: paths,
    }
}

/// 発表・資料プレビューのウィンドウを開く（同じ label があれば閉じて開き直す）。
/// 開けるのは、設定の置き場所の preview フォルダにある HTML（asset プロトコル）だけ。
/// 発表画面の「発表者ビュー」（S キー）は window.open で別ウィンドウを開くので、それを許可しておく。
// Windows では、同期の命令の中でウィンドウを作ると止まることがあるので async にする（Tauri の注意事項）
#[tauri::command]
async fn open_page(app: tauri::AppHandle, label: String, file: String, hash: String, title: String, width: f64, height: f64) -> Result<(), String> {
    if label != "present" && label != "doc" {
        return Err(DENIED.into());
    }
    let p = check(&app, &file)?;
    let preview = canon(&user_data_dir(&app).join("preview")).ok_or(DENIED)?;
    if !p.starts_with(&preview) {
        return Err(DENIED.into());
    }
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.destroy();
    }
    // asset プロトコルの URL（画面の convertFileSrc と同じ形）
    let enc: String = url_encode(&p.to_string_lossy());
    let base = if cfg!(windows) { "http://asset.localhost/" } else { "asset://localhost/" };
    let frag = if hash.starts_with('#') && hash.chars().all(|c| c.is_ascii_alphanumeric() || c == '#' || c == '.' || c == '-') { hash } else { String::new() };
    let url = tauri::Url::parse(&format!("{}{}{}", base, enc, frag)).map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(title)
        .inner_size(width, height)
        .disable_drag_drop_handler()
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "-_.~".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn main() {
    tauri::Builder::default()
        .manage(Scope::default())
        // 2 つ目の起動は、開いているウィンドウにファイルを渡して前に出す（渡されたファイルは許可する）
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = path_args(&args);
            for p in &paths {
                let pb = PathBuf::from(p);
                if pb.is_dir() {
                    grant(app, &pb, true);
                } else {
                    grant_file(app, &pb);
                }
            }
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
        .setup(|app| {
            init_scope(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_read,
            fs_write,
            fs_stat,
            fs_list,
            fs_mkdir,
            fs_remove_file,
            fs_remove_dir,
            fs_rename,
            pick,
            confirm_open,
            open_exported,
            reveal,
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
                for p in &paths {
                    grant_file(_app, Path::new(p));
                }
                let _ = _app.emit_to("main", "open-paths", paths);
            }
        });
}
