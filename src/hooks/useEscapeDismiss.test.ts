import { describe, expect, it, vi } from "vitest";
import { dismissTopLayer } from "./useEscapeDismiss";

function key(overrides: Partial<KeyboardEvent> = {}) {
  return { key: "Escape", repeat: false, isComposing: false, keyCode: 27,
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...overrides } as unknown as KeyboardEvent;
}
describe("Escape dismissal", () => {
  it("dismisses only the top visible layer and consumes the event before terminal input", () => {
    const settings = vi.fn(), hostKey = vi.fn(), keychain = vi.fn();
    const event = key();
    dismissTopLayer(event, [{ dismiss: keychain, priority: 20000 }, { dismiss: settings, priority: 100 }, { dismiss: hostKey, priority: 3000 }]);
    expect(keychain).toHaveBeenCalledOnce();
    expect(settings).not.toHaveBeenCalled();
    expect(hostKey).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });
  it("closes a select list before its parent dialog", () => {
    const dialog = vi.fn(), select = vi.fn();
    dismissTopLayer(key(), [{ dismiss: dialog, priority: 100 }, { dismiss: select, priority: 10000 }]);
    expect(select).toHaveBeenCalledOnce(); expect(dialog).not.toHaveBeenCalled();
  });
  it("uses the latest layer at the same priority", () => {
    const first = vi.fn(), second = vi.fn();
    dismissTopLayer(key(), [{ dismiss: first, priority: 100 }, { dismiss: second, priority: 100 }]);
    expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
  });
  it("does not cascade through layers on a held Escape", () => {
    const dismiss = vi.fn(), event = key({ repeat: true });
    dismissTopLayer(event, [{ dismiss, priority: 100 }]);
    expect(dismiss).not.toHaveBeenCalled(); expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it("leaves IME cancellation, other keys, and terminal Escape alone", () => {
    const dismiss = vi.fn();
    for (const event of [key({ isComposing: true }), key({ keyCode: 229 }), key({ key: "Enter" })]) {
      dismissTopLayer(event, [{ dismiss, priority: 100 }]);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    const event = key(); dismissTopLayer(event, []);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  });
});
