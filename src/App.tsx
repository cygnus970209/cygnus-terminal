import { useState } from "react";
import Terminal from "./components/Terminal";
import "./App.css";

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);

  return (
    <div className="app">
      <div className="titlebar">
        <span className="titlebar-title">Cygnus Terminal</span>
        {sessionId && (
          <span className="titlebar-session">Local Shell</span>
        )}
      </div>
      <div className="terminal-container">
        <Terminal
          sessionId={sessionId}
          onSessionCreated={(id) => setSessionId(id)}
        />
      </div>
    </div>
  );
}

export default App;
