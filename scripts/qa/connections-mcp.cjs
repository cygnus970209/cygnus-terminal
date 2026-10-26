// Full application with synthetic IPC. Does not contact servers or enable a real MCP endpoint.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      let count = 0;
      const profile = (id, name, group, protocol = "ssh") => ({ id, name, group_name: group, protocol, host: `${name}.invalid`, port: 22, username: "tester", auth_type: "password", target_os: "auto", remote_shell: "auto" });
      window.qa = {
        calls: [], profiles: [profile(1, "Alpha", "Production"), profile(2, "Beta", "Production"), profile(3, "Gamma", "Staging"), profile(4, "Console", "Lab", "telnet")],
        rdp: [{ id: 1, name: "Desktop", config: { host: "desktop.invalid", port: 3389, username: "admin", domain: "CORP", width: 1280, height: 720, desktop_scale_factor: 0 } }],
        status: { running: false, endpoint: null, token: null, config: null },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++count, unregisterCallback() {},
        async invoke(cmd, args = {}) {
          qa.calls.push({ cmd, args });
          if (cmd === "list_profiles") return qa.profiles;
          if (cmd === "get_profile") return qa.profiles.find(p => p.id === args.id);
          if (cmd === "rdp_list_profiles") return qa.rdp;
          if (cmd === "rdp_save_profile") {
            if (qa.failSave) throw "fixture save failed";
            const saved = { id: args.id ?? Math.max(0, ...qa.rdp.map(p => p.id)) + 1, ...args.data };
            qa.rdp = [...qa.rdp.filter(p => p.id !== saved.id), saved]; return saved;
          }
          if (cmd === "rdp_delete_profile") { qa.rdp = qa.rdp.filter(p => p.id !== args.id); return; }
          if (cmd === "rdp_connect") {
            const id = `rdp-${++count}`;
            setTimeout(() => args.events.onmessage({ type: "certificate", fingerprint: "AB".repeat(32), subject: "Fixture", issuer: "Fixture", valid_from: "2026", valid_until: "2027" }), 10);
            return id;
          }
          if (cmd === "mcp_status") return qa.status;
          if (cmd === "mcp_start") return qa.status = { running: true, config: args.config, endpoint: null, token: null };
          if (cmd === "mcp_stop") { qa.status = { running: false, config: null, endpoint: null, token: null }; return; }
          if (cmd.startsWith("plugin:event|")) return ++count;
          if (cmd.includes("list") || cmd.includes("history")) return [];
          return null;
        },
      };
    });
    await page.goto(process.env.APP_URL || "http://127.0.0.1:1420");
    const library = page.getByRole("region", { name: "Saved connections" });
    await library.getByRole("button", { name: "Connect to Desktop", exact: true }).waitFor();
    await library.getByRole("button", { name: "Favorite Alpha", exact: true }).click();
    await library.getByRole("button", { name: "Favorite Desktop", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("cygnus.connections.favorites"))), [1, "rdp:1"]);
    await library.getByRole("combobox", { name: "Filter by protocol" }).click();
    await page.getByRole("option", { name: "RDP (Beta)", exact: true }).click();
    assert.equal(await library.locator("tbody tr").count(), 1);
    console.log("PASS: RDP appears in library/filter and favorites cannot collide with SSH IDs");
    await library.getByRole("button", { name: "New connection", exact: true }).click();
    await page.getByRole("button", { name: "RDP (Beta)", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "New RDP connection" });
    await dialog.getByLabel("Name", { exact: true }).fill("Windows new");
    await dialog.getByLabel("Server", { exact: true }).fill("new.invalid");
    await dialog.getByLabel("Username", { exact: true }).fill("admin");
    if (process.env.QA_SCREENSHOT) await page.screenshot({ path: process.env.QA_SCREENSHOT.replace(/\.png$/, "-rdp.png") });
    await page.setViewportSize({ width: 800, height: 600 });
    await dialog.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.y + bounds.height <= 600);
    assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => qa.calls.some(c => c.cmd === "rdp_connect")), false);
    await library.getByRole("button", { name: "Edit Windows new", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Edit RDP connection" });
    assert.equal(await dialog.getByLabel("Server", { exact: true }).inputValue(), "new.invalid");
    assert.equal(await dialog.getByRole("button", { name: "SSH", exact: true }).isDisabled(), true);
    await dialog.getByLabel("Port", { exact: true }).fill("3390");
    await page.evaluate(() => { qa.failSave = true; });
    await dialog.getByRole("button", { name: "Save & Connect", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal(await page.evaluate(() => qa.calls.some(c => c.cmd === "rdp_connect")), false);
    await page.evaluate(() => { qa.failSave = false; });
    await dialog.getByRole("button", { name: "Save & Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Verify this RDP server" }).waitFor();
    assert.equal(await page.evaluate(() => qa.calls.filter(c => c.cmd === "rdp_connect").length), 1);
    assert.equal(await page.evaluate(() => qa.calls.find(c => c.cmd === "rdp_connect").args.config.port), 3390);
    assert.equal(await page.evaluate(() => qa.calls.some(c => c.cmd === "rdp_authenticate")), false);
    console.log("PASS: unified save/edit and Save & Connect retain certificate/password confirmation; failed save cannot connect");
    await page.locator(".sidebar-tools button").filter({ hasText: "Connections" }).click();
    await library.getByRole("button", { name: "Connect to Desktop", exact: true }).click();
    await page.waitForFunction(() => qa.calls.filter(c => c.cmd === "rdp_connect").length === 2);
    console.log("PASS: saved RDP row opens a desktop session directly");
    await page.locator(".sidebar-tools button").filter({ hasText: "Connections" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await library.getByRole("button", { name: "Delete Desktop", exact: true }).click();
    await page.waitForFunction(() => !qa.rdp.some(p => p.id === 1));
    assert.equal(await page.evaluate(() => qa.profiles.some(p => p.id === 1)), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("cygnus.connections.favorites"))), [1]);
    assert.equal(await page.evaluate(() => qa.calls.some(c => c.cmd === "delete_profile")), false);
    assert.equal(await page.evaluate(() => qa.calls.some(c => c.cmd === "rdp_close")), false);
    console.log("PASS: deleting an RDP profile preserves the SSH profile with the same ID and open sessions");
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByRole("button", { name: "RDP desktop (Beta)", exact: true }).click();
    await page.locator(".sidebar-tools button").filter({ hasText: "Settings" }).click();
    await page.getByRole("tab", { name: "MCP", exact: true }).click();
    const picker = page.getByRole("group", { name: "Shared SSH servers" });
    await picker.getByRole("checkbox", { name: "Share Alpha" }).waitFor();
    assert.equal(await picker.getByRole("checkbox", { name: "Share Console" }).count(), 0);
    await picker.getByLabel("Search MCP servers").fill("Alpha");
    await picker.getByRole("button", { name: "Select shown (1)" }).click();
    await picker.getByLabel("Search MCP servers").fill("Gamma");
    await picker.getByRole("button", { name: "Select shown (1)" }).click();
    await picker.getByRole("button", { name: "Clear shown" }).click();
    await picker.getByLabel("Search MCP servers").fill("");
    assert.equal(await picker.getByRole("checkbox", { name: "Share Alpha" }).isChecked(), true);
    assert.equal(await picker.getByRole("checkbox", { name: "Share Gamma" }).isChecked(), false);
    await picker.getByRole("combobox", { name: "MCP server group" }).click();
    await page.getByRole("option", { name: "Production", exact: true }).click();
    await picker.getByRole("button", { name: "Select shown (2)" }).click();
    await picker.getByRole("checkbox", { name: "Selected only", exact: true }).check();
    assert.equal(await picker.getByRole("checkbox", { name: /^Share / }).count(), 2);
    assert.equal(await page.getByRole("button", { name: "Start MCP", exact: true }).isDisabled(), true);
    await page.locator("#mcp-acknowledge-risks").check();
    await page.getByRole("button", { name: "Start MCP", exact: true }).click();
    await page.getByRole("button", { name: "Stop MCP", exact: true }).waitFor();
    const config = await page.evaluate(() => qa.calls.find(c => c.cmd === "mcp_start").args.config);
    assert.deepEqual(config.profile_ids, [1, 2]);
    assert.equal(config.allow_execution, false); assert.equal(config.allow_sftp_read, false); assert.equal(config.allow_sftp_write, false);
    assert.equal(await picker.getByRole("checkbox", { name: "Share Alpha" }).isDisabled(), true);
    await picker.getByLabel("Search MCP servers").fill("Alpha");
    assert.equal(await picker.getByRole("checkbox", { name: /^Share / }).count(), 1);
    await page.getByRole("button", { name: "Stop MCP", exact: true }).click();
    await page.getByRole("button", { name: "Start MCP", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Start MCP", exact: true }).isDisabled(), true);
    console.log("PASS: MCP search/group/bulk selection preserves hidden choices, excludes non-SSH, and retains consent/permission boundaries");
    if (process.env.QA_SCREENSHOT) {
      await picker.getByLabel("Search MCP servers").fill("");
      await picker.getByRole("checkbox", { name: "Selected only", exact: true }).uncheck();
      await picker.scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.QA_SCREENSHOT });
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
