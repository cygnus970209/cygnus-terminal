import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import Select from "../common/Select";
import type { SessionStatus } from "../../types";
import type { RdpCertificate, RdpConfig, RdpEvent } from "../../types/rdp";
import { decodeRdpFrame, rdpScancode, RdpInputQueue } from "../../utils/rdp";
import "./RdpSession.css";

type Phase = "idle" | "connecting" | "certificate" | "authenticating" | "connected" | "ended" | "error";
interface Props {
  tabId: string;
  isActive: boolean;
  onSessionStatus: (id: string, status: SessionStatus) => void;
  onTitleChange: (id: string, title: string) => void;
}
export default function RdpSession({ tabId, isActive, onSessionStatus, onTitleChange }: Props) {
  const [config, setConfig] = useState<RdpConfig>({ host: "", port: 3389, username: "", domain: "", width: 1280, height: 720 });
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [certificate, setCertificate] = useState<RdpCertificate | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const currentId = useRef<string | null>(null);
  const inputs = useRef<RdpInputQueue | null>(null);
  const frameRequest = useRef<{ id: string; promise: Promise<ArrayBuffer> } | null>(null);

  const disconnect = useCallback((message?: string) => {
    generation.current++;
    const id = currentId.current;
    currentId.current = null;
    frameRequest.current = null;
    inputs.current?.close();
    inputs.current = null;
    setSessionId(null);
    setPassword("");
    setCertificate(null);
    setHasFrame(false);
    setError(message ?? null);
    setPhase(message ? "error" : "ended");
    onSessionStatus(tabId, message ? "error" : "ended");
    if (id) void invoke("rdp_close", { sessionId: id }).catch(() => {});
  }, [onSessionStatus, tabId]);

  useEffect(() => {
    onSessionStatus(tabId, "ended");
    return () => {
      generation.current++;
      inputs.current?.close();
      const id = currentId.current;
      currentId.current = null;
      if (id) void invoke("rdp_close", { sessionId: id }).catch(() => {});
    };
  }, [onSessionStatus, tabId]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    const attempt = ++generation.current;
    setPhase("connecting"); setError(null); setHasFrame(false); setCertificate(null);
    onSessionStatus(tabId, "connecting");
    const settings = { ...config, host: config.host.trim(), username: config.username.trim(), domain: config.domain.trim() };
    onTitleChange(tabId, `RDP · ${settings.host}`);
    const events = new Channel<RdpEvent>();
    events.onmessage = (event) => {
      if (generation.current !== attempt) return;
      if (event.type === "certificate") { setCertificate(event); setPhase("certificate"); }
      else if (event.type === "connected") {
        setSize({ width: event.width, height: event.height });
        setPhase("connected"); setCertificate(null); setHasFrame(false);
        onSessionStatus(tabId, "connected");
      } else if (event.type === "error") disconnect(event.message);
      else if (event.type === "ended") disconnect();
      else setPhase(event.type);
    };
    try {
      const id = await invoke<string>("rdp_connect", { config: settings, events });
      if (generation.current !== attempt) { await invoke("rdp_close", { sessionId: id }); return; }
      currentId.current = id; setSessionId(id);
    } catch {
      if (generation.current === attempt) disconnect("Could not start RDP. Check the server address and the bundled RDP engine.");
    }
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (!certificate || !sessionId) return;
    const attempt = generation.current;
    setPhase("authenticating");
    const secret = password;
    setPassword("");
    try { await invoke("rdp_authenticate", { sessionId, fingerprint: certificate.fingerprint, password: secret }); }
    catch { if (generation.current === attempt) disconnect("Certificate approval could not be sent. Reconnect to try again."); }
  }

  useEffect(() => {
    if (phase !== "connected" || !sessionId) return;
    const queue = new RdpInputQueue(
      (events) => invoke("rdp_input", { sessionId, events }),
      () => disconnect("RDP input stopped responding. The connection was closed."),
    );
    inputs.current = queue;
    return () => { queue.close(); if (inputs.current === queue) inputs.current = null; };
  }, [phase, sessionId, disconnect]);

  useEffect(() => {
    if (!isActive) inputs.current?.release();
  }, [isActive]);

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
        if (cancelled) return;
        const frame = decodeRdpFrame(buffer);
        if (frame && canvas.current) {
          const context = canvas.current.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          if (canvas.current.width !== frame.width) canvas.current.width = frame.width;
          if (canvas.current.height !== frame.height) canvas.current.height = frame.height;
          context.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
          setHasFrame(true);
        }
        timer = setTimeout(draw, 50);
      } catch { if (!cancelled) disconnect("RDP display stopped responding. Reconnect to try again."); }
    };
    void draw();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, sessionId, isActive, disconnect]);

  function point(clientX: number, clientY: number) {
    const surface = canvas.current!;
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(surface.width - 1, Math.floor((clientX - rect.left) * surface.width / rect.width))),
      y: Math.max(0, Math.min(surface.height - 1, Math.floor((clientY - rect.top) * surface.height / rect.height))),
    };
  }
  useEffect(() => {
    const surface = canvas.current;
    if (!surface || phase !== "connected" || !isActive) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.deltaY) return;
      inputs.current?.push({ type: "wheel", ...point(event.clientX, event.clientY), delta: event.deltaY > 0 ? -120 : 120 });
    };
    const release = () => inputs.current?.release();
    surface.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", release);
    return () => { surface.removeEventListener("wheel", wheel); window.removeEventListener("blur", release); };
  }, [phase, isActive]);

  function key(event: KeyboardEvent<HTMLCanvasElement>, down: boolean) {
    if (event.ctrlKey && event.altKey && event.shiftKey) {
      event.preventDefault(); inputs.current?.release(); disconnectButton.current?.focus(); return;
    }
    if (event.nativeEvent.isComposing) return;
    const code = rdpScancode(event.code);
    if (code === undefined) return;
    event.preventDefault(); event.stopPropagation();
    inputs.current?.push({ type: "key", code, down });
  }
  const busy = ["connecting", "certificate", "authenticating", "connected"].includes(phase);
  return <section className="rdp-session" style={{ display: isActive ? "flex" : "none" }} aria-label="RDP session">
    <div className="rdp-toolbar">
      <span>Remote desktop <span className="rdp-note">Preview</span></span>
      {phase === "connected" && <span className="rdp-note">{size.width} × {size.height} · Ctrl+Alt+Shift releases input</span>}
      {phase === "connected" && <button onClick={() => {
        for (const down of [true, false]) for (const code of (down ? [0x1d, 0x38, 0x153] : [0x153, 0x38, 0x1d])) inputs.current?.push({ type: "key", code, down });
        canvas.current?.focus();
      }}>Ctrl+Alt+Del</button>}
      {busy && <button ref={disconnectButton} onClick={() => disconnect()}>{phase === "connected" ? "Disconnect" : "Cancel connection"}</button>}
    </div>
    {phase === "connected" ? <div className="rdp-screen">
      {!hasFrame && <p className="rdp-wait" role="status">Waiting for the remote desktop…</p>}
      <canvas ref={canvas} width={size.width} height={size.height} tabIndex={0}
        aria-label="Remote desktop. Click to focus. Ctrl Alt Shift releases input."
        onKeyDown={(event) => key(event, true)} onKeyUp={(event) => key(event, false)}
        onBlur={() => inputs.current?.release()} onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => { if (event.button > 2) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); inputs.current?.push({ type: "pointer", ...point(event.clientX, event.clientY), button: event.button, down: true }); }}
        onPointerUp={(event) => { if (event.button <= 2) inputs.current?.push({ type: "pointer", ...point(event.clientX, event.clientY), button: event.button, down: false }); }}
        onPointerMove={(event) => inputs.current?.push({ type: "pointer", ...point(event.clientX, event.clientY), button: null, down: false })}
        onPointerCancel={() => inputs.current?.release()} />
    </div> : <div className="rdp-content">
      {error && <p className="rdp-error" role="alert">{error}</p>}
      {phase === "certificate" && certificate ? <form className="rdp-form" onSubmit={authenticate}>
        <h2>Verify this RDP server</h2>
        <p>{config.host}:{config.port}</p>
        <p className="rdp-note">Compare this SHA-256 fingerprint with a trusted source. Trust applies to this connection only. This preview does not automatically verify the certificate issuer, hostname or validity dates.</p>
        <code className="rdp-fingerprint">{certificate.fingerprint}</code>
        <dl className="rdp-certificate"><dt>Subject</dt><dd>{certificate.subject}</dd><dt>Issuer</dt><dd>{certificate.issuer}</dd><dt>Valid from</dt><dd>{certificate.valid_from}</dd><dt>Valid until</dt><dd>{certificate.valid_until}</dd></dl>
        <label>RDP password<input type="password" autoComplete="off" required maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <p className="rdp-note">Sent only to this RDP server after approval. Not saved or shared with MCP.</p>
        <button className="rdp-primary" type="submit" disabled={!sessionId}>Trust once & connect</button>
      </form> : phase === "connecting" || phase === "authenticating" ? <p role="status">{phase === "connecting" ? "Connecting and reading the server certificate…" : "Authenticating with the RDP server…"}</p>
        : <form className="rdp-form" onSubmit={connect}>
          <h2>Connect to a remote desktop</h2>
          {phase === "ended" && <p className="rdp-note" role="status">RDP connection ended.</p>}
          <p className="rdp-note">Direct connection with NLA / NTLM. Enter the password after verifying the server certificate.</p>
          <div className="rdp-fields">
            <label>Server<input autoComplete="off" required maxLength={253} placeholder="server.example.com" value={config.host} onChange={(e) => setConfig({ ...config, host: e.target.value })} /></label>
            <label>Port<input type="number" required min={1} max={65535} value={config.port || ""} onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })} /></label>
          </div>
          <label>Username<input autoComplete="off" required maxLength={256} value={config.username} onChange={(e) => setConfig({ ...config, username: e.target.value })} /></label>
          <label>Domain <span className="rdp-note">Optional</span><input autoComplete="off" maxLength={256} value={config.domain} onChange={(e) => setConfig({ ...config, domain: e.target.value })} /></label>
          <label>Desktop size<Select aria-label="RDP desktop size" value={`${config.width}x${config.height}`} onValueChange={(value) => { const [width, height] = value.split("x").map(Number); setConfig({ ...config, width, height }); }}>
            <option value="1280x720">1280 × 720</option><option value="1600x900">1600 × 900</option><option value="1920x1080">1920 × 1080</option>
          </Select></label>
          <p className="rdp-note">Basic US keyboard input. IME, clipboard, drive sharing and RD Gateway are not available yet.</p>
          <button className="rdp-primary" type="submit">Connect</button>
        </form>}
    </div>}
  </section>;
}
