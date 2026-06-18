import { useState } from "react";
import {
  useVaultPromptRules,
  isValidPattern,
  isTooBroadPattern,
} from "../../../hooks/useVaultPromptRules";

export default function VaultPromptsTab() {
  const { rules, add, remove, toggle } = useVaultPromptRules();
  const [pattern, setPattern] = useState("");
  const [label, setLabel] = useState("");

  const valid = isValidPattern(pattern);
  const broad = valid && isTooBroadPattern(pattern);

  const handleAdd = () => {
    if (!valid) return;
    if (add(pattern, label)) {
      setPattern("");
      setLabel("");
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Password Prompt Autofill</h3>
      <p className="settings-desc">
        터미널 출력이 아래 정규식 중 하나에 걸리면 (예:{" "}
        <code>[sudo] password for ubuntu:</code>) 커서 옆에 볼트 픽커가 떠서
        저장된 비밀번호를 골라 자동 입력할 수 있어요.
        <br />
        패턴은 현재 <strong>커서 줄</strong>에만, 줄 끝(<code>$</code>) 기준으로
        검사돼요. 지금은 SSH 세션에서만 동작합니다.
      </p>

      <div className="vault-rule-list">
        {rules.length === 0 && (
          <p className="settings-desc" style={{ opacity: 0.7, marginBottom: 0 }}>
            등록된 패턴이 없어요. 아래에서 추가하면 다시 켜집니다.
          </p>
        )}
        {rules.map((r) => (
          <div className="vault-rule-row" key={r.id}>
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={() => toggle(r.id)}
              title={r.enabled ? "활성 — 감지함" : "비활성 — 감지 안 함"}
            />
            <div className="vault-rule-meta">
              <span className="vault-rule-label">{r.label}</span>
              <code className="vault-rule-pattern">{r.pattern}</code>
            </div>
            <button
              className="vault-rule-remove"
              onClick={() => remove(r.id)}
              title="삭제"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="vault-rule-add">
        <input
          className="vault-rule-input mono"
          placeholder="정규식 (예: [Pp]assword:\s*$)"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          spellCheck={false}
        />
        <input
          className="vault-rule-input"
          placeholder="라벨 (선택)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button className="settings-btn" onClick={handleAdd} disabled={!valid}>
          추가
        </button>
      </div>

      {pattern && !valid && (
        <p className="vault-rule-warn">유효하지 않은 정규식이에요.</p>
      )}
      {broad && (
        <p className="vault-rule-warn">
          ⚠ 너무 넓은 패턴이에요 — 일반 출력에도 픽커가 뜰 수 있어요. 줄 끝{" "}
          <code>:</code> 앵커를 권장해요.
        </p>
      )}
    </div>
  );
}
