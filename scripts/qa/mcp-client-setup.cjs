// Synthetic IPC only: does not start MCP or change any installed AI client's configuration.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const platform of ["MacIntel", "Win32"]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", { get: () => platform });
        const config = { port: 38473, profile_ids: [1], allow_execution: false, allow_sftp_read: false, allow_sftp_write: false, acknowledge_risks: true };
        window.qa = { generation: 1, clipboard: "", writes: 0, approvals: [], clients: [], responses: [], status: { running: true, config, endpoint: "http://127.0.0.1:38473/mcp", token: "synthetic-token-1" } };
        let callback = 0;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => ++callback, unregisterCallback() {},
          async invoke(cmd, args = {}) {
            if (cmd.startsWith("plugin:event|")) return ++callback;
            if (cmd === "mcp_oauth_approvals") return structuredClone(qa.approvals);
            if (cmd === "mcp_oauth_clients") return structuredClone(qa.clients);
            if (cmd === "mcp_oauth_respond") {
              qa.responses.push(args);
              qa.approvals = qa.approvals.filter((p) => p.id !== args.id);
              if (args.accept) qa.clients.push({ id: "grant-1", name: "Fixture client", profile_ids: [1], approved_at: 1800000000, expires_at: 1807776000 });
            }
            if (cmd === "mcp_oauth_revoke") qa.clients = qa.clients.filter((c) => c.id !== args.id);
            if (cmd === "list_profiles") return [{ id: 1, name: "Fixture", host: "fixture.invalid", port: 22, username: "tester", protocol: "ssh" }];
            if (cmd === "mcp_status") return qa.status;
            if (cmd === "mcp_stop") { qa.status = { running: false, config: null, endpoint: null, token: null }; return; }
            if (cmd === "mcp_start") {
              qa.generation++;
              return qa.status = { running: true, config: args.config, endpoint: `http://127.0.0.1:${38472 + qa.generation}/mcp`, token: `synthetic-token-${qa.generation}` };
            }
            if (cmd === "plugin:clipboard-manager|write_text") {
              qa.writes++;
              if (qa.delay) await new Promise((resolve) => { qa.resolveCopy = resolve; });
              if (qa.fail) throw `fixture error containing ${qa.status.token}`;
              qa.clipboard = args.text;
            }
          },
        };
      }, platform);
      await page.route("**/__qa_mcp_setup", (route) => route.fulfill({ contentType: "text/html", body: `
        <link rel="stylesheet" href="/src/App.css"><div id="root"></div><script type="module">
        import Refresh from '/@react-refresh'; Refresh.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>t=>t; window.__vite_plugin_react_preamble_installed__=true;
        const [{default:React},{default:ReactDOM},{default:McpTab},{default:Approval}]=await Promise.all([
          import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),
          import('/src/components/common/settings/McpTab.tsx'),import('/src/components/common/McpOAuthApproval.tsx')]);
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,
          React.createElement('textarea',{'aria-label':'Terminal input'}),React.createElement(McpTab),
          React.createElement(Approval,{profiles:[{id:1,name:'Fixture SSH',username:'tester',host:'fixture.invalid'}]})));
        </script>` }));
      await page.goto(`${process.env.APP_URL || "http://127.0.0.1:1420"}/__qa_mcp_setup`);
      const setup = page.getByRole("region", { name: "Connect an AI client" });
      const client = setup.getByRole("combobox", { name: "Client", exact: true });
      const copy = setup.getByRole("button", { name: /^Copy / });
      await copy.waitFor();
      assert.equal(await setup.getByRole("combobox", { name: "Authentication", exact: true }).inputValue(), "oauth");
      for (const value of ["codex", "claude", "cursor", "kiro"]) {
        await client.selectOption(value); await copy.click(); await setup.getByRole("status").waitFor();
        const copied = await page.evaluate(() => qa.clipboard);
        assert.ok(copied.includes("http://127.0.0.1:38473/mcp"));
        assert.doesNotMatch(copied, /synthetic-token|Authorization|Bearer|bearer-token-env-var|\$\{/);
      }
      console.log(`PASS ${platform}: OAuth is default and all four setup copies omit credentials`);
      await setup.getByRole("combobox", { name: "Authentication", exact: true }).selectOption("manual");
      for (const value of ["codex", "claude", "cursor", "kiro"]) {
        await client.selectOption(value);
        assert.ok((await setup.locator("pre").innerText()).includes("<BEARER_TOKEN>"));
        assert.ok(!(await setup.innerText()).includes("synthetic-token-1"));
        await copy.click();
        await setup.getByRole("status").waitFor();
        const copied = await page.evaluate(() => qa.clipboard);
        assert.ok(copied.includes("synthetic-token-1"));
        assert.ok(copied.includes("http://127.0.0.1:38473/mcp"));
        assert.doesNotMatch(copied, /CYGNUS_MCP_TOKEN|bearer_token_env_var|bearer-token-env-var|\$\{|<BEARER_TOKEN>/);
        if (value === "codex") {
          assert.ok(copied.startsWith("[mcp_servers.cygnus]"));
          assert.ok(copied.includes('http_headers = { Authorization = "Bearer synthetic-token-1" }'));
          assert.ok((await setup.locator(".mcp-config-path").innerText()).includes(platform === "Win32" ? "%USERPROFILE%\\.codex\\config.toml" : "~/.codex/config.toml"));
        } else if (value === "claude") {
          assert.ok(copied.includes("--header 'Authorization: Bearer synthetic-token-1'"));
        } else {
          const config = JSON.parse(copied);
          assert.equal(config.mcpServers.cygnus.headers.Authorization, "Bearer synthetic-token-1");
          assert.deepEqual(config.mcpServers.cygnus.autoApprove ?? [], []);
        }
      }
      console.log(`PASS ${platform}: all four clients copy literal credentials; preview stays masked`);

      await page.evaluate(() => { qa.fail = true; });
      await copy.click();
      assert.equal(await setup.getByRole("alert").innerText(), "Could not copy the setup. Try again.");
      assert.ok(!(await setup.innerText()).includes("synthetic-token-1"));
      await page.evaluate(() => { qa.fail = false; qa.delay = true; });
      await copy.click();
      await page.waitForFunction(() => !!qa.resolveCopy);
      assert.equal(await setup.getByRole("button", { name: "Copying…" }).isDisabled(), true);
      await page.getByRole("button", { name: "Stop MCP", exact: true }).click();
      await page.getByRole("button", { name: "Start MCP", exact: true }).waitFor();
      assert.equal(await copy.count(), 0);
      assert.equal(await client.inputValue(), "kiro");
      assert.equal(await page.getByRole("button", { name: "Start MCP", exact: true }).isDisabled(), true);
      await page.locator("#mcp-acknowledge-risks").check();
      await page.getByRole("button", { name: "Start MCP", exact: true }).click();
      await copy.waitFor();
      assert.equal(await client.inputValue(), "kiro");
      await page.evaluate(() => { qa.delay = false; qa.resolveCopy(); });
      await page.waitForFunction(() => qa.clipboard.includes("synthetic-token-1"));
      // Flush React updates after the old clipboard promise completes.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await setup.getByRole("status").count(), 0);
      await copy.click();
      await setup.getByRole("status").waitFor();
      const updated = JSON.parse(await page.evaluate(() => qa.clipboard));
      assert.equal(updated.mcpServers.cygnus.headers.Authorization, "Bearer synthetic-token-2");
      assert.equal(updated.mcpServers.cygnus.url, "http://127.0.0.1:38474/mcp");
      console.log(`PASS ${platform}: failure recovery, consent, client retention and fresh-token copy after restart; stale success suppressed`);

      await page.getByRole("textbox", { name: "Terminal input" }).focus();
      await page.evaluate(() => { qa.approvals = [{ id: "pending-1", client_name: "Fixture client", verification_code: "MATCH123", redirect_uri: "http://127.0.0.1:54321/callback", profile_ids: [1], allow_execution: true, allow_sftp_read: true, allow_sftp_write: false, expires_at: Date.now() / 1000 + 300 }]; });
      await page.getByRole("button", { name: "Review connection" }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Terminal input" }).evaluate((el) => document.activeElement === el), true);
      assert.equal(await page.getByRole("dialog", { name: "Approve MCP connection" }).count(), 0);
      await page.getByRole("button", { name: "Review connection" }).click();
      const dialog = page.getByRole("dialog", { name: "Approve MCP connection" });
      assert.ok((await dialog.innerText()).includes("MATCH123"));
      assert.ok((await dialog.innerText()).includes("tester@fixture.invalid"));
      assert.equal(await dialog.getByRole("button", { name: "Approve connection", exact: true }).isDisabled(), true);
      await page.keyboard.press("Enter"); // Reject receives initial focus; Enter cannot approve.
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => qa.responses), [{ id: "pending-1", accept: false }]);
      await page.evaluate(() => { qa.approvals = [{ id: "pending-2", client_name: "Fixture client", verification_code: "MATCH456", redirect_uri: "http://127.0.0.1:54321/callback", profile_ids: [1], allow_execution: false, allow_sftp_read: false, allow_sftp_write: false, expires_at: Date.now() / 1000 + 300 }]; });
      await page.getByRole("button", { name: "Review connection" }).click();
      await page.setViewportSize({ width: 800, height: 600 });
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600);
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: "Approve connection", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => qa.responses[1]), { id: "pending-2", accept: true });
      const authorized = page.getByRole("region", { name: "Authorized clients" });
      await authorized.getByRole("button", { name: "Revoke access" }).click();
      await authorized.getByText("No authorized clients.", { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => qa.clients), []);
      console.log(`PASS ${platform}: approval notification preserves terminal focus; reject/consent/code display/revoke flow and 800×600 dialog verified`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
