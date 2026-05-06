import ReactDOM from "react-dom/client";
import App from "./App";
import SftpPopoutApp from "./views/SftpPopoutApp";
import LogViewerPopoutApp from "./views/LogViewerPopoutApp";

const params = new URLSearchParams(window.location.search);
const view = params.get("view");

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (view === "sftp") {
  root.render(
    <SftpPopoutApp
      sftpId={params.get("sftpId") || ""}
      homePath={params.get("homePath") || "/"}
      sshSessionId={params.get("sshSessionId") || ""}
      label={params.get("label") || "SFTP"}
    />,
  );
} else if (view === "log") {
  root.render(
    <LogViewerPopoutApp
      sshSessionId={params.get("sshSessionId") || ""}
      label={params.get("label") || "Logs"}
    />,
  );
} else {
  root.render(<App />);
}
