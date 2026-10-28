import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocale, setLocale, resolveLocale, translate } from "./index";
import ko from "./ko.json";
import en from "./en.json";
import SettingsDialog from "../components/common/SettingsDialog";
import ProtocolPicker from "../components/connection/ProtocolPicker";
import WinrmConnectDialog from "../components/connection/WinrmConnectDialog";

afterEach(() => {
  vi.stubGlobal("localStorage", { setItem: vi.fn() }); setLocale("en"); vi.unstubAllGlobals();
});
describe("app language", () => {
  it("honors a saved language before the system preference and falls back to English", () => {
    expect(resolveLocale("en", ["ko-KR"])).toBe("en");
    expect(resolveLocale("ko", ["en-US"])).toBe("ko");
    expect(resolveLocale(null, ["ko-KR"])).toBe("ko");
    expect(resolveLocale("invalid", ["fr-FR"])).toBe("en");
  });
  it("saves a language without silently claiming success on storage failure", () => {
    const setItem = vi.fn(); vi.stubGlobal("localStorage", { setItem });
    setLocale("ko"); expect(setItem).toHaveBeenCalledWith("cygnus.locale", "ko");
    expect(getLocale()).toBe("ko");
    setItem.mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(() => setLocale("en")).toThrow("storage unavailable"); expect(getLocale()).toBe("ko");
  });
  it("renders settings, tab labels, and connection options in both languages", () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    for (const [language, title, general, serial] of [["ko", "설정", "일반", "시리얼"], ["en", "Settings", "General", "Serial"]] as const) {
      setLocale(language);
      const settings = renderToStaticMarkup(<SettingsDialog onClose={() => {}} />);
      expect(settings).toContain(title); expect(settings).toContain(general);
      expect(settings).toContain(language === "ko" ? "한국어" : "English");
      expect(renderToStaticMarkup(<ProtocolPicker value="ssh" />)).toContain(serial);
    }
  });
  it("translates legacy Korean instructions into English and preserves substitutions verbatim", () => {
    expect(translate("닫기 (Esc)", "en")).toBe("Close (Esc)");
    expect(translate("Unknown authored message", "ko")).toBe("Unknown authored message");
    expect(translate("Host {name}", "en", { name: "$& <server> {other}" })).toBe("Host $& <server> {other}");
  });
  it("keeps the same interpolation placeholders in every translation", () => {
    for (const dictionary of [ko, en]) for (const [source, value] of Object.entries(dictionary)) {
      const keys = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(keys(value), source).toEqual(keys(source));
    }
  });
  it("renders the WinRM form in either language with HTTPS and NTLM selected by default", () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    for (const language of ["en", "ko"] as const) {
      setLocale(language);
      const html = renderToStaticMarkup(<WinrmConnectDialog profile={null} onProtocolChange={() => {}} onSaved={() => {}} onConnect={() => {}} onCancel={() => {}} />);
      expect(html).toContain(language === "ko" ? "새 WinRM 연결" : "New WinRM connection");
      expect(html).toContain("5986");
      expect(html).toContain("HTTPS"); expect(html).toContain("NTLM");
      expect(html).toContain('aria-modal="true"');
    }
  });
});
