import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MonitorPanel from "./MonitorPanel";
import StatusBar from "../common/StatusBar";
import type { ServerStats } from "../../hooks/useServerStats";

const windows: ServerStats = {
  platform: "windows", cpu_usage: 35, mem_total: 8192, mem_used: 4096, mem_usage: 50,
  disk_total: 2048, disk_used: 512, disk_usage: 25, load_avg: null, uptime: "1d 2h 3m",
  windows: { powershell_version: "5.1.20348.1", disks: [{ name: "C:", total_bytes: 2048, free_bytes: 1536 }],
    processes: [{ pid: 42, name: "한글 서버.exe", memory_bytes: 1024 }] },
};

function render(stats: ServerStats | null, error: string | null = null) {
  return renderToStaticMarkup(<MonitorPanel stats={stats} error={error} />);
}

describe("Windows monitoring", () => {
  it("shows runtime, disks and processes without inventing Linux load average", () => {
    const html = render(windows);
    expect(html).toContain("Windows · PowerShell 5.1.20348.1");
    expect(html).toContain("한글 서버.exe");
    expect(html).toContain("C:");
    expect(html).not.toContain(">LOAD<");
  });

  it("keeps failed metrics unavailable rather than showing healthy zeroes", () => {
    const html = render({ ...windows, cpu_usage: null, disk_total: null, disk_used: null, disk_usage: null,
      windows: { ...windows.windows!, disks: null, processes: null } });
    expect(html).toContain("Some metrics are unavailable");
    expect(html).toContain("Process information could not be read");
    expect(html).not.toContain(">0%<");
    expect(html).not.toContain("width:0%");
  });

  it("distinguishes empty results from query failures", () => {
    const html = render({ ...windows, windows: { ...windows.windows!, processes: [], disks: [] } });
    expect(html).toContain("No processes returned");
    expect(html).toContain("No local fixed disks returned");
    expect(html).not.toContain("could not be read");
  });

  it("renders a real zero and escapes remote process text", () => {
    const html = render({ ...windows, cpu_usage: 0,
      windows: { ...windows.windows!, processes: [{ pid: 1, name: '<img src=x onerror="alert(1)">', memory_bytes: 0 }] } });
    expect(html).toContain(">0%<");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("keeps Linux monitoring free of Windows sections and shows initial sampling", () => {
    const html = render({ ...windows, platform: "linux", windows: null, cpu_usage: null, load_avg: "0.1 0.2 0.3" });
    expect(html).toContain("Sampling…");
    expect(html).toContain("0.1 0.2 0.3");
    expect(html).not.toContain("Processes");
  });

  it("distinguishes pending and failed requests without displaying stale values", () => {
    expect(render(null)).toContain("Collecting stats");
    const html = render(windows, "SSH session closed");
    expect(html).toContain("SSH session closed");
    expect(html).not.toContain("35%");
  });

  it("uses placeholders for unavailable status bar metrics", () => {
    const html = renderToStaticMarkup(<StatusBar sshActive monitorAvailable logsAvailable={false}
      unavailableReason="Windows logs unavailable" stats={{ ...windows, cpu_usage: null }}
      transferJobs={[]} activeDrawer={null} onToggleDrawer={() => {}} onOpenPalette={() => {}} />);
    expect(html).toContain(">--<");
    expect(html).not.toContain(">0%<");
    expect(html).toContain("Windows logs unavailable");
  });
});
