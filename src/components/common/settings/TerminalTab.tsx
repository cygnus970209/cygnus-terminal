import { useState } from "react";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { useHighlightSettings } from "../../../hooks/useHighlightSettings";
import { useTerminalNotifySettings } from "../../../hooks/useTerminalNotifySettings";

export default function TerminalTab() {
  const { settings, update } = useHighlightSettings();
  const { settings: notify, update: updateNotify } = useTerminalNotifySettings();
  const [permError, setPermError] = useState<string | null>(null);

  const handleEnableNotify = async (checked: boolean) => {
    setPermError(null);
    if (!checked) {
      updateNotify({ enabled: false });
      return;
    }
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const perm = await requestPermission();
        granted = perm === "granted";
      }
      if (!granted) {
        setPermError(
          "Notification permission denied. Enable in OS settings to use this feature.",
        );
        return;
      }
      updateNotify({ enabled: true });
    } catch (err) {
      setPermError(`Failed to request permission: ${err}`);
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Output Highlighting</h3>
      <p className="settings-desc">
        터미널 출력에서 로그 레벨과 IP 주소를 색으로 강조합니다.
        <br />
        이미 색이 입혀진 출력 (<code>grep --color</code>, <code>journalctl</code> 등)은 건드리지 않으며,
        vi/less/top 같은 전체 화면 모드에서도 자동으로 비활성화됩니다.
      </p>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={settings.logLevels}
          onChange={(e) => update({ logLevels: e.target.checked })}
        />
        <span>
          <strong>Log levels</strong>
          <span className="settings-checkbox-hint">
            ERROR / WARN / INFO / DEBUG 등 키워드를 색으로 표시
          </span>
        </span>
      </label>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={settings.ips}
          onChange={(e) => update({ ips: e.target.checked })}
        />
        <span>
          <strong>IP addresses</strong>
          <span className="settings-checkbox-hint">
            IPv4 주소를 cyan 으로 강조 (예: <code>192.168.1.1</code>)
          </span>
        </span>
      </label>

      <h3 className="settings-section-title" style={{ marginTop: 20 }}>
        Long-Running Command Notifications
      </h3>
      <p className="settings-desc">
        설정한 시간 이상 걸리는 명령이 끝나면 데스크톱 알림으로 알려줍니다.
        창이 백그라운드이거나 다른 탭에 있을 때만 발송돼요 (이미 보고 있을 땐 안 띄움).
        <br />
        OSC 7 (셸 통합) 이 감지된 세션에서만 동작합니다 — FileTree 헤더의 dot 이 초록일 때.
      </p>

      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={notify.enabled}
          onChange={(e) => handleEnableNotify(e.target.checked)}
        />
        <span>
          <strong>Notify on completion</strong>
          <span className="settings-checkbox-hint">
            처음 활성화 시 OS 권한 요청이 뜹니다
          </span>
        </span>
      </label>

      <label
        className="settings-checkbox-row"
        style={{ alignItems: "center", opacity: notify.enabled ? 1 : 0.5 }}
      >
        <span style={{ minWidth: 80, display: "inline-block", paddingLeft: 24 }}>
          Threshold
        </span>
        <input
          type="number"
          min={1}
          max={3600}
          step={1}
          value={notify.thresholdSeconds}
          disabled={!notify.enabled}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!Number.isNaN(v) && v > 0) updateNotify({ thresholdSeconds: v });
          }}
          style={{
            width: 70,
            background: "#11111b",
            border: "1px solid #313244",
            borderRadius: 4,
            color: "#cdd6f4",
            padding: "3px 6px",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
          }}
        />
        <span className="settings-checkbox-hint" style={{ marginLeft: 6 }}>
          초 (이보다 짧은 명령은 알림 안 함)
        </span>
      </label>

      {permError && (
        <p className="settings-desc" style={{ color: "#f38ba8" }}>
          {permError}
        </p>
      )}

      <h3 className="settings-section-title" style={{ marginTop: 20 }}>
        Editor / Pager Mode
      </h3>
      <p className="settings-desc">
        vi/vim, less, top 같은 전체 화면 모드의 색은 우리가 손댈 수 없습니다.
        그 화면들은 셸 자체의 syntax highlighting 으로 가요.
        <br />
        서버의 <code>~/.vimrc</code> 에 다음 한 줄 추가하면 vim 색이 켜집니다:
      </p>
      <pre className="settings-code">syntax on</pre>
      <p className="settings-desc">
        로그 파일 syntax 플러그인 (예: <code>vim-log-highlighting</code>) 까지 깔면
        타임스탬프·레벨·IP가 자동으로 색칠됩니다.
      </p>
    </div>
  );
}
