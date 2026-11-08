import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base=process.env.TEST_BASE_URL||'http://localhost:8089', stamp=Date.now().toString(36), headers={Origin:new URL(base).origin};
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const contexts=[];
async function post(c,path,data){const r=await c.request.post(base+'/api'+path,{headers,data});assert.equal(r.status(),200,await r.text());return r.json();}
try{
 for(let i=0;i<3;i++)contexts.push(await browser.newContext());
 const users=[];for(const [i,c]of contexts.entries())users.push(await post(c,'/auth/register',{username:`media_${stamp}_${i}`,password:'12345678',name:`Media ${i}`}));
 const [a,b,outside]=contexts;
 const {id}=await post(a,'/conversations',{members:[users[1].id],kind:'direct'});
 const page=await b.newPage();await page.goto(base);await page.locator('.conversation').filter({hasText:'Media 0'}).click();
 const attachments=[];
 for(const [name,type]of [['sample.png','image/png'],['sample.mp4','video/mp4']]){
  const bytes=await readFile(`tests/fixtures/${name}`);
  const r=await a.request.post(`${base}/api/conversations/${id}/attachments`,{headers,multipart:{file:{name,mimeType:type,buffer:bytes}}});assert.equal(r.status(),200);const attachment=await r.json();assert.equal(attachment.mime,type);attachments.push(attachment);
  await post(a,`/conversations/${id}/messages`,{body:'',client_message_id:crypto.randomUUID(),attachment_id:attachment.id});
  const url=`${base}/api/attachments/${attachment.id}?inline=1`;
  const allowed=await b.request.get(url);assert.equal(allowed.status(),200);assert.equal(allowed.headers()['content-type'],type);assert.ok(allowed.headers()['content-disposition'].startsWith('inline;'));assert.deepEqual(await allowed.body(),bytes);
  assert.equal((await outside.request.get(url)).status(),403);
  const partial=await b.request.get(url,{headers:{Range:'bytes=10-49'}});assert.equal(partial.status(),206);assert.equal(partial.headers()['content-range'],`bytes 10-49/${bytes.length}`);assert.deepEqual(await partial.body(),bytes.subarray(10,50));
  const suffix=await b.request.get(url,{headers:{Range:'bytes=-8'}});assert.equal(suffix.status(),206);assert.deepEqual(await suffix.body(),bytes.subarray(-8));
  assert.equal((await b.request.get(url,{headers:{Range:`bytes=${bytes.length}-`}})).status(),416);
 }
 await page.waitForFunction(()=>document.querySelector('.inline-attachment img')?.naturalWidth>0);
 await page.waitForFunction(()=>document.querySelector('.inline-attachment video')?.readyState>=1);
 await page.locator('.inline-attachment video').evaluate(v=>v.play());await page.waitForTimeout(350);assert.ok(await page.locator('.inline-attachment video').evaluate(v=>v.currentTime>0));await page.locator('.inline-attachment video').evaluate(v=>v.pause());
 for(const width of [320,390,1365]){await page.setViewportSize({width,height:844});await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.screenshot({path:'test-results/inline-media.png'});
 const dialog=await page.getByRole('button',{name:'Thông tin cuộc trò chuyện',exact:true}).click();await page.getByRole('button',{name:'Đóng thông tin',exact:true}).click();
 console.log('PASS: inline image decode/video playback, authenticated previews, original download support, byte ranges/suffix/416 and responsive media.');
}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
