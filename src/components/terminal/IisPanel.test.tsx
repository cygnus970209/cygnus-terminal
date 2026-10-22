import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IisOverviewView, IisLogView, WindowsEventsView } from "./IisPanel";
import StatusBar from "../common/StatusBar";
import type { IisOverview, IisSiteLog, WindowsEvents } from "../../types/iis";

const overview: IisOverview = {
  schema: 1, status: "available", truncated: false,
  sites: [{ id: 1, name: '한글 <img src=x onerror="alert(1)">', state: null,
    bindings: [{ protocol: "https", address: "*:443:example.test" }],
    applications: [{ path: "/api", pool: "Backend" }], log_enabled: true }],
  pools: [{ name: "Backend", state: "Started", runtime: "", pipeline: "Integrated" }],
};
const log: IisSiteLog = { schema: 1, site_id: 1, status: "available", file: "u_ex261021.log", lines: ["<script>한글</script>"], truncated: true };

describe("IIS read-only views", () => {
  it("shows application pool mapping, bindings and unavailable state without remote markup", () => {
    const html = renderToStaticMarkup(<IisOverviewView data={overview} />);
    expect(html).toContain("*:443:example.test");
    expect(html).toContain("/api → Backend");
    expect(html).toContain("Unavailable");
    expect(html).toContain("No managed code");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<button");
  });

  it("distinguishes empty configuration, partial access and missing IIS components", () => {
    const empty = renderToStaticMarkup(<IisOverviewView data={{ ...overview, sites: [], pools: [] }} />);
    expect(empty).toContain("No sites configured");
    expect(empty).toContain("No application pools configured");
    const partial = renderToStaticMarkup(<IisOverviewView data={{ ...overview, sites: null }} />);
    expect(partial).toContain("Site information is unavailable");
    expect(partial).toContain("Backend");
    const absent = renderToStaticMarkup(<IisOverviewView data={{ ...overview, status: "not_installed", sites: null, pools: null }} />);
    expect(absent).toContain("IIS management components were not found");
    expect(absent).not.toContain("No sites configured");
  });

  it("marks truncated results and escapes log content", () => {
    expect(renderToStaticMarkup(<IisOverviewView data={{ ...overview, truncated: true }} />)).toContain("up to 200");
    const html = renderToStaticMarkup(<IisLogView data={log} />);
    expect(html).toContain("Earlier content omitted");
    expect(html).toContain("&lt;script&gt;한글");
    expect(html).not.toContain("<script>");
  });

  it("does not call a file empty when its final line exceeds the read limit", () => {
    const html = renderToStaticMarkup(<IisLogView data={{ ...log, lines: [] }} />);
    expect(html).toContain("No complete lines in this snapshot");
    expect(html).not.toContain("Log file is empty");
  });

  it.each([
    ["unavailable", "could not be read"], ["site_missing", "no longer exists"],
    ["disabled", "Logging is disabled"], ["unsupported_format", "per-site W3C"],
    ["unsupported_path", "local fixed-drive"], ["no_logs", "No log files"],
    ["too_many_files", "4,096-file"],
  ] as const)("explains %s without showing stale log text", (status, message) => {
    const html = renderToStaticMarkup(<IisLogView data={{ ...log, status, file: null, lines: [], truncated: false }} />);
    expect(html).toContain(message);
    expect(html).not.toContain("<pre");
  });

  it("preserves empty and denied event logs separately", () => {
    const data: WindowsEvents = { schema: 1, logs: [{ name: "Application", events: [] }, { name: "System", events: null }] };
    const html = renderToStaticMarkup(<WindowsEventsView data={data} />);
    expect(html).toContain("No matching events in the last 24 hours");
    expect(html).toContain("Events are unavailable");
  });

  it("shows event severity, missing time/message and message truncation", () => {
    const data: WindowsEvents = { schema: 1, logs: [{ name: "Application", events: [
      { record_id: 1, id: 5002, level: 2, provider: "WAS", time: null, message: null, message_truncated: false },
      { record_id: 2, id: 5003, level: 3, provider: "<script>", time: null, message: "<img>", message_truncated: true },
    ] }, { name: "System", events: [] }] };
    const html = renderToStaticMarkup(<WindowsEventsView data={data} />);
    expect(html).toContain("Error");
    expect(html).toContain("Warning");
    expect(html).toContain("Time unavailable");
    expect(html).toContain("Event message is unavailable");
    expect(html).toContain("Message shortened");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img>");
  });

  it("only exposes the IIS drawer when Windows is selected and gates runtime availability", () => {
    const props = { sshActive: true, monitorAvailable: false, logsAvailable: false, unavailableReason: "unavailable", stats: null, transferJobs: [], activeDrawer: null, onToggleDrawer: () => {}, onOpenPalette: () => {} };
    expect(renderToStaticMarkup(<StatusBar {...props} />)).not.toContain(">IIS<");
    const html = renderToStaticMarkup(<StatusBar {...props} showIis iisAvailable={false} />);
    expect(html).toMatch(/disabled=""[^>]*title="A verified Windows PowerShell runtime is required"/);
  });
});
