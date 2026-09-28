// Synthetic fixture inputs only. Tauri IPC is mocked: no real SSH connections or credentials.
// This reproduces the defects present at 6ea61e4; assertions should fail once fixed.
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
const browser=await (process.argv[2]==='webkit'?webkit.launch({headless:true}):chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true}));
const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
let count=0;const profiles=[{id:1,name:'production-api',host:'10.0.1.24',port:22,username:'deploy',auth_type:'key',group_name:'Production',protocol:'ssh'}];
window.qa={profiles,calls:[],failSave:false};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback(){return ++count},unregisterCallback(){},async invoke(cmd,args={}){
if(cmd==='vault_list')return [{id:1,label:'Test credential',source:'cygnus',has_value:true,server_ids:[1]}];
window.qa.calls.push({cmd,args:JSON.parse(JSON.stringify(args))});
if(cmd==='list_profiles')return profiles.map(p=>({...p,password:undefined}));
if(cmd==='get_profile')return {...profiles.find(p=>p.id===args.id)};
if(cmd==='create_profile'||cmd==='update_profile'){
 if(window.qa.failSave)throw Error('Test storage failure');
 if(cmd==='update_profile'){let p=profiles.find(p=>p.id===args.id);Object.assign(p,JSON.parse(JSON.stringify(args.req)));return {...p};}
 let p={id:profiles.length+1,protocol:'ssh',...args.req};profiles.push(p);return {...p};
}
if(cmd==='delete_profile'){profiles.splice(profiles.findIndex(p=>p.id===args.id),1);return;}
if(cmd.startsWith('create_')&&cmd.endsWith('_session')){window.qa.output=(data)=>args.onEvent.onmessage({type:'Output',data});setTimeout(()=>args.onEvent.onmessage({type:'Output',data:'Connected to test device\r\n$ '}),50);return 'session-'+(++count)}
if(cmd.startsWith('plugin:event|'))return ++count;
if(cmd==='sftp_open')return 'sftp-test';if(cmd==='sftp_get_home_dir')return '/srv/api';
if(cmd==='monitor_start')return 'monitor-test';
if(cmd==='monitor_get_stats')return {cpu_usage:1,mem_usage:2,disk_usage:3,load_avg:'0.1',uptime:'1 day'};
if(cmd.includes('list')||cmd.includes('history'))return [];
return null;
}};
});
await page.goto(process.env.APP_URL || 'http://127.0.0.1:1420');

await page.locator('.ssh-connect').first().click();
const input=page.locator('.xterm-helper-textarea').first(); await input.waitFor();await input.focus();
async function snapshot(name){console.log(name,await page.evaluate(()=>({value:document.querySelector('.xterm-helper-textarea').value,data:window.qa.calls.filter(c=>c.cmd==='write_ssh').map(c=>c.args.data).join('')})));}
await page.keyboard.type('sudo su');await snapshot('normal before Enter');await page.keyboard.press('Enter');await snapshot('normal after Enter');
await page.keyboard.type('A B C');await snapshot('uppercase before Enter');await page.keyboard.press('Control+c');await snapshot('after CtrlC');
await page.evaluate(()=>{window.qa.calls=[];let t=document.querySelector('.xterm-helper-textarea');t.value='sudo su';t.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,which:229,bubbles:true,cancelable:true}));t.value='sudo sX';});
await page.waitForTimeout(500);await snapshot('229 same length replacement');
assert.equal(await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='write_ssh').map(c=>c.args.data).join('')),'sudo sX');
await page.keyboard.press('Control+c');await snapshot('229 CtrlC');

await page.evaluate(()=>{window.qa.calls=[];window.qa.output('\r\n[sudo] password for deploy: ');});
await page.locator('.vpp').waitFor({timeout:5000});await input.focus();await page.keyboard.press('Enter');await page.waitForTimeout(500);await snapshot('vault Enter focused terminal');
console.log('vault calls',await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='vault_inject')));
assert.equal(await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='vault_inject').length),1);
assert.equal(await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='write_ssh').map(c=>c.args.data).join('')),'\r');
assert.deepEqual(errors,[]);
console.log('Both known defects reproduced (this is an audit reproducer, not a correctness test).');
console.log('errors',errors);await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
