// Local fixtures only. Run with Vite and PLAYWRIGHT_MODULE pointing to Playwright.
// No credentials, SSH servers or MCP clients are contacted.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

(async () => {
  const browser = await (process.argv[2] === "webkit" ? webkit : chromium).launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    await page.route("**/__qa_mcp_terminal", (route) => route.fulfill({
      contentType: "text/html",
      body: `<html><head><link rel="stylesheet" href="/src/App.css"></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const [{ default: React }, { default: ReactDOM }, { default: McpTerminal }] = await Promise.all([
          import('/node_modules/.vite/deps/react.js'),
          import('/node_modules/.vite/deps/react-dom_client.js'),
          import('/src/components/terminal/McpTerminal.tsx'),
        ]);
        const noop = () => {};
        window.qa.render = (active = true) => root.render(React.createElement('div', {style:{height:600}},
          React.createElement('button', {onClick: () => window.qa.render(true)}, 'MCP tab'),
          React.createElement(McpTerminal, {tabId:'mcp-slot', job:window.qa.job, isActive:active,
            onSessionStatus:noop, onJobStatus:noop})));
        const root = ReactDOM.createRoot(document.getElementById('root'));
        window.qa.render(false);
      </script></body></html>`,
    }));
    await page.addInitScript(() => {
      let id = 0;
      window.qa = {
        calls: [],
        job: { id: "job-1", profile_id: 1, profile_name: "Fixture", host: "fixture.invalid", port: 22,
          username: "tester", environment: "test", command: "sudo whoami", timeout_seconds: 300,
          output_limit_bytes: 65536, status: "running", started_at: "2026-10-26T00:00:00Z",
          finished_at: null, duration_ms: null, exit_code: null, exit_signal: null,
          output_truncated: false, interactive: true, output_withheld: false,
          remote_outcome_unknown: true, error: null, persistence_error: null },
      };
      window.__TAURI_INTERNALS__ = {
        transformCallback() { return ++id; }, unregisterCallback() {},
        async invoke(command, args = {}) {
          window.qa.calls.push({ command, args });
          if (command === "execution_terminal_attach") {
            window.qa.emit = (event) => args.onEvent.onmessage(event);
            window.qa.output = (text) => window.qa.emit({type:"Output", data:[...new TextEncoder().encode(text)]});
            window.qa.emit({ type: "Snapshot", data: { ...window.qa.job, stdout: "", stderr: "" } });
          }
          if (command === "vault_list") return [
            { id: 7, label: "Fixture sudo", kind: "password", source: "cygnus", has_value: true, server_ids: [1] },
          ];
          if (command === "vault_inject" && window.qa.failInjection) throw "Fixture injection failed";
          if (command === "vault_inject") await new Promise((resolve) => setTimeout(resolve, 100));
          if (command === "plugin:clipboard-manager|read_text") return "fixture-paste";
          return null;
        },
      };
    });
    await page.goto(`${process.env.APP_URL || "http://127.0.0.1:1420"}/__qa_mcp_terminal`);
    await page.waitForFunction(() => !!window.qa.output, null, { timeout: 5000 });
    await page.getByRole("button", { name: "MCP tab", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"), null, {timeout:2000});
    await page.keyboard.type("x");
    await page.waitForFunction(() => window.qa.calls.some((c) => c.command === "execution_terminal_input"));
    console.log("PASS: switching to a running MCP tab restores keyboard input");

    await page.evaluate(() => window.qa.output("\r\n\x1b[33m[sudo] pass"));
    assert.equal(await page.locator(".vpp").count(), 0);
    await page.evaluate(() => window.qa.output("word for tester:\x1b[0m "));
    await page.locator(".vpp").waitFor({timeout:2000});
    assert.equal(await page.evaluate(() => window.qa.calls.filter((c) => c.command === "vault_inject").length), 0);
    console.log("PASS: split ANSI sudo prompt opens picker without auto-injecting");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
    await page.keyboard.type("fixture-manual");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.qa.calls.some((c) => c.command === "execution_terminal_input" && c.args.data === "\r"));
    assert.equal(await page.locator(".vpp").count(), 0);
    console.log("PASS: dismissing the picker allows direct terminal input");

    const passwordButton = page.getByRole("button", { name: "Password / Vault", exact: true });
    const picker = page.getByRole("dialog", { name: "Vault password input" });
    await passwordButton.click();
    await picker.getByRole("button", { name: "직접 입력", exact: true }).click();
    await picker.getByLabel("비밀번호", { exact: true }).fill("fixture-once-한글");
    if (process.env.QA_SCREENSHOT) await page.screenshot({ path: process.env.QA_SCREENSHOT });
    await picker.getByRole("button", { name: "전송", exact: true }).click();
    await picker.waitFor({ state: "hidden" });
    const manual = await page.evaluate(() => window.qa.calls.filter((c) => c.command === "execution_terminal_input" && c.args.data.includes("fixture-once")));
    assert.deepEqual(manual.map((c) => c.args), [{ jobId: "job-1", data: "fixture-once-한글\r" }]);
    assert.equal(await page.evaluate(() => window.qa.calls.some((c) => /vault_create|save_command_history/.test(c.command))), false);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-once")), false);
    console.log("PASS: masked one-time password sends once to the current job without saving");

    await passwordButton.click();
    await page.evaluate(() => { window.qa.failInjection = true; });
    await picker.getByRole("button", { name: /Fixture sudo/ }).click();
    await picker.getByText("Fixture injection failed", { exact: true }).waitFor();
    await page.evaluate(() => { window.qa.failInjection = false; window.qa.calls = []; });
    await picker.getByRole("button", { name: /Fixture sudo/ }).click();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await picker.waitFor({ state: "hidden" });
    const vault = await page.evaluate(() => window.qa.calls.filter((c) => c.command === "vault_inject"));
    assert.equal(vault.length, 1);
    assert.deepEqual(vault[0].args, { jobId: "job-1", vaultItemId: 7 });
    console.log("PASS: Vault handles failure and duplicate submission; only the item ID crosses IPC");

    await page.evaluate(() => window.qa.render(false));
    await page.locator(".mcp-terminal").waitFor({ state: "hidden" });
    await page.evaluate(() => window.qa.output("\r\n[sudo] password for tester: "));
    // Wait for xterm's asynchronous parser while the tab is hidden.
    await page.waitForTimeout(100);
    assert.equal(await picker.count(), 0);
    await page.getByRole("button", { name: "MCP tab", exact: true }).click();
    await picker.waitFor();
    await picker.getByRole("button", { name: "직접 입력", exact: true }).click();
    await picker.getByLabel("비밀번호", { exact: true }).fill("discard-on-hide");
    await page.evaluate(() => window.qa.render(false));
    await picker.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "MCP tab", exact: true }).click();
    await passwordButton.click();
    await picker.getByRole("button", { name: "직접 입력", exact: true }).click();
    assert.equal(await picker.getByLabel("비밀번호", { exact: true }).inputValue(), "");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    console.log("PASS: background prompts wait for their tab, and hiding discards password drafts");

    await page.evaluate(() => {
      const dialog = document.createElement("div"); dialog.id = "other-dialog";
      dialog.setAttribute("role", "dialog"); dialog.innerHTML = '<input id="other-input">';
      document.body.appendChild(dialog); document.getElementById("other-input").focus();
      window.qa.output("\r\n[sudo] password for tester: ");
    });
    await page.waitForTimeout(100);
    assert.equal(await picker.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), "other-input");
    await page.evaluate(() => document.getElementById("other-dialog").remove());
    await passwordButton.click();
    await page.keyboard.press("Escape");
    console.log("PASS: automatic prompt detection does not steal another dialog's focus");

    await page.evaluate(() => window.qa.output("\x1b[?1049h\r\n[sudo] password for tester: "));
    await page.waitForTimeout(100);
    assert.equal(await picker.count(), 0);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("cygnus-vault-prompts-change", { detail: [] }));
    });
    // Let the settings render commit before simulating the next server event.
    await page.waitForTimeout(100);
    await page.evaluate(() => window.qa.output("\x1b[?1049l\r\n[sudo] password for tester: "));
    await page.waitForTimeout(100);
    assert.equal(await picker.count(), 0);
    console.log("PASS: alternate screens and disabled prompt rules do not trigger the picker");

    await passwordButton.click();
    await picker.getByRole("button", { name: "직접 입력", exact: true }).click();
    await picker.getByLabel("비밀번호", { exact: true }).fill("discard-on-finish");
    await page.evaluate(() => window.qa.emit({ type: "Status", data: { ...window.qa.job, status: "timed_out" } }));
    await picker.waitFor({ state: "hidden" });
    await page.locator(".xterm-helper-textarea").focus();
    await page.evaluate(() => { window.qa.calls = []; });
    await page.keyboard.type("late");
    assert.equal(await passwordButton.count(), 0);
    assert.equal(await page.evaluate(() => window.qa.calls.some((c) => c.command === "execution_terminal_input")), false);
    console.log("PASS: completion removes the password form and blocks late input");

    await page.evaluate(() => {
      window.qa.job = { ...window.qa.job, id: "job-2" }; window.qa.render(true);
    });
    await passwordButton.waitFor();
    await passwordButton.click();
    await picker.getByRole("button", { name: "직접 입력", exact: true }).click();
    assert.equal(await picker.getByLabel("비밀번호", { exact: true }).inputValue(), "");
    await picker.getByLabel("비밀번호", { exact: true }).fill("fixture-next-job");
    await picker.getByRole("button", { name: "전송", exact: true }).click();
    await picker.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.qa.calls.filter((c) => c.command === "execution_terminal_input").map((c) => c.args)),
      [{ jobId: "job-2", data: "fixture-next-job\r" }]);
    console.log("PASS: reused tabs discard drafts and route input to the new job only");

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
