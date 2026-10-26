import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import RdpConnectionForm from "./RdpConnectionForm";
import RdpCertificateForm from "./RdpCertificateForm";
import RdpClipboardPanel from "./RdpClipboardPanel";
import useRdpClipboard from "./useRdpClipboard";
import RdpTextInput from "./RdpTextInput";
import Select from "../common/Select";
import useRdpViewport from "./useRdpViewport";
import type { SessionStatus } from "../../types";
import type { RdpApproval, RdpCertificate, RdpConfig, RdpEvent } from "../../types/rdp";
import { decodeRdpFrame, rdpDisplaySize, rdpPoint, rdpScancode, RdpInputQueue } from "../../utils/rdp";
import { RdpConnection, RdpConnectionError } from "../../utils/rdpConnection";
import "./RdpSession.css";

type Phase = "idle" | "reconnecting" | "closing" | "connecting" | "certificate" | "authenticating" | "connected" | "ended" | "error";
interface Props {
  tabId: string;
  isActive: boolean;
  onSessionStatus: (id: string, status: SessionStatus) => void;
  onTitleChange: (id: string, title: string) => void;
}
export default function RdpSession({ tabId, isActive, onSessionStatus, onTitleChange }: Props) {
  const [config, setConfig] = useState<RdpConfig>({ host: "", port: 3389, username: "", domain: "", width: 1280, height: 720, desktop_scale_factor: 0 });
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [certificate, setCertificate] = useState<RdpCertificate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const [displayArea, setDisplayArea] = useState(0);
  const [resolution, setResolution] = useState("1280x720");
  const [resizing, setResizing] = useState(false);
  const [resizeNotice, setResizeNotice] = useState<string | null>(null);
  const resizePending = useRef(false);
  const resizeSerial = useRef(0);
  const remoteSize = useRef(size);
  const [viewMode, setViewMode] = useState<"fit" | "pixels">("fit");
  const [textInput, setTextInput] = useState(false);
  const [lastConnection, setLastConnection] = useState<{ config: RdpConfig; name: string } | null>(null);
  const screen = useRef<HTMLDivElement>(null);
  const viewport = useRdpViewport(screen, phase === "connected" && isActive);
  const displaySize = rdpDisplaySize(size.width, size.height, viewport.width, viewport.height, viewMode, viewport.pixelRatio);
  const closeTextInput = useCallback(() => setTextInput(false), []);
  const canvas = useRef<HTMLCanvasElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const connection = useRef<RdpConnection | null>(null);
  const transitioning = useRef(false);
  const authenticatingAttempt = useRef<number | null>(null);
  const currentId = useRef<string | null>(null);
  const inputs = useRef<RdpInputQueue | null>(null);
  const frameRequest = useRef<{ id: string; promise: Promise<ArrayBuffer> } | null>(null);

  const clipboard = useRdpClipboard(() => currentId.current, () => disconnect("Clipboard sharing could not be stopped. The connection was closed."));

  const clearSession = useCallback(() => {
    clipboard.reset();
    currentId.current = null;
    frameRequest.current = null;
    inputs.current?.close();
    inputs.current = null;
    setSessionId(null);
    setCertificate(null);
    setHasFrame(false);
    setTextInput(false);
    setDisplayArea(0); setResizing(false); setResizeNotice(null);
    resizePending.current = false; resizeSerial.current++;
  }, [clipboard.reset]);

  const disconnect = useCallback((message?: string) => {
    const attempt = ++generation.current;
    transitioning.current = true;
    clearSession();
    setError(message ?? null);
    setPhase("closing");
    onSessionStatus(tabId, message ? "error" : "ended");
    void (connection.current?.stop() ?? Promise.resolve()).then(() => {
      if (generation.current === attempt) setPhase(message ? "error" : "ended");
    }).catch(() => {
      if (generation.current !== attempt) return;
      setError(new RdpConnectionError("close").message); setPhase("error");
      onSessionStatus(tabId, "error");
    }).finally(() => { if (generation.current === attempt) transitioning.current = false; });
  }, [clearSession, onSessionStatus, tabId]);

  useEffect(() => {
    const owner = new RdpConnection({
      open: (settings, onEvent) => {
        const events = new Channel<RdpEvent>();
        events.onmessage = onEvent;
        return invoke<string>("rdp_connect", { config: settings, events });
      },
      close: (id) => invoke<void>("rdp_close", { sessionId: id }),
    });
    connection.current = owner;
    onSessionStatus(tabId, "ended");
    return () => {
      generation.current++;
      inputs.current?.close();
      currentId.current = null;
      if (connection.current === owner) connection.current = null;
      void owner.dispose().catch(() => {});
    };
  }, [onSessionStatus, tabId]);

  async function connect(config: RdpConfig, name: string) {
    const owner = connection.current;
    if (!owner || transitioning.current) return;
    transitioning.current = true;
    const attempt = ++generation.current;
    clearSession();
    setPhase("reconnecting"); setError(null);
    onSessionStatus(tabId, "connecting");
    const settings = { ...config, host: config.host.trim(), username: config.username.trim(), domain: config.domain.trim() };
    setLastConnection({ config: settings, name });
    onTitleChange(tabId, `RDP · ${name || settings.host}`);
    const onEvent = (event: RdpEvent) => {
      if (generation.current !== attempt) return;
      if (event.type === "clipboard_state" || event.type === "clipboard_result") { clipboard.handle(event); }
      else if (event.type === "certificate") { setCertificate(event); setPhase("certificate"); }
      else if (event.type === "connected") {
        remoteSize.current = { width: event.width, height: event.height };
        setSize(remoteSize.current);
        if (canvas.current) { canvas.current.width = event.width; canvas.current.height = event.height; }
        setResolution(`${event.width}x${event.height}`);
        setPhase("connected"); setCertificate(null); setHasFrame(false);
        onSessionStatus(tabId, "connected");
      } else if (event.type === "display_control") { setDisplayArea(event.max_area); if (!event.max_area) setResizeNotice(null); }
      else if (event.type === "resize_result") {
        resizePending.current = false; resizeSerial.current++;
        setResizing(false);
        setResizeNotice(event.applied ? "Remote resolution updated." : "The server did not apply the requested resolution. You can keep using this connection or reconnect with a different desktop size.");
      } else if (event.type === "error") disconnect(event.message);
      else if (event.type === "ended") disconnect();
      else setPhase(event.type);
    };
    try {
      const id = await owner.start(settings, onEvent, () => { if (generation.current === attempt) setPhase("connecting"); });
      if (generation.current !== attempt || !id) return;
      currentId.current = id; setSessionId(id);
    } catch (error) {
      if (generation.current !== attempt) return;
      setError(error instanceof RdpConnectionError ? error.message : new RdpConnectionError("connect").message);
      setPhase("error"); onSessionStatus(tabId, "error");
    } finally { if (generation.current === attempt) transitioning.current = false; }
  }
  async function authenticate(approval: RdpApproval) {
    if (!certificate || !sessionId || currentId.current !== sessionId || authenticatingAttempt.current === generation.current) return;
    const attempt = generation.current;
    authenticatingAttempt.current = attempt;
    setPhase("authenticating");
    try { await invoke("rdp_authenticate", { sessionId, approval }); }
    catch { if (generation.current === attempt) disconnect("Certificate approval could not be completed. Reconnect to review the current saved certificate."); }
  }

  async function resizeRemote() {
    if (!sessionId || phase !== "connected" || !displayArea || resizePending.current) return;
    const [width, height] = resolution.split("x").map(Number);
    const attempt = generation.current;
    const request = ++resizeSerial.current;
    resizePending.current = true; setResizing(true); setResizeNotice(null); setTextInput(false);
    inputs.current?.release();
    try { await invoke("rdp_resize", { sessionId, size: { width, height } }); }
    catch {
      if (generation.current !== attempt || resizeSerial.current !== request) return;
      resizePending.current = false; setResizing(false);
      setResizeNotice("The resolution request could not be sent. Try again or reconnect with a different desktop size.");
    }
  }

  useEffect(() => {
    if (phase !== "connected" || !sessionId) return;
    const queue = new RdpInputQueue(
      (events) => invoke("rdp_input", { sessionId, events }),
      () => { if (currentId.current === sessionId) disconnect("RDP input stopped responding. The connection was closed."); },
    );
    inputs.current = queue;
    return () => { queue.close(); if (inputs.current === queue) inputs.current = null; };
  }, [phase, sessionId, disconnect]);

  useEffect(() => {
    if (!isActive) { inputs.current?.release(); setTextInput(false); clipboard.stop(); }
  }, [isActive, clipboard.stop]);

  useEffect(() => {
    if (phase !== "connected" || !sessionId || !isActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const draw = async () => {
      try {
        // A tab can become visible again before its previous frame request settles.
        // Share that request instead of starting a second backend read.
        if (!frameRequest.current || frameRequest.current.id !== sessionId) {
          const request = { id: sessionId, promise: invoke<ArrayBuffer>("rdp_frame", { sessionId }) };
          request.promise = request.promise.finally(() => {
            if (frameRequest.current === request) frameRequest.current = null;
          });
          frameRequest.current = request;
        }
        const buffer = await frameRequest.current.promise;
        if (cancelled || currentId.current !== sessionId) return;
        const frame = decodeRdpFrame(buffer);
        if (frame && canvas.current && frame.width === remoteSize.current.width && frame.height === remoteSize.current.height) {
          const context = canvas.current.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          if (canvas.current.width !== frame.width) canvas.current.width = frame.width;
          if (canvas.current.height !== frame.height) canvas.current.height = frame.height;
          context.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
          setHasFrame(true);
        }
        timer = setTimeout(draw, 50);
      } catch { if (!cancelled && currentId.current === sessionId) disconnect("RDP display stopped responding. Reconnect to try again."); }
    };
    void draw();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, sessionId, isActive, disconnect]);

  function point(clientX: number, clientY: number) {
    const surface = canvas.current!;
    return rdpPoint(clientX, clientY, surface.getBoundingClientRect(), remoteSize.current.width, remoteSize.current.height);
  }
  useEffect(() => {
    const surface = canvas.current;
    if (!surface || phase !== "connected" || !isActive) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.deltaY || resizePending.current) return;
      inputs.current?.push({ type: "wheel", ...point(event.clientX, event.clientY), delta: event.deltaY > 0 ? -120 : 120 });
    };
    const release = () => inputs.current?.release();
    surface.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", release);
    return () => { surface.removeEventListener("wheel", wheel); window.removeEventListener("blur", release); };
  }, [phase, isActive]);

  function key(event: KeyboardEvent<HTMLCanvasElement>, down: boolean) {
    if (resizePending.current) { event.preventDefault(); return; }
    if (event.ctrlKey && event.altKey && event.shiftKey) {
      event.preventDefault(); inputs.current?.release(); disconnectButton.current?.focus(); return;
    }
    if (event.nativeEvent.isComposing) return;
    const code = rdpScancode(event.code);
    if (code === undefined) return;
    event.preventDefault(); event.stopPropagation();
    inputs.current?.push({ type: "key", code, down });
  }
  const busy = ["reconnecting", "closing", "connecting", "certificate", "authenticating", "connected"].includes(phase);
  const reconnect = () => { if (lastConnection) void connect(lastConnection.config, lastConnection.name); };
  return <section className="rdp-session" style={{ display: isActive ? "flex" : "none" }} aria-label="RDP session">
    <div className="rdp-toolbar">
      <span>Remote desktop <span className="rdp-note">Beta</span></span>
      {phase === "connected" && <span className="rdp-note">{size.width} × {size.height} · Ctrl+Alt+Shift releases input</span>}
      {phase === "connected" && <>
        <Select aria-label="RDP display view" value={viewMode} onValueChange={(value) => setViewMode(value as "fit" | "pixels")}>
          <option value="fit">Fit to window</option><option value="pixels">1:1 pixels</option>
        </Select>
        <button aria-pressed={clipboard.open} onClick={clipboard.toggle}>Clipboard</button>
        <button disabled={resizing} aria-pressed={textInput} onClick={() => setTextInput((open) => !open)}>Text input / 한글</button>
      </>}
      {phase === "connected" && <button disabled={resizing} onClick={() => {
        for (const down of [true, false]) for (const code of (down ? [0x1d, 0x38, 0x153] : [0x153, 0x38, 0x1d])) inputs.current?.push({ type: "key", code, down });
        canvas.current?.focus();
      }}>Ctrl+Alt+Del</button>}
      {phase === "connected" && <button onClick={reconnect}>Reconnect</button>}
      {busy && <button ref={disconnectButton} disabled={phase === "closing"} onClick={() => disconnect()}>{phase === "connected" ? "Disconnect" : phase === "closing" ? "Disconnecting…" : "Cancel connection"}</button>}
    </div>
    {phase === "connected" && <div className="rdp-resolution">
      <label>Remote resolution <Select aria-label="Remote resolution" value={resolution} disabled={!displayArea || resizing} onValueChange={setResolution}>
        {!["640x480", "1280x720", "1600x900", "1920x1080"].includes(resolution) && <option value={resolution}>{resolution.replace("x", " × ")}</option>}
        {[[640, 480], [1280, 720], [1600, 900], [1920, 1080]].map(([width, height]) => <option key={width} value={`${width}x${height}`} disabled={width * height > displayArea}>{width} × {height}</option>)}
      </Select></label>
      <button disabled={!displayArea || resizing || resolution === `${size.width}x${size.height}`} onClick={() => void resizeRemote()}>{resizing ? "Applying…" : "Apply resolution"}</button>
      <span className="rdp-note" role="status">{resizing ? "Waiting for the server. Remote input is paused…" : resizeNotice ?? (displayArea ? "Changes this session only. Saved profiles stay unchanged." : "The server has not enabled live resolution changes. Reconnect to change desktop size.")}</span>
    </div>}
    {phase === "connected" && isActive && clipboard.open && <RdpClipboardPanel clipboard={clipboard} />}
    {phase === "connected" && isActive && textInput && <RdpTextInput onClose={closeTextInput} onSend={(text) => {
      inputs.current?.push({ type: "text", text });
    }} />}
    {phase === "connected" ? <div ref={screen} className={`rdp-screen rdp-screen-${viewMode}${resizing ? " rdp-resizing" : ""}`}>
      {!hasFrame && <p className="rdp-wait" role="status">Waiting for the remote desktop…</p>}
      <div className="rdp-surface" style={displaySize}>
      <canvas ref={canvas} tabIndex={resizing ? -1 : 0} aria-disabled={resizing}
        aria-label="Remote desktop. Click to focus. Ctrl Alt Shift releases input."
        onKeyDown={(event) => key(event, true)} onKeyUp={(event) => key(event, false)}
        onBlur={() => inputs.current?.release()} onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => { if (event.button > 2 || resizePending.current) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); inputs.current?.push({ type: "pointer", ...point(event.clientX, event.clientY), button: event.button, down: true }); }}
        onPointerUp={(event) => { if (event.button <= 2 && !resizePending.current) inputs.current?.push({ type: "pointer", ...point(event.clientX, event.clientY), button: event.button, down: false }); }}
        onPointerMove={(event) => !resizePending.current && inputs.current?.push({ type: "pointer", ...point(event.clientX, event.clientY), button: null, down: false })}
        onPointerCancel={() => inputs.current?.release()} />
      </div>
    </div> : null}
    <div className="rdp-content" style={{ display: phase === "connected" ? "none" : undefined }}>
      {error && <p className="rdp-error" role="alert">{error}</p>}
      {phase === "ended" && <p className="rdp-note rdp-ended" role="status">RDP connection ended.</p>}
      {!busy && lastConnection && <div className="rdp-reconnect rdp-notice">
        <p>Reconnect to <strong>{lastConnection.name || lastConnection.config.host}</strong></p>
        <p className="rdp-note">{lastConnection.config.host}:{lastConnection.config.port} · {lastConnection.config.username}</p>
        <p className="rdp-note">Use the last connection settings. Review the server certificate and enter your password again.</p>
        <button onClick={reconnect}>Reconnect</button>
      </div>}
      {phase === "certificate" && certificate && <RdpCertificateForm certificate={certificate}
        endpoint={`${lastConnection?.config.host}:${lastConnection?.config.port}`} sessionId={sessionId}
        onApprove={(approval) => void authenticate(approval)} onForgotten={() => { if (currentId.current === sessionId) disconnect(); }} />}
      {(phase === "connecting" || phase === "authenticating") && <p role="status">{phase === "connecting" ? "Connecting and reading the server certificate…" : "Authenticating with the RDP server…"}</p>}
      {(phase === "reconnecting" || phase === "closing") && <p role="status">{phase === "reconnecting" ? "Closing the previous connection before reconnecting…" : "Closing the RDP connection…"}</p>}
      <div style={{ display: busy ? "none" : "contents" }}>
        <RdpConnectionForm config={config} onChange={setConfig} onConnect={(event, name) => { event.preventDefault(); void connect(config, name); }} />
      </div>
    </div>
  </section>;
}
