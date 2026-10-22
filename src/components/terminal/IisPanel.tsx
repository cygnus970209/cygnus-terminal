import { useId, useState } from "react";
import Select from "../common/Select";
import { useIisQuery } from "../../hooks/useIisQuery";
import type { IisOverview, IisSiteLog, WindowsEvents } from "../../types/iis";
import "./IisPanel.css";

export function IisOverviewView({ data }: { data: IisOverview }) {
  if (data.status !== "available") return <p className="iis-note" role="status">{data.status === "not_installed"
    ? "IIS management components were not found on this server."
    : "IIS configuration could not be read. Check IIS management components and account permissions."}</p>;
  return <>
    {data.truncated && <p className="iis-note">Showing up to 200 sites and pools, and 64 bindings and applications per site.</p>}
    <div className="iis-columns">
      <section aria-label="IIS sites">
        <h3>Sites {data.sites && `(${data.sites.length})`}</h3>
        {data.sites === null ? <p className="iis-note">Site information is unavailable.</p>
          : !data.sites.length ? <p className="iis-note">No sites configured.</p>
          : data.sites.map((site) => <details className="iis-detail" key={site.id}>
            <summary><span title={site.name}>{site.name}</span><span className="iis-state">{site.state ?? "Unavailable"}</span></summary>
            <div className="iis-detail-body">
              <p className="iis-note">Site ID {site.id} · Logging {site.log_enabled ? "enabled" : "disabled"}</p>
              <h4>Bindings</h4>
              {site.bindings.length ? site.bindings.map((binding, i) => <p className="iis-value" key={i}>{binding.protocol} · {binding.address}</p>) : <p className="iis-note">No bindings.</p>}
              <h4>Applications → pools</h4>
              {site.applications.length ? site.applications.map((app, i) => <p className="iis-value" key={i}>{app.path} → {app.pool}</p>) : <p className="iis-note">No applications.</p>}
            </div>
          </details>)}
      </section>
      <section aria-label="IIS application pools">
        <h3>Application pools {data.pools && `(${data.pools.length})`}</h3>
        {data.pools === null ? <p className="iis-note">Application pool information is unavailable.</p>
          : !data.pools.length ? <p className="iis-note">No application pools configured.</p>
          : <table className="iis-table"><thead><tr><th>Pool</th><th>State</th><th>.NET CLR</th><th>Pipeline</th></tr></thead>
            <tbody>{data.pools.map((pool) => <tr key={pool.name}>
              <td title={pool.name}>{pool.name}</td><td>{pool.state ?? "Unavailable"}</td>
              <td title={pool.runtime || "No managed code"}>{pool.runtime || "No managed code"}</td><td>{pool.pipeline}</td>
            </tr>)}</tbody></table>}
      </section>
    </div>
  </>;
}

const LOG_MESSAGES: Record<Exclude<IisSiteLog["status"], "available">, string> = {
  unavailable: "The site log could not be read. Check IIS components and account permissions.",
  site_missing: "This site no longer exists. Refresh the site list.",
  disabled: "Logging is disabled for this site.",
  unsupported_format: "Only per-site W3C logs are supported. Central logging and other formats are unavailable here.",
  unsupported_path: "Only local fixed-drive log folders without links or junctions are supported.",
  no_logs: "No log files found for this site.",
  too_many_files: "This folder exceeds the 4,096-file scan limit.",
};

export function IisLogView({ data }: { data: IisSiteLog }) {
  if (data.status !== "available") return <p className="iis-note" role="status">{LOG_MESSAGES[data.status]}</p>;
  return <>
    <p className="iis-note">{data.file} · Latest snapshot{data.truncated ? " · Earlier content omitted" : ""}</p>
    <pre className="iis-log" tabIndex={0} aria-label="IIS log content">{data.lines.join("\n") || (data.truncated ? "No complete lines in this snapshot." : "Log file is empty.")}</pre>
  </>;
}

export function WindowsEventsView({ data }: { data: WindowsEvents }) {
  return <div className="iis-columns">{data.logs.map((log) => <section aria-label={`${log.name} events`} key={log.name}>
    <h3>{log.name}</h3>
    {log.events === null ? <p className="iis-note">Events are unavailable. Check event log access.</p>
      : !log.events.length ? <p className="iis-note">No matching events in the last 24 hours.</p>
      : log.events.map((event) => <details className="iis-detail" key={event.record_id}>
        <summary><span title={`${event.provider} · ${event.id}`}>{event.provider} · {event.id}</span><span className="iis-state">{["", "Critical", "Error", "Warning"][event.level]}</span></summary>
        <div className="iis-detail-body">
          <p className="iis-note">{event.time ? new Date(event.time).toLocaleString() : "Time unavailable"} · Record {event.record_id}</p>
          <pre className="iis-message">{event.message ?? "Event message is unavailable."}</pre>
          {event.message_truncated && <p className="iis-note">Message shortened to 1,024 characters.</p>}
        </div>
      </details>)}
  </section>)}</div>;
}

function SiteLog({ sessionId, siteId }: { sessionId: string; siteId: number }) {
  const query = useIisQuery<IisSiteLog>("iis_site_log", sessionId, siteId);
  return <>
    <div className="iis-toolbar"><span className="iis-note">Newest W3C file · Up to 50 lines / 16 KiB</span>
      <button disabled={query.loading} onClick={query.refresh}>{query.loading ? "Reading…" : "Read log"}</button></div>
    {query.error && <p className="iis-error" role="alert">{query.error}</p>}
    {query.data && <IisLogView data={query.data} />}
    {!query.data && !query.error && !query.loading && <p className="iis-note">Read a snapshot of this site's latest log.</p>}
  </>;
}

export default function IisPanel({ sessionId }: { sessionId: string }) {
  const overview = useIisQuery<IisOverview>("iis_overview", sessionId, undefined, true);
  const events = useIisQuery<WindowsEvents>("windows_events", sessionId);
  const [view, setView] = useState<"overview" | "logs" | "events">("overview");
  const [selected, setSelected] = useState<number | null>(null);
  const sites = overview.data?.sites;
  const siteId = sites?.find((site) => site.id === selected)?.id ?? sites?.[0]?.id;
  const group = useId();
  return <div className="iis-panel">
    <div className="iis-toolbar">
      <nav className="iis-nav" aria-label="IIS views">
        {([ ["overview", "Sites & pools"], ["logs", "Site logs"], ["events", "Windows events"] ] as const).map(([key, title]) =>
          <button key={key} aria-pressed={view === key} aria-controls={group} onClick={() => setView(key)}>{title}</button>)}
      </nav>
      <span className="iis-note">Read only · SSH</span>
    </div>
    <div id={group}>
      {view !== "events" && <div className="iis-toolbar">
        {view === "logs" && <Select aria-label="IIS site" value={String(siteId ?? "")} disabled={!sites?.length} onValueChange={(value) => setSelected(Number(value))}>
          {sites?.map((site) => <option key={site.id} value={String(site.id)}>{site.name} (ID {site.id})</option>)}
        </Select>}
        <button disabled={overview.loading} onClick={overview.refresh}>{overview.loading ? "Reading sites…" : "Refresh sites & pools"}</button>
      </div>}
      {view !== "events" && overview.error && <p className="iis-error" role="alert">{overview.error}</p>}
      {view === "overview" && overview.data && <IisOverviewView data={overview.data} />}
      {view === "logs" && overview.data && (siteId !== undefined
        ? <SiteLog key={`${sessionId}:${siteId}`} sessionId={sessionId} siteId={siteId} />
        : <p className="iis-note">{overview.data.status === "not_installed" ? "IIS management components were not found on this server." : sites?.length === 0 ? "No sites configured." : "Site information is unavailable."}</p>)}
      {view === "events" && <>
        <div className="iis-toolbar"><span className="iis-note">Last 24 hours · Critical, error, warning · Up to 20 per log · All providers</span>
          <button disabled={events.loading} onClick={events.refresh}>{events.loading ? "Reading…" : "Read events"}</button></div>
        {events.error && <p className="iis-error" role="alert">{events.error}</p>}
        {events.data && <WindowsEventsView data={events.data} />}
        {!events.data && !events.error && !events.loading && <p className="iis-note">Read Application and System event snapshots from this server.</p>}
      </>}
    </div>
  </div>;
}
