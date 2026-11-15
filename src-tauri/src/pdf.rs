// HTML ファイルを PDF にする。
//   Windows: 見えないウィンドウで HTML を開き、図（mermaid）を描き終えるのを待ってから WebView2 の PrintToPdf で書き出す。
//   それ以外: まだ対応していない（画面側が「印刷」ダイアログで PDF に保存する方法に切り替える）。
#[tauri::command]
pub async fn print_pdf(
    app: tauri::AppHandle,
    html: String,
    pdf: String,
    kind: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    imp::print(app, html, pdf, kind, width, height).await
}

#[cfg(not(windows))]
mod imp {
    pub async fn print(_: tauri::AppHandle, _: String, _: String, _: String, _: f64, _: f64) -> Result<(), String> {
        Err("unsupported".into())
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{ExecuteScriptCompletedHandler, PrintToPdfCompletedHandler};
    use windows::core::{Interface, HSTRING};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// ページで JavaScript を実行して、結果（JSON の文字列）を受け取る
    fn eval(win: &WebviewWindow, script: &str) -> Option<String> {
        let (tx, rx) = mpsc::channel::<Option<String>>();
        let script = script.to_string();
        win.with_webview(move |wv| unsafe {
            let tx2 = tx.clone();
            let r = (|| -> windows::core::Result<()> {
                let core = wv.controller().CoreWebView2()?;
                let handler = ExecuteScriptCompletedHandler::create(Box::new(move |res, json| {
                    let _ = tx2.send(res.ok().map(|_| json));
                    Ok(())
                }));
                core.ExecuteScript(&HSTRING::from(script), &handler)
            })();
            if r.is_err() {
                let _ = tx.send(None);
            }
        })
        .ok()?;
        rx.recv_timeout(Duration::from_secs(10)).ok().flatten()
    }

    fn run(win: &WebviewWindow, pdf: &str, kind: &str, width: f64, height: f64) -> Result<(), String> {
        // 図（mermaid）を描き終えるのを待つ（書き出した HTML は終わると html に ks-ready を付ける）
        let mut ready = false;
        for _ in 0..200 {
            let v = eval(win, "document.readyState === 'complete' && document.documentElement.classList.contains('ks-ready')");
            if v.as_deref() == Some("true") {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if !ready {
            return Err("ページの準備が終わりませんでした".into());
        }
        std::thread::sleep(Duration::from_millis(300));

        let (tx, rx) = mpsc::channel::<bool>();
        let pdf = pdf.to_string();
        let doc = kind == "doc";
        win.with_webview(move |wv| unsafe {
            let tx2 = tx.clone();
            let r = (|| -> windows::core::Result<()> {
                let core: ICoreWebView2_7 = wv.controller().CoreWebView2()?.cast()?;
                let env: ICoreWebView2Environment6 = wv.environment().cast()?;
                let s = env.CreatePrintSettings()?;
                if doc {
                    // A4 縦。余白は上下 18mm / 左右 16mm
                    s.SetPageWidth(8.27)?;
                    s.SetPageHeight(11.69)?;
                    s.SetMarginTop(0.71)?;
                    s.SetMarginBottom(0.71)?;
                    s.SetMarginLeft(0.63)?;
                    s.SetMarginRight(0.63)?;
                } else {
                    // スライドの大きさ（px → インチ）。1 スライド = 1 ページ・余白なし
                    s.SetPageWidth(width / 96.0)?;
                    s.SetPageHeight(height / 96.0)?;
                    s.SetMarginTop(0.0)?;
                    s.SetMarginBottom(0.0)?;
                    s.SetMarginLeft(0.0)?;
                    s.SetMarginRight(0.0)?;
                }
                s.SetShouldPrintBackgrounds(true)?;
                s.SetShouldPrintHeaderAndFooter(false)?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |res, ok| {
                    let _ = tx2.send(res.is_ok() && ok);
                    Ok(())
                }));
                core.PrintToPdf(&HSTRING::from(pdf.as_str()), &s, &handler)
            })();
            if r.is_err() {
                let _ = tx.send(false);
            }
        })
        .map_err(|e| e.to_string())?;
        match rx.recv_timeout(Duration::from_secs(180)) {
            Ok(true) => Ok(()),
            _ => Err("PDF の書き出しに失敗しました".into()),
        }
    }

    pub async fn print(app: tauri::AppHandle, html: String, pdf: String, kind: String, width: f64, height: f64) -> Result<(), String> {
        let url = tauri::Url::from_file_path(&html).map_err(|_| "HTML の場所が不正です".to_string())?;
        let label = format!("pdf-{}", COUNTER.fetch_add(1, Ordering::SeqCst));
        let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
            .visible(false)
            .inner_size(1280.0, 900.0)
            .build()
            .map_err(|e| e.to_string())?;
        let result = run(&win, &pdf, &kind, width, height);
        let _ = win.destroy();
        result
    }
}
