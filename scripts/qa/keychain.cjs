// Synthetic credentials and mocked IPC; never accesses the real OS keychain.
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
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    let count = 0;
    const profile = {
      id: 1,
      name: "Test server",
      host: "example.org",
      port: 22,
      username: "deploy",
      auth_type: "password",
      group_name: "Production",
      protocol: "ssh",
    };
    window.qa = { calls: [], unlocked: false, deny: false };
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
      async invoke(cmd, args) {
        window.qa.calls.push(cmd);
        if (cmd === "list_profiles") return [profile];
        if (cmd === "get_profile") {
          if (!window.qa.unlocked) throw "KEYCHAIN_CONSENT_REQUIRED";
          return {
            ...profile,
            password: "synthetic-secret",
            jump_host: JSON.stringify({
              host: "jump.example.org",
              port: 22,
              username: "jump-user",
              auth_type: "password",
              password: "synthetic-jump-secret",
            }),
          };
        }
        if (cmd === "authorize_keychain_access") {
          if (window.qa.deny) throw "Keychain access denied";
          window.qa.unlocked = true;
          return;
        }
        if (cmd.startsWith("plugin:event|")) return ++count;
        if (cmd.includes("list") || cmd.includes("history")) return [];
        return null;
      },
    };
  });
  await page.goto(process.env.APP_URL || "http://127.0.0.1:1420");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const edit = page.getByRole("button", {
    name: "Edit Test server",
    exact: true,
  });
  await edit.click();
  const notice = page.getByRole("dialog", {
    name: "Before macOS asks for access",
  });
  await notice.waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.qa.calls.includes("authorize_keychain_access"),
    ),
    false,
  );
  await page.screenshot({ path: "/tmp/keychain-notice.png" });
  await notice.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await notice.count(), 0);
  assert.equal(
    await page.evaluate(() =>
      window.qa.calls.includes("authorize_keychain_access"),
    ),
    false,
  );
  await edit.click();
  await notice.waitFor();
  await page.setViewportSize({ width: 600, height: 450 });
  await page.screenshot({ path: "/tmp/keychain-notice-small.png" });
  await notice.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await notice
      .getByRole("button", { name: "Continue", exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await notice.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(
    () => localStorage.getItem("cygnus.keychain-explained.v1") === "true",
  );
  assert.equal(await notice.count(), 0);
  // The edit dialog still receives jump-host details after the startup list omits them.
  await page.locator('input[value="jump.example.org"]').waitFor({ state: "attached" });
  assert.equal(
    await page
      .locator(
        'input[value="synthetic-secret"], input[value="synthetic-jump-secret"]',
      )
      .count(),
    0,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Test server", exact: true })
    .click();
  await page.waitForFunction(() => window.qa.unlocked);
  assert.equal(await notice.count(), 0);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "Keychain notice QA passed: no startup prompt, pre-access notice, cancel, Continue, keyboard, small viewport, remembered explanation.",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
