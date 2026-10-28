import { t, useLocale } from "../../i18n";
import Select from "../common/Select";
import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Profile } from "../../types";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export default function GroupPicker({ value, onChange }: Props) {
  useLocale();
  const id = useId();
  const [groups, setGroups] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([invoke<Profile[]>("list_profiles"), invoke<{ group_name: string }[]>("winrm_list_profiles")])
      .then(([terminal, winrm]) => {
        const profiles = [...terminal, ...winrm];
        if (!cancelled) {
          setGroups(
            [
              ...new Set(
                profiles
                  .map((p) => p.group_name)
                  .filter((name): name is string => !!name?.trim()),
              ),
            ].sort((a, b) => a.localeCompare(b)),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = [...new Set([...groups, ...(value ? [value] : [])])].sort(
    (a, b) => a.localeCompare(b),
  );
  return (
    <div className="dialog-row">
      <label htmlFor={id}>{t("Group")}</label>
      <Select
        id={id}
        value={creating ? "new" : `group:${value}`}
        onValueChange={(value) => {
          const next = value;
          setCreating(next === "new");
          onChange(next === "new" ? "" : next.slice(6));
        }}
      >
        <option value="group:">{t("No group")}</option>
        {options.map((group) => (
          <option key={group} value={`group:${group}`}>
            {group}
          </option>
        ))}
        <option value="new">{t("+ New group")}</option>
      </Select>
      {creating && (
        <input
          aria-label={t("New group name")}
          placeholder={t("New group name")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          pattern={".*\\S.*"}
          autoFocus
        />
      )}
      {error && (
        <span className="transport-note" role="status">{t("Could not load groups. You can still enter a group name.")}</span>
      )}
    </div>
  );
}
