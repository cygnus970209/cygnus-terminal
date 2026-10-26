// Fixture transports only: never opens a real shell, SSH connection or MCP client.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({ headless: true });
  let checks = 0;
  try {
    for (const platform of ["MacIntel", "Win32"]) {
      for (const kind of ["local", "mcp"]) {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.addInitScript(({ platform, kind }) => {
          Object.defineProperty(navigator, "platform", { get: () => platform });
          let id = 0;
          window.qa = { kind, calls: [], text: "fixture 한글", delay: false };
          window.qa.job = { id: "job-1", profile_id: 1, profile_name: "Fixture", host: "fixture.invalid", username: "tester", status: "running", command: "cat", interactive: true };
          window.__TAURI_INTERNALS__ = {
            transformCallback: () => ++id, unregisterCallback() {},
            async invoke(command, args = {}) {
              qa.calls.push({ command, args });
              if (command === "create_pty_session") {
                qa.output = (text) => args.onEvent.onmessage({ type: "Output", data: text });
                return "session-1";
              }
              if (command === "execution_terminal_attach") {
                qa.output = (text) => args.onEvent.onmessage({ type: "Output", data: [...new TextEncoder().encode(text)] });
                args.onEvent.onmessage({ type: "Snapshot", data: { ...qa.job, stdout: "", stderr: "" } });
              }
              if (command === "plugin:clipboard-manager|read_text") {
                if (qa.delay) await new Promise((resolve) => { qa.resolveRead = resolve; });
                if (qa.failRead) throw "fixture clipboard unavailable";
                return qa.text;
              }
              return null;
            },
          };
        }, { platform, kind });
        await page.route("**/__qa_clipboard", (route) => route.fulfill({ contentType: "text/html", body: `
          <link rel="stylesheet" href="/src/App.css"><div id="root"></div><script type="module">
          import Refresh from '/@react-refresh'; Refresh.injectIntoGlobalHook(window);
          window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>t=>t; window.__vite_plugin_react_preamble_installed__=true;
          const [{default:React},{default:ReactDOM},{default:Terminal},{default:McpTerminal}]=await Promise.all([
            import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),
            import('/src/components/terminal/Terminal.tsx'),import('/src/components/terminal/McpTerminal.tsx')]);
          const root=ReactDOM.createRoot(document.getElementById('root')); const noop=()=>{};
          qa.render=(active)=>root.render(React.createElement('div',{style:{height:500}},
            React.createElement('button',{onClick:()=>qa.render(true)},'Activate tab'),
            React.createElement(qa.kind==='mcp'?McpTerminal:Terminal,{tabId:'fixture',type:'local',job:qa.job,isActive:active,onSessionStatus:noop,onJobStatus:noop})));
          qa.render(false);
          </script>` }));
        await page.goto(`${process.env.APP_URL || "http://127.0.0.1:1420"}/__qa_clipboard`);
        await page.waitForFunction(() => !!qa.output);
        await page.getByRole("button", { name: "Activate tab" }).click();
        const focusRestored = await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
        if (process.argv.includes("--baseline")) console.log(`${platform}/${kind}: tab restores focus = ${focusRestored}`);
        else { assert.equal(focusRestored, true); checks++; }
        await page.locator(".xterm-helper-textarea").focus();
        await page.evaluate((platform) => {
          qa.calls = [];
          document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: platform === "MacIntel" ? "ㅍ" : "v", code: "KeyV", metaKey: platform === "MacIntel", ctrlKey: platform !== "MacIntel", bubbles: true, cancelable: true }));
        }, platform);
        await page.waitForTimeout(100);
        const writes = await page.evaluate(() => qa.calls.filter(c => ["write_pty", "execution_terminal_input"].includes(c.command)).map(c => c.args.data));
        if (process.argv.includes("--baseline")) console.log(`${platform}/${kind}: paste writes = ${JSON.stringify(writes)}`);
        else { assert.deepEqual(writes, ["fixture 한글"]); checks++; }
        if (!process.argv.includes("--baseline")) {
          await page.evaluate(() => { qa.calls = []; qa.output("\x1b[?2004h"); });
          await page.waitForTimeout(100);
          await page.evaluate(() => {
            const data = new DataTransfer(); data.setData("text/plain", "one\r\ntwo\n한글");
            document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
          });
          await page.waitForTimeout(100);
          assert.deepEqual(await page.evaluate(() => qa.calls.filter(c => ["write_pty", "execution_terminal_input"].includes(c.command)).map(c => c.args.data)), ["\x1b[200~one\rtwo\r한글\x1b[201~"]); checks++;
          await page.evaluate(() => { qa.calls = []; qa.delay = true; });
          await page.keyboard.press(platform === "MacIntel" ? "Meta+v" : "Control+Shift+v");
          await page.waitForFunction(() => !!qa.resolveRead);
          await page.evaluate(() => qa.render(false));
          await page.waitForTimeout(50);
          await page.evaluate(() => qa.resolveRead());
          await page.waitForTimeout(100);
          assert.equal(await page.evaluate(() => qa.calls.some(c => ["write_pty", "execution_terminal_input"].includes(c.command))), false); checks++;
          await page.getByRole("button", { name: "Activate tab" }).click();
          await page.evaluate(() => { qa.delay = false; qa.failRead = true; });
          await page.keyboard.press(platform === "MacIntel" ? "Meta+v" : "Control+Shift+v");
          await page.getByText("Could not paste from the clipboard. Try again.", { exact: true }).waitFor(); checks++;
          await page.evaluate(() => { qa.failRead = false; qa.calls = []; qa.output("\x1b[?2004l\r\nselectable output"); });
          await page.waitForTimeout(100);
          await page.locator(".xterm-screen").click({ button: "right" });
          await page.getByRole("menuitem", { name: "Paste", exact: true }).click();
          await page.waitForTimeout(100);
          assert.deepEqual(await page.evaluate(() => qa.calls.filter(c => ["write_pty", "execution_terminal_input"].includes(c.command)).map(c => c.args.data)), ["fixture 한글"]); checks++;
          await page.evaluate(() => { qa.calls = []; });
          await page.keyboard.press("Control+c");
          await page.waitForTimeout(100);
          assert.deepEqual(await page.evaluate(() => qa.calls.filter(c => ["write_pty", "execution_terminal_input"].includes(c.command)).map(c => c.args.data)), ["\x03"]); checks++;
          if (platform === "Win32") {
            await page.evaluate(() => { qa.calls = []; });
            await page.keyboard.press("Shift+Insert");
            await page.waitForTimeout(100);
            assert.deepEqual(await page.evaluate(() => qa.calls.filter(c => ["write_pty", "execution_terminal_input"].includes(c.command)).map(c => c.args.data)), ["fixture 한글"]); checks++;
          }
          await page.locator(".xterm-screen").click({ button: "right" });
          await page.keyboard.press("Escape");
          assert.equal(await page.getByRole("menu", { name: "Terminal clipboard" }).count(), 0);
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")), true); checks++;
          await page.evaluate(() => { qa.calls = []; qa.delay = true; delete qa.resolveRead; });
          await page.keyboard.press(platform === "MacIntel" ? "Meta+v" : "Control+v");
          await page.waitForFunction(() => !!qa.resolveRead);
          await page.evaluate(() => qa.render(false));
          await page.waitForTimeout(50);
          await page.getByRole("button", { name: "Activate tab" }).click();
          await page.evaluate(() => qa.resolveRead());
          await page.waitForTimeout(100);
          assert.equal(await page.evaluate(() => qa.calls.some(c => ["write_pty", "execution_terminal_input"].includes(c.command))), false); checks++;
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    console.log(`Clipboard checks: ${checks} passed`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
