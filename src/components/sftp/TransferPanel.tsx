import "./TransferPanel.css";

export default function TransferPanel() {
  // TODO: Transfer queue integration
  return (
    <div className="transfer-panel">
      <div className="tp-header">
        <span className="tp-title">Transfers</span>
      </div>
      <div className="tp-empty">No active transfers</div>
    </div>
  );
}
