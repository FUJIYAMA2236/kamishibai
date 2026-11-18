// アプリの命令（main.rs の fs_* など）を「許可が必要なもの」として登録する。
// これをしないと、Tauri 2 ではどのウィンドウからでも命令を呼べてしまう（発表・資料・PDF 用のウィンドウからも）。
// 許可は capabilities/default.json で main ウィンドウにだけ与える。
const COMMANDS: &[&str] = &[
    "fs_read",
    "fs_write",
    "fs_stat",
    "fs_list",
    "fs_mkdir",
    "fs_remove_file",
    "fs_remove_dir",
    "fs_rename",
    "pick",
    "confirm_open",
    "open_exported",
    "reveal",
    "app_info",
    "open_page",
    "print_pdf",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri-build に失敗しました");
}
