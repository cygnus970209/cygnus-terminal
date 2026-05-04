import { useHighlightSettings } from "../../../hooks/useHighlightSettings";

export default function TerminalTab() {
  const { settings, update } = useHighlightSettings();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Output Highlighting</h3>
      <p className="settings-desc">
        터미널 출력에서 로그 레벨과 IP 주소를 색으로 강조합니다.
        <br />
        이미 색이 입혀진 출력 (`grep --color`, `journalctl` 등)은 건드리지 않으며,
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
