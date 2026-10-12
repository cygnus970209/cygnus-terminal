import { describe, expect, test } from "vitest";
import type { Tab } from "../types";
import { activeTabAfterClose, moveTab, tabsToClose, toggleTabPin } from "./tabs";

const tab = (id: string, pinned = false): Tab => ({ id, pinned, title: id, type: "local" });
const ids = (tabs: Tab[]) => tabs.map((item) => item.id);
const fixture = () => [tab("p1", true), tab("p2", true), tab("a"), tab("b"), tab("c")];

describe("tab pinning and order", () => {
  test("pinning moves a tab behind existing pins without losing session configuration", () => {
    const original = [...fixture(), { ...tab("ssh"), type: "ssh" as const, sshConfig: { host: "example.test" } }];
    const result = toggleTabPin(original, "ssh");
    expect(ids(result)).toEqual(["p1", "p2", "ssh", "a", "b", "c"]);
    expect(result[2]).toEqual({ ...original[5], pinned: true });
    expect(ids(original)).toEqual(["p1", "p2", "a", "b", "c", "ssh"]);
  });
  test("unpinning places the tab at the start of regular tabs", () => {
    expect(ids(toggleTabPin(fixture(), "p1"))).toEqual(["p2", "p1", "a", "b", "c"]);
    expect(toggleTabPin(fixture(), "p1")[1].pinned).toBe(false);
  });
  test("reorders in both directions using the requested drop side", () => {
    expect(ids(moveTab(fixture(), "a", "c", "after"))).toEqual(["p1", "p2", "b", "c", "a"]);
    expect(ids(moveTab(fixture(), "c", "a", "before"))).toEqual(["p1", "p2", "c", "a", "b"]);
    expect(ids(moveTab(fixture(), "p2", "p1", "before"))).toEqual(["p2", "p1", "a", "b", "c"]);
  });
  test("dragging cannot cross pin boundaries or implicitly pin/unpin", () => {
    const tabs = fixture();
    expect(moveTab(tabs, "a", "p1", "before")).toBe(tabs);
    expect(moveTab(tabs, "p1", "c", "after")).toBe(tabs);
  });
  test("stale IDs and drops on the same tab are harmless", () => {
    const tabs = fixture();
    expect(toggleTabPin(tabs, "removed")).toBe(tabs);
    expect(moveTab(tabs, "removed", "a", "before")).toBe(tabs);
    expect(moveTab(tabs, "a", "removed", "before")).toBe(tabs);
    expect(moveTab(tabs, "a", "a", "after")).toBe(tabs);
  });
});

describe("closing tabs", () => {
  test("bulk actions always preserve pins and the context tab", () => {
    expect([...tabsToClose(fixture(), "b", "others")]).toEqual(["a", "c"]);
    expect([...tabsToClose(fixture(), "b", "left")]).toEqual(["a"]);
    expect([...tabsToClose(fixture(), "b", "right")]).toEqual(["c"]);
    expect([...tabsToClose(fixture(), "p1", "right")]).toEqual(["a", "b", "c"]);
  });
  test("left/right refer to the current order after dragging", () => {
    const tabs = moveTab(fixture(), "c", "a", "before");
    expect([...tabsToClose(tabs, "a", "left")]).toEqual(["c"]);
    expect([...tabsToClose(tabs, "a", "right")]).toEqual(["b"]);
  });
  test("directly closing a pinned tab is allowed", () => {
    expect([...tabsToClose(fixture(), "p1", "single")]).toEqual(["p1"]);
  });
  test("actions with no eligible tabs do nothing", () => {
    expect(tabsToClose(fixture(), "p2", "left").size).toBe(0);
    expect(tabsToClose(fixture(), "c", "right").size).toBe(0);
    expect(tabsToClose(fixture(), "removed", "others").size).toBe(0);
    expect(tabsToClose([tab("a", true), tab("b", true)], "a", "others").size).toBe(0);
  });
  test("keeps the active tab unless it is actually closed", () => {
    const closing = tabsToClose(fixture(), "b", "others");
    expect(activeTabAfterClose(fixture(), "p1", closing)).toBe("p1");
    expect(activeTabAfterClose(fixture(), "connections", closing)).toBe("connections");
  });
  test("selects a surviving neighbor after closing several tabs atomically", () => {
    const closing = tabsToClose(fixture(), "b", "others");
    expect(activeTabAfterClose(fixture(), "a", closing)).toBe("b");
    expect(activeTabAfterClose(fixture(), "c", closing)).toBe("b");
    expect(activeTabAfterClose([tab("a")], "a", new Set(["a"]))).toBe("connections");
  });
  test("SSH bulk close preserves connections required by retained SFTP tabs", () => {
    const tabs: Tab[] = [{ ...tab("ssh"), type: "ssh" }, tab("other"),
      { ...tab("files", true), type: "sftp", linkedSessionId: "ssh" }];
    expect(tabsToClose(tabs, "other", "others").size).toBe(0);
    tabs[2].pinned = false;
    expect([...tabsToClose(tabs, "files", "left")]).toEqual(["other"]);
  });
  test("direct SSH close removes dependent regular tabs but never a pinned one", () => {
    const tabs: Tab[] = [{ ...tab("ssh"), type: "ssh" },
      { ...tab("files"), type: "sftp", linkedSessionId: "ssh" },
      { ...tab("pinned-files", true), type: "sftp", linkedSessionId: "ssh" }];
    expect([...tabsToClose(tabs, "ssh", "single")]).toEqual(["ssh", "files"]);
    expect(activeTabAfterClose(tabs, "pinned-files", tabsToClose(tabs, "ssh", "single"))).toBe("pinned-files");
  });
});
