import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { marked } from "marked";
window.CM = { EditorView, basicSetup, keymap, indentWithTab, EditorState, python, oneDark };
window.marked = marked;
