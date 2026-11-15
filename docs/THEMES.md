# テーマの作り方

テーマ = `<テーマID>/` フォルダ。中身は 2 つだけです。

```
my-brand/
  theme.json   色・フォント・余白などの「トークン」（必須）
  theme.css    トークンで表現できない装飾（任意）
```

テーマは次の 3 か所から探します（上が優先）。

| 場所 | 中身 |
| --- | --- |
| `<プロジェクト>/themes/<ID>/` | そのプロジェクトに同梱したテーマ（.kami に入っていたものもここ） |
| ユーザーのテーマ（Windows: `%APPDATA%\Kamishibai\themes\<ID>/`） | GUI で作ったテーマ。どのプロジェクトからも使える |
| ツール同梱 `themes/<ID>/` | Snow / Paper / Midnight など。直接は編集できない |

1 ファイル（.kami）に保存すると、使っているテーマ（同梱以外）も一緒に入るので、別の PC でも同じ見た目で開けます。

## いちばん簡単な方法（GUI）

1. 「デザイン」→「全体」タブで、色・フォント・飾りを調整する
2. 「デザイン」→「テーマ」タブ →「新しいテーマとして保存」に ID と名前を入れて「テーマを作成」
3. ユーザーのテーマとして保存され、以後は他のプロジェクトからも選べる

## theme.json

```json
{
  "name": "自社ブランド",
  "description": "一覧に出る説明",
  "category": "simple",
  "order": 20,
  "aspect": "16:9",
  "tokens": {
    "bg": "#0b1020",
    "text": "#e8ecf8",
    "accent": "#7c9cff",
    "headingStyle": "gradient"
  },
  "animation": { "transition": "fade", "entrance": "rise" },
  "chrome": { "pageNumber": true, "progress": true }
}
```

`category` はテーマ一覧での分類（`simple` = シンプル / `decorative` = 装飾あり）、`order` は並び順（小さいほど先）です。
シンプルなテーマは、背景にグラデーションを使わず、`headingStyle` に `gradient` を使わないこと（テストで確認しています）。
`accent2` を `accent` と同じ色にすると、見出しの下線や進捗バーも単色になります。

書かなかった項目は既定値になります。使えるトークンの一覧と既定値は `src/core/schema.js` の `TOKENS` が正です。主なもの:

| キー | 内容 |
| --- | --- |
| `bg` `surface` `text` `muted` `accent` `accent2` | 背景 / コード等のパネル / 文字 / 補助文字 / アクセント 2 色 |
| `fontHeading` `fontBody` `fontMono` | フォント（CSS の font-family 形式） |
| `baseSize` `headingScale` `titleScale` `headingWeight` `lineHeight` `letterSpacing` | 文字の大きさ・太さ・行間・字間 |
| `padding` `radius` | 余白・角丸（コードブロック等） |
| `colStyle` / `boxRadius` | カラムの囲み（`none` `outline` `fill` `card`）/ 箱の角丸（px、既定 20） |
| `headingStyle` | 見出しの飾り: `plain` `bar` `underline` `gradient` `tag` |
| `bulletStyle` | 箇条書きの記号: `dot` `dash` `arrow` `check` `square` |
| `titleAlign` / `bodyAlign` | タイトルの横位置（`left` `center`）/ 本文の縦位置（`top` `center`） |
| `bgSlide` `bgTitle` `bgSection` | 背景を CSS の `background` 値で（グラデーション等） |

背景の値の中では、ほかのトークンを `var(--ks-accent)` のように参照できます:

```json
"bgTitle": "radial-gradient(900px 520px at 90% -10%, color-mix(in srgb, var(--ks-accent) 34%, transparent), transparent 62%), var(--ks-bg)"
```

`animation` のキー: `transition`（`none` `fade` `slide` `zoom` `blur`）、`entrance`（`none` `fade` `rise` `slide` `zoom` `blur`）、
`build`（`none` `items`）、`duration`（ms）、`stagger`（ms）。

## theme.css

スライドはすべて `.ks-deck` の中にあるので、セレクタは `.ks-deck` から書きます。

```css
/* タイトルを大文字に */
.ks-deck .ks-layout-title h1 { text-transform: uppercase; }

/* セクションスライドだけ色を反転 */
.ks-deck .ks-layout-section { --ks-text: #fff; --ks-muted: #ccc; }
```

よく使うクラス:

| セレクタ | 対象 |
| --- | --- |
| `.ks-slide` | スライド 1 枚 |
| `.ks-layout-title` / `-section` / `-content` / `-center` / `-columns` / `-image-right` / `-image-left` / `-image-full` / `-quote` | レイアウト別 |
| `.ks-bg` | 背景用の空き要素（`::before` で模様を足せる） |
| `.ks-head` / `.ks-body` / `.ks-media` / `.ks-cols` / `.ks-col` | 見出し・本文・横の画像・カラム |
| `.ks-code` / `.ks-figure` / `.ks-mermaid` | コード・図・mermaid |
| `.ks-chrome` / `.ks-footer` / `.ks-page` / `.ks-progress` | フッター・ページ番号・進捗バー |

同梱テーマ（`themes/midnight` など）の `theme.css` が実例になります。

## 優先順位

既定値（schema.js） < テーマ（theme.json） < デッキの調整（deck.json の `tokens`） < スライド個別（deck.json の `slides.<ID>`）

デッキで調整した内容をテーマに戻したいときは、「テーマ」タブの「いまの調整をこのテーマに反映」を使います（同梱テーマは直接編集できないので、先に複製してください）。
