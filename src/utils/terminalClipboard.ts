import type { Terminal } from "@xterm/xterm";

export function clipboardShortcut(event: KeyboardEvent, mac: boolean): "copy" | "paste" | "selectAll" | null {
  if (event.type !== "keydown" || event.altKey) return null;
  // Physical keys keep working with Korean/other non-Latin input layouts.
  const key = event.code || `Key${event.key.toUpperCase()}`;
  if (mac && event.metaKey && !event.ctrlKey && !event.shiftKey) {
    return key === "KeyC" ? "copy" : key === "KeyV" ? "paste" : key === "KeyA" ? "selectAll" : null;
  }
  if (!mac && !event.metaKey) {
    if (event.ctrlKey && key === "KeyV") return "paste";
    if (!event.ctrlKey && event.shiftKey && key === "Insert") return "paste";
    if (event.ctrlKey && event.shiftKey && key === "KeyC") return "copy";
  }
  return null; // Ctrl+C remains interrupt; Ctrl+A remains shell line start.
}

interface Options {
  inputTarget: () => string | null;
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
  onError: (message: string) => void;
  onMenu: (position: { x: number; y: number }) => void;
}

export function attachTerminalClipboard(term: Terminal, options: Options) {
  const element = term.element!;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  let disposed = false;
  let generation = 0;
  let queue = Promise.resolve();
  const invalidate = () => { generation++; };
  const copy = async () => {
    const selection = term.getSelection();
    if (!selection || disposed) return;
    options.onError("");
    try { await options.writeText(selection); }
    catch { if (!disposed) options.onError("Could not copy to the clipboard. Try again."); }
  };
  const paste = (text?: string) => {
    const target = options.inputTarget();
    if (disposed || !target) return;
    const epoch = generation;
    options.onError("");
    // Start the clipboard read at the user's action, but deliver multiple pastes in order.
    const pending = (text === undefined ? options.readText() : Promise.resolve(text))
      .then((value) => ({ value, failed: false }), () => ({ value: "", failed: true }));
    queue = queue.then(async () => {
      const result = await pending;
      if (disposed || epoch !== generation || target !== options.inputTarget() || document.activeElement !== term.textarea) return;
      if (result.failed) options.onError("Could not paste from the clipboard. Try again.");
      else if (result.value) term.paste(result.value); // Preserve xterm's newline/bracketed-paste handling.
    });
  };
  term.attachCustomKeyEventHandler((event) => {
    const action = clipboardShortcut(event, mac);
    if (!action) return true;
    event.preventDefault(); event.stopPropagation();
    if (action === "copy") void copy();
    else if (action === "paste") paste();
    else term.selectAll();
    return false;
  });
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault(); event.stopPropagation();
    paste(event.clipboardData ? event.clipboardData.getData("text/plain") : undefined);
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation();
    options.onMenu({ x: event.clientX, y: event.clientY });
  };
  element.addEventListener("paste", onPaste, true);
  element.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("blur", invalidate);
  return {
    copy, paste, invalidate, canPaste: () => !disposed && !!options.inputTarget(),
    dispose() {
      disposed = true; invalidate();
      element.removeEventListener("paste", onPaste, true);
      element.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", invalidate);
    },
  };
}
