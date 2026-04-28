import { version } from "../../../../package.json";

export default function AboutTab() {
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">About</h3>
      <p className="settings-desc">
        Cygnus Terminal v{version}
        <br />
        개발자를 위한 올인원 터미널.
      </p>
    </div>
  );
}
