// Synthetic fixture inputs only. Tauri IPC is mocked: no real SSH connections or credentials.
// Regression check: hidden / collapsed windows must not resize the remote terminal.
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

await page.waitForTimeout(300);
console.log('initial',await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='resize_ssh')));
await page.evaluate(()=>{window.qa.calls=[];Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));const host=document.querySelector('.xterm').parentElement;host.style.width='100px';window.dispatchEvent(new Event('resize'));});
await page.waitForTimeout(300);
assert.deepEqual(await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='resize_ssh')), []);
await page.evaluate(()=>{document.querySelector('.xterm').parentElement.style.width='100%';Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));});
await page.waitForTimeout(300);

assert.deepEqual(await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='resize_ssh')), []);
// Visibility recovery must fit even when the element size itself did not change on restore.
await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));document.querySelector('.xterm').parentElement.style.width='600px';});
await page.waitForTimeout(300);
assert.deepEqual(await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='resize_ssh')), []);
await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
await page.waitForTimeout(300);
const restored=await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='resize_ssh'));
assert.equal(restored.length,1);assert(restored[0].args.cols > 50 && restored[0].args.cols < 80);
// Positive width alone is insufficient: collapsed height must also be ignored.
await page.evaluate(()=>{window.qa.calls=[];document.querySelector('.xterm').parentElement.style.height='0px';window.dispatchEvent(new Event('resize'));});
await page.waitForTimeout(300);
assert.deepEqual(await page.evaluate(()=>window.qa.calls.filter(c=>c.cmd==='resize_ssh')), []);
assert.deepEqual(errors,[]);
console.log('PASS: no hidden resize; unchanged-size restore; visibility-only restore; zero-height guard.');

await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
