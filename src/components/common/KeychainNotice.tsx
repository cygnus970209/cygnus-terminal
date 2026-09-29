import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { keychainNotice } from "../../services/secureInvoke";
import Icon from "./Icon";
import "./KeychainNotice.css";

export default function KeychainNotice() {
  const notice = useSyncExternalStore(
    keychainNotice.subscribe,
    keychainNotice.getDetailsSnapshot,
  );
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const mac = /Mac/i.test(navigator.platform);
  useEffect(() => {
    if (!notice) return;
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => {
      previous?.focus();
    };
  }, [notice]);
  if (!notice) return null;
  const termius = notice.source === "termius";
  const keyOwner = termius ? "Termius" : "Cygnus";
  return createPortal(
    <div className="keychain-notice-overlay">
      <div
        className="keychain-notice"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keychain-title"
        aria-describedby="keychain-description"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            keychainNotice.respond(false);
          }
          if (event.key === "Tab") {
            const buttons =
              dialog.current?.querySelectorAll<HTMLButtonElement>("button");
            if (!buttons?.length) return;
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="keychain-notice-content">
          <div className="keychain-notice-icon">
            <Icon name="vault" size={24} />
          </div>
          <span className="keychain-notice-eyebrow">
            YOUR CREDENTIALS, PROTECTED
          </span>
          <h2 id="keychain-title">
            {notice.denied
              ? "Keychain access was not granted"
              : mac
                ? "Before macOS asks for access"
                : "Protecting your saved credentials"}
          </h2>
          <p id="keychain-description">
            {termius ? (
              <>
                Cygnus needs to read Termius’s local encryption key from macOS
                Keychain to import your saved connections. Passwords and private
                keys are not copied.
              </>
            ) : (
              <>
                Cygnus uses{" "}
                {mac ? "macOS Keychain" : "your system credential store"} to protect
                the encryption key for your saved passwords and Vault secrets.
                This action needs that key.
              </>
            )}
          </p>
          {notice.denied && (
            <div className="keychain-notice-tip" role="alert">
              <strong>You can try again</strong>
              <p>
                Access was denied or the keychain is unavailable. Choose Retry
                access to request permission again, then allow access in the
                system dialog if it appears. Cancel to return without retrying.
              </p>
            </div>
          )}
          {mac ? (
            <>
              <div className="keychain-notice-tip">
                <strong>What to expect</strong>
                <p>
                  macOS may ask for your login keychain password, usually your
                  Mac login password. Enter it only in the macOS system dialog.
                </p>
              </div>
              <div className="keychain-notice-tip">
                <strong>About “Always Allow”</strong>
                <p>
                  Choose <b>Always Allow</b> in the macOS dialog to allow future
                  access to this {keyOwner} keychain item without repeated approval.
                  “Allow” grants access for this request. Changes to the app’s
                  signature or keychain permissions may cause macOS to ask
                  again.
                </p>
              </div>
            </>
          ) : (
            <div className="keychain-notice-tip">
              <p>
                Your operating system may ask you to unlock its credential store
                before continuing.
              </p>
            </div>
          )}
          <p className="keychain-notice-note">
            This request is for {keyOwner}’s encryption key, not access to all
            your keychain passwords. Cancel to return without unlocking
            credentials.
          </p>
        </div>
        <footer>
          <button ref={cancel} onClick={() => keychainNotice.respond(false)}>
            Cancel
          </button>
          <button
            className="keychain-notice-continue"
            onClick={() => keychainNotice.respond(true)}
          >
            {notice.denied ? "Retry access" : "Continue"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
