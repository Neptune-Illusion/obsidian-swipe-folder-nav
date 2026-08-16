import { Editor, Notice } from "obsidian";

interface ScrollDom {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

interface EditorWithScrollDom extends Editor {
	cm?: {
		scrollDOM?: ScrollDom;
	};
}

/** Move the editor cursor to the last line and scroll the viewport beyond it. */
export function scrollPastEnd(editor: Editor): void {
	if (!editor) {
		new Notice("No active editor to scroll.");
		return;
	}

	const lastLine = editor.lastLine();
	editor.setCursor({
		line: lastLine,
		ch: editor.getLine(lastLine).length,
	});

	const scrollDom = (editor as EditorWithScrollDom).cm?.scrollDOM;
	if (!scrollDom) return;

	// CodeMirror clamps this to its maximum scroll position when necessary.
	scrollDom.scrollTop = scrollDom.scrollHeight;
	scrollDom.scrollTop += scrollDom.clientHeight / 2;
}
