// Synthetic fixture inputs only. Tauri IPC is mocked: no real SSH connections or credentials.
// Run with Vite running and PLAYWRIGHT_MODULE pointing to an installed playwright(-core).
// CHROME_PATH optionally selects an existing Chrome executable; APP_URL defaults to port 1420.
const { chromium, webkit } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
(async () => {
  const browser = await (process.argv[2] === "webkit"
    ? webkit.launch({ headless: true })
    : chromium.launch({
        ...(process.env.CHROME_PATH
          ? { executablePath: process.env.CHROME_PATH }
          : {}),
        headless: true,
      }));
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    let count = 0;
    const profiles = [
      {
        id: 1,
        name: "production-api",
        host: "10.0.1.24",
        port: 22,
        username: "deploy",
        auth_type: "key",
        group_name: "Production",
        protocol: "ssh",
      },
    ];
    window.qa = { profiles, calls: [], failSave: false };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback() {
        return ++count;
      },
      unregisterCallback() {},
      async invoke(cmd, args = {}) {
        if (!window.qa.vault)
          window.qa.vault = [
            {
              id: 1,
              label: "Production sudo",
              kind: "password",
              source: "cygnus",
              has_value: true,
              server_ids: [1],
              scope: null,
              sensitive: true,
            },
            {
              id: 2,
              label: "Deploy key",
              kind: "ssh-key",
              source: "cygnus",
              has_value: true,
              server_ids: [1],
              scope: null,
              sensitive: false,
            },
            {
              id: 3,
              label: "GitHub deploy token",
              kind: "pat-password",
              source: "cygnus",
              has_value: true,
              server_ids: [],
              scope: "global",
              sensitive: true,
            },
          ];
        if (cmd === "vault_list") {
          if (window.qa.failLoad) throw Error("Fixture load failure");
          return window.qa.vault;
        }
        if (cmd === "vault_create") {
          if (window.qa.failSave) throw Error("Fixture save failure");
          const item = { id: 4, ...args.req, has_value: !!args.req.value };
          window.qa.vault.push(item);
          return item;
        }
        if (cmd === "vault_update") {
          if (window.qa.failSave) throw Error("Fixture save failure");
          Object.assign(
            window.qa.vault.find((v) => v.id === args.id),
            args.req,
          );
          window.qa.lastUpdate = args;
          return;
        }
        if (cmd === "vault_link_server") {
          window.qa.vault.find((v) => v.id === args.vaultItemId).server_ids =
            args.serverIds;
          return;
        }
        if (cmd === "vault_delete") {
          window.qa.vault = window.qa.vault.filter((v) => v.id !== args.id);
          return;
        }

        window.qa.calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
        if (cmd === "vault_inject")
          return await new Promise((resolve) => setTimeout(resolve, 150));
        if (cmd === "list_profiles")
          return profiles.map((p) => ({ ...p, password: undefined }));
        if (cmd === "get_profile")
          return { ...profiles.find((p) => p.id === args.id) };
        if (cmd === "create_profile" || cmd === "update_profile") {
          if (window.qa.failSave) throw Error("Test storage failure");
          if (cmd === "update_profile") {
            let p = profiles.find((p) => p.id === args.id);
            Object.assign(p, JSON.parse(JSON.stringify(args.req)));
            return { ...p };
          }
          let p = { id: profiles.length + 1, protocol: "ssh", ...args.req };
          profiles.push(p);
          return { ...p };
        }
        if (cmd === "delete_profile") {
          profiles.splice(
            profiles.findIndex((p) => p.id === args.id),
            1,
          );
          return;
        }
        if (cmd.startsWith("create_") && cmd.endsWith("_session")) {
          window.qa.output = (data) =>
            args.onEvent.onmessage({ type: "Output", data });
          setTimeout(
            () =>
              args.onEvent.onmessage({
                type: "Output",
                data: "Connected to test device\r\n$ ",
              }),
            50,
          );
          return "session-" + ++count;
        }
        if (cmd.startsWith("plugin:event|")) return ++count;
        if (cmd === "sftp_open") return "sftp-test";
        if (cmd === "sftp_get_home_dir") return "/srv/api";
        if (cmd === "monitor_start") return "monitor-test";
        if (cmd === "monitor_get_stats")
          return {
            cpu_usage: 1,
            mem_usage: 2,
            disk_usage: 3,
            load_avg: "0.1",
            uptime: "1 day",
          };
        if (cmd.includes("list") || cmd.includes("history")) return [];
        return null;
      },
    };
  });
  await page.goto(process.env.APP_URL || "http://127.0.0.1:1420");

  await page.getByRole("button", { name: "Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Vault", exact: true });
  await dialog.getByText("Production sudo", { exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/vault-library.png" });
  await dialog.getByRole("button", { name: "Tokens 1", exact: true }).click();
  assert.equal(await dialog.locator(".vault-item").count(), 1);
  await dialog
    .getByRole("button", { name: "All credentials 3", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Search credentials" })
    .fill("production-api");
  assert.equal(await dialog.locator(".vault-item").count(), 2);
  await dialog.getByRole("textbox", { name: "Search credentials" }).fill("");
  await dialog
    .getByRole("button", { name: "Edit Production sudo", exact: true })
    .click();
  assert.equal(await dialog.locator("#vault-value").inputValue(), "");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "New credential", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => window.qa.lastUpdate.req.value),
    undefined,
  );
  await dialog
    .getByRole("button", { name: "New credential", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: false }).fill("Staging sudo");
  await dialog.locator("#vault-value").fill("fixture-only-secret");
  await dialog
    .getByRole("checkbox", { name: "production-api", exact: false })
    .check();
  await page.screenshot({ path: "/tmp/vault-editor.png" });
  await page.evaluate(() => (window.qa.failSave = true));
  await dialog
    .getByRole("button", { name: "Save credential", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await dialog.locator("#vault-value").inputValue(),
    "fixture-only-secret",
  );
  await page.evaluate(() => (window.qa.failSave = false));
  await dialog
    .getByRole("button", { name: "Save credential", exact: true })
    .click();
  await dialog.getByText("Staging sudo", { exact: true }).waitFor();
  await dialog
    .getByRole("button", { name: "Delete Staging sudo", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await dialog.getByText("Staging sudo", { exact: true }).count(),
    1,
  );
  await dialog
    .getByRole("button", { name: "Delete Staging sudo", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(
    await dialog.getByText("Staging sudo", { exact: true }).count(),
    0,
  );
  await page.setViewportSize({ width: 600, height: 450 });
  await page.screenshot({ path: "/tmp/vault-small.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await dialog
    .getByRole("button", { name: "New credential", exact: true })
    .click();
  await dialog.locator("summary").click();
  await dialog.getByRole("combobox", { name: "Credential scope" }).click();
  await page.getByRole("option", { name: "All servers", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save credential", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/vault-small-editor.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.keyboard.press("Escape");
  await dialog
    .getByRole("button", { name: "New credential", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await page.evaluate(() => (window.qa.failLoad = true));
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await dialog.getByText("Credentials unavailable", { exact: true }).waitFor();
  await page.evaluate(() => (window.qa.failLoad = false));
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await dialog.getByText("Production sudo", { exact: true }).waitFor();
  await dialog
    .getByRole("button", { name: "Close vault", exact: true })
    .click();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".ssh-connect").first().click();
  await page.locator(".xterm-helper-textarea").waitFor();
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.qa.calls = [];
    window.qa.output("\r\n[sudo] password for deploy: ");
  });
  await page.locator(".vpp").waitFor();
  const add = page.getByRole("button", { name: "+ 새 비밀번호", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await page.locator(".vpp-add").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".vpp-list").waitFor();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(
      () => window.qa.calls.filter((c) => c.cmd === "vault_inject").length,
    ),
    1,
  );
  assert.equal(
    await page.evaluate(
      () => window.qa.calls.filter((c) => c.cmd === "write_ssh").length,
    ),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: library filters/search, edit preserves secret, create/link, save error retained, delete confirmation/cancel, small layout, custom scope select, Escape navigation.",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
