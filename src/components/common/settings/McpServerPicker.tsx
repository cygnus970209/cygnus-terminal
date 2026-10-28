import { t, useLocale } from "../../../i18n";
import { useState, type Dispatch, type SetStateAction } from "react";
import type { Profile } from "../../../types";
import Select from "../Select";

export default function McpServerPicker({ profiles, selected, onChange, disabled }: {
  profiles: Profile[]; selected: number[]; onChange: Dispatch<SetStateAction<number[]>>; disabled: boolean;
}) {
  useLocale();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const ssh = profiles.filter((p) => (p.protocol ?? "ssh") === "ssh");
  const selectedSet = new Set(selected);
  const groups = [...new Set(ssh.map((p) => p.group_name))].sort((a, b) => a.localeCompare(b));
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = ssh.filter((p) => (!group || JSON.stringify(p.group_name) === group)
    && (!selectedOnly || selectedSet.has(p.id))
    && terms.every((term) => `${p.name} ${p.host} ${p.username} ${p.group_name} ${p.environment ?? ""}`.toLowerCase().includes(term)))
    .sort((a, b) => a.group_name.localeCompare(b.group_name) || a.name.localeCompare(b.name));
  const shownSelected = visible.filter((p) => selectedSet.has(p.id)).length;
  const selectedCount = ssh.filter((p) => selectedSet.has(p.id)).length;
  const changeShown = (checked: boolean) => {
    const visibleIds = new Set(visible.map((p) => p.id));
    onChange((ids) => checked ? [...new Set([...ids, ...visibleIds])] : ids.filter((id) => !visibleIds.has(id)));
  };
  return <fieldset className="mcp-server-picker">
    <legend>{t("Shared SSH servers")}</legend>
    <div className="mcp-server-filters">
      <input aria-label={t("Search MCP servers")} placeholder={t("Search name, address, user or group…")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <Select aria-label={t("MCP server group")} value={group} onValueChange={setGroup}>
        <option value="">{t("All groups")}</option>
        {groups.map((name) => <option key={name} value={JSON.stringify(name)}>{name || t("Ungrouped")}</option>)}
      </Select>
    </div>
    <div className="mcp-server-summary">
      <span role="status">{selectedCount}{t(" of ")}{ssh.length}{t(" selected · ")}{visible.length}{t(" shown")}</span>
      <label><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />{t("Selected only")}</label>
    </div>
    {!disabled && <div className="settings-actions mcp-server-actions">
      <button className="settings-btn" type="button" disabled={visible.length === shownSelected} onClick={() => changeShown(true)}>{t("Select shown (")}{visible.length})</button>
      <button className="settings-btn" type="button" disabled={!shownSelected} onClick={() => changeShown(false)}>{t("Clear shown")}</button>
    </div>}
    {disabled && <p className="mcp-server-locked">{t("Stop MCP to change shared servers. Search and filters remain available.")}</p>}
    <div className="mcp-profiles">
      {!ssh.length ? <p>{t("Save an SSH connection in Connections first.")}</p> : !visible.length ? <p>{t("No matching servers. Change the search or filters.")}</p> : visible.map((profile) => (
        <label key={profile.id} className={`mcp-profile ${selectedSet.has(profile.id) ? "mcp-profile-selected" : ""}`}>
          <input type="checkbox" aria-label={t("Share {v0}", { v0: profile.name })} disabled={disabled} checked={selectedSet.has(profile.id)} onChange={(event) => {
            const checked = event.target.checked;
            onChange((ids) => checked ? [...new Set([...ids, profile.id])] : ids.filter((id) => id !== profile.id));
          }} />
          <span><strong title={profile.name}>{profile.name}</strong><small>{profile.username}@{profile.host}:{profile.port}</small><small>{profile.group_name || t("Ungrouped")}{profile.environment && ` · ${profile.environment}`}</small></span>
        </label>
      ))}
    </div>
    {!disabled && <p className="mcp-server-hint">{t("Bulk selection applies only to the servers currently shown.")}</p>}
  </fieldset>;
}
