// Synthetic profiles only; native IPC and file picker are mocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    let count = 0;
    const candidate = (name, extra = {}) => ({
      profile: {
        name,
        host: `${name}.example.org`,
        port: 22,
        username: "deploy",
        group_name: "Production",
        key_path: "~/.ssh/deploy",
      },
      warnings: [],
      blocked: false,
      duplicate: false,
      ...extra,
    });
    const candidates = [
      candidate("api"),
      candidate("worker", {
        warnings: ["SSH key file not found — choose a key before connecting"],
      }),
      candidate("existing", { duplicate: true }),
      candidate("gateway", {
        blocked: true,
        warnings: ["proxyjump requires manual configuration"],
      }),
    ];
    candidates.push(
      candidate("73번 서버", {
        profile: {
          name: "73번 서버",
          host: "",
          port: 22,
          username: "",
          group_name: "iTerm2",
        },
        blocked: true,
        warnings: ["Not a supported SSH command"],
      }),
    );
    window.qa = {
      profiles: [],
      calls: [],
      failPreview: false,
      failImport: false,
      cancel: false,
    };
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
        window.qa.calls.push({ cmd, args });
        if (cmd === "list_profiles") return window.qa.profiles;
        if (cmd === "detect_migration_sources")
          return [
            {
              kind: "ssh",
              path: "/Users/demo/.ssh/config",
              name: "SSH config",
            },
            {
              kind: "iterm",
              path: "/Users/demo/Library/Preferences/com.googlecode.iterm2.plist",
              name: "iTerm2 profiles",
            },
          ];
        if (cmd === "preview_migration") {
          if (window.qa.failPreview) throw "Invalid iTerm2 JSON or plist";
          return {
            candidates,
            fingerprint: "fixture",
            groups: ["Production", "Staging"],
          };
        }
        if (cmd === "import_migration") {
          await new Promise((r) => setTimeout(r, 100));
          if (window.qa.failImport)
            throw "Source or saved connections changed. Preview again before importing.";
          window.qa.profiles = args.selection.indices.map((i) => ({
            ...candidates[i].profile,
            group_name:
              args.selection.group_overrides?.[i] ??
              candidates[i].profile.group_name,
            id: i + 1,
            protocol: "ssh",
            auth_type: "key",
          }));
          return window.qa.profiles.length;
        }
        if (cmd === "plugin:dialog|open")
          return window.qa.cancel ? null : "/tmp/profiles.json";
        if (cmd.startsWith("plugin:event|")) return ++count;
        if (cmd.includes("list") || cmd.includes("history")) return [];
        return null;
      },
    };
  });
  await page.goto(process.env.APP_URL || "http://127.0.0.1:1420");
  await page
    .getByRole("button", { name: "Import existing connections", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Import connections" });
  await dialog.getByRole("button", { name: /SSH config.*Users/ }).waitFor();
  await page.screenshot({ path: "/tmp/migration-sources.png" });
  await dialog.getByRole("button", { name: /SSH config.*Users/ }).click();
  await dialog
    .getByRole("checkbox", { name: "Import api", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "Import existing", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "Import gateway", exact: true })
      .isDisabled(),
    true,
  );
  await dialog
    .getByRole("checkbox", { name: "Import worker", exact: true })
    .uncheck();
  assert.equal(
    await dialog
      .getByText("Address unavailable — review source settings", {
        exact: true,
      })
      .count(),
    1,
  );
  assert.equal(
    await dialog.getByText("73번 서버:22", { exact: true }).count(),
    0,
  );
  const groupSelect = dialog.getByRole("combobox", {
    name: "Group for api",
    exact: true,
  });
  await groupSelect.click();
  await page.getByRole("option", { name: "Staging", exact: true }).click();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "Import api", exact: true })
      .isChecked(),
    true,
  );
  await groupSelect.click();
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 1);
  await dialog
    .getByRole("combobox", { name: "Group for worker", exact: true })
    .click();
  await page.getByRole("option", { name: "No group", exact: true }).click();
  assert.equal(
    await dialog
      .getByRole("combobox", { name: "Group for existing", exact: true })
      .isDisabled(),
    true,
  );
  await page.screenshot({ path: "/tmp/migration-preview.png" });
  await page.evaluate(() => {
    window.qa.failImport = true;
  });
  await dialog
    .getByRole("button", { name: "Import 1 connection", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "Import api", exact: true })
      .isChecked(),
    true,
  );
  await page.evaluate(() => {
    window.qa.failImport = false;
  });
  await dialog
    .getByRole("button", { name: "Import 1 connection", exact: true })
    .click();
  await dialog
    .getByRole("heading", { name: "1 connection imported" })
    .waitFor();
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.qa.calls.filter((c) => c.cmd === "import_migration").at(-1).args
          .selection.indices,
    ),
    [0],
  );
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.qa.calls.filter((c) => c.cmd === "import_migration").at(-1).args
          .selection.group_overrides,
    ),
    { 0: "Staging" },
  );
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect to api", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Import connections", exact: true })
    .first()
    .click();
  await page.evaluate(() => {
    window.qa.cancel = true;
  });
  await dialog
    .getByRole("button", {
      name: "iTerm2 profiles Exported JSON or preferences plist",
      exact: true,
    })
    .click();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  await page.evaluate(() => {
    window.qa.cancel = false;
    window.qa.failPreview = true;
  });
  await dialog
    .getByRole("button", {
      name: "iTerm2 profiles Exported JSON or preferences plist",
      exact: true,
    })
    .click();
  await dialog.getByRole("alert").waitFor();
  await page.evaluate(() => {
    window.qa.failPreview = false;
  });
  await dialog
    .getByRole("button", {
      name: "iTerm2 profiles Exported JSON or preferences plist",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("checkbox", { name: "Import api", exact: true })
    .waitFor();
  await dialog
    .getByRole("checkbox", {
      name: "Select all available connections",
      exact: true,
    })
    .uncheck();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Import 0 connections", exact: true })
      .isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 600, height: 450 });
  await page.screenshot({ path: "/tmp/migration-small.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await dialog
    .getByRole("button", { name: "Close import", exact: true })
    .focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Back", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "Migration QA passed: detection, preview, selection, blocked/duplicate rows, retry, save refresh, picker cancel, keyboard and small viewport.",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
