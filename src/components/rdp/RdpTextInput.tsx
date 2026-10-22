import { useEffect, useRef, useState } from "react";
import { validRdpText } from "../../utils/rdp";

interface Props { onSend: (text: string) => void; onClose: () => void; }

/** Local IME owns composition. Only the explicit Send action reaches the remote keyboard. */
export default function RdpTextInput({ onSend, onClose }: Props) {
  const [text, setText] = useState("");
  const [composing, setComposing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => {
    window.addEventListener("blur", onClose);
    return () => window.removeEventListener("blur", onClose);
  }, [onClose]);
  return <div className="rdp-text-input">
    <label>Text input / 한글 입력
      <input ref={field} aria-label="Text to type remotely" value={text} maxLength={256}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return;
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          // Enter belongs to local composition; it never submits text or presses remote Enter.
          if (event.key === "Enter") event.preventDefault();
        }} onKeyUp={(event) => event.stopPropagation()} />
    </label>
    <button disabled={composing || !validRdpText(text)} onClick={() => {
      if (composing || !validRdpText(text)) return;
      onSend(text); setText(""); field.current?.focus();
    }}>Send text</button>
    <button onClick={onClose}>Close text input</button>
    <span className="rdp-note">Finish composing, then Send text to the focused remote field. Enter is not sent. Short, single-line text only. Text is not saved.</span>
    {text && !validRdpText(text) && <span className="rdp-error" role="alert">Use a short line without line breaks or control characters.</span>}
  </div>;
}
