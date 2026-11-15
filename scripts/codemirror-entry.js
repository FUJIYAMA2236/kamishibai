/*
 * codemirror-entry.js — vendor/codemirror.min.js の元。エディタで使う CodeMirror 6 の部品だけを集める。
 * scripts/build-codemirror.js が esbuild で 1 ファイルにまとめ、window.CM として公開する。
 * 使う部品を増やしたら、ここに足して `npm run vendor:editor` を実行する。
 */
export { EditorState, EditorSelection, StateField, StateEffect, Compartment, Transaction, Annotation } from '@codemirror/state';
export {
  EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection, dropCursor, highlightActiveLine,
  placeholder, rectangularSelection, crosshairCursor,
} from '@codemirror/view';
export {
  history, defaultKeymap, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth, isolateHistory,
} from '@codemirror/commands';
export { syntaxTree, ensureSyntaxTree, syntaxHighlighting, HighlightStyle, indentOnInput } from '@codemirror/language';
export { markdown, markdownLanguage, markdownKeymap, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
export { tags } from '@lezer/highlight';
