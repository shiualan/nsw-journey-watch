import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { handler } from '../server.js';

// Exercise the real HTTP handlers and planner; only the external TfNSW network
// is replaced. No user key, stored timetable download, or live data is needed.
const stops=[{id:'a',name:'Blacktown Station'},{id:'b',name:'Parramatta Station'},{id:'c',name:'Central Station'}];
const upstream=[];
const fixtureYear=new Date().getUTCFullYear()+1;
const serviceDay=`${fixtureYear}-01-20`;
const utcDay=`${fixtureYear}-01-19`;
const nativeFetch=globalThis.fetch;
globalThis.fetch=async url=>{
  assert.equal(url.hostname,'api.transport.nsw.gov.au');
  if (url.pathname.endsWith('/stop_finder')) return Response.json({locations:stops.filter(s=>s.name.toLowerCase().includes(url.searchParams.get('name_sf').toLowerCase())).map(s=>({...s,type:'stop'}))});
  if (!url.pathname.endsWith('/trip')) return new Response(new Uint8Array());
  upstream.push(Object.fromEntries(url.searchParams));
  const train=url.searchParams.get('name_origin')==='b';
  const from=stops.find(s=>s.id===url.searchParams.get('name_origin'));
  const to=stops.find(s=>s.id===url.searchParams.get('name_destination'));
  const raw=(line,dep,arr)=>({legs:[{
    origin:{...from,departureTimePlanned:`${serviceDay}T${dep}:00+11:00`},
    destination:{...to,arrivalTimePlanned:`${serviceDay}T${arr}:00+11:00`},
    transportation:{product:{class:train?1:5},disassembledName:line}
  }]});
  return Response.json({journeys:train ? [raw('T2','09:35','10:00'),raw('T1','09:40','10:10'),raw('T1','10:00','10:30')]
    : [raw('701','09:10','09:20'),raw('700','09:15','09:30')]});
};
const server=http.createServer(handler);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const directory=new URL('../data/qa/',import.meta.url);
await mkdir(directory,{recursive:true});
let browser;
try {
  assert.equal((await nativeFetch(`${base}/api/health`)).status,200);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.locator('#openSettings').click();
  await page.locator('#apiKey').fill('fixture-only');
  await page.locator('#settingsForm button[type=submit]').click();
  await page.locator('#addRouteTop').click();
  await page.locator('#routeLabel').fill('700 then T1');
  async function pick(label,query) {
    const input=page.getByRole('combobox',{name:label,exact:true});
    await input.fill(query);
    await page.locator(`#${await input.getAttribute('aria-controls')} [role=option]`).first().waitFor();
    await input.press('ArrowDown'); await input.press('Enter');
  }
  await pick('ORIGIN','Blacktown');
  await pick('DESTINATION','Central');
  await page.locator('#addInterchange').click();
  await pick('INTERCHANGE 1','Parramatta');
  await page.getByLabel('Transport mode for leg 1',{exact:true}).selectOption('bus');
  await page.getByLabel('Specific line for leg 1',{exact:true}).fill('700');
  await page.getByLabel('Earliest departure for leg 1 in Sydney time',{exact:true}).fill(`${serviceDay}T09:10`);
  await page.getByLabel('Transport mode for leg 2',{exact:true}).selectOption('train');
  await page.getByLabel('Specific line for leg 2',{exact:true}).fill('T1');
  await page.getByLabel('Earliest departure for leg 2 in Sydney time',{exact:true}).fill(`${serviceDay}T09:35`);
  await page.screenshot({path:new URL('builder-desktop.png',directory).pathname});
  async function save() {
    const response=page.waitForResponse(r=>r.url().endsWith('/api/compare'));
    await page.locator('#routeForm button[type=submit]').click();
    const payload=await (await response).json();
    assert.ok(payload.results.every(r=>r.ok),JSON.stringify(payload));
    await page.locator('.card-metric').first().waitFor();
    return payload;
  }
  let payload=await save();
  assert.deepEqual(payload.results[0].data.stages.map(s=>s.legs[0].line),['700','T1']);
  assert.equal(upstream[0].itdTime,'0910');
  assert.equal(upstream[1].itdTime,'0935');
  assert.equal(payload.results[0].data.arrival,`${utcDay}T23:10:00.000Z`);
  await page.getByRole('button',{name:'Clone 700 then T1',exact:true}).click();
  await page.locator('[data-close=routeDialog]').first().click();
  assert.equal(await page.locator('.route-card').count(),1);
  await page.getByRole('button',{name:'Lock this journey',exact:true}).click();
  await page.getByRole('button',{name:'Unlock & re-plan',exact:true}).waitFor();
  await page.getByRole('button',{name:'Clone 700 then T1',exact:true}).click();
  await page.locator('#routeLabel').fill('Later train');
  await page.getByLabel('Earliest departure for leg 2 in Sydney time',{exact:true}).fill(`${serviceDay}T09:50`);
  payload=await save();
  assert.equal(payload.results[0].data.arrival,`${utcDay}T23:30:00.000Z`);
  assert.equal(await page.locator('.route-card').count(),2);
  let stored=await page.evaluate(()=>({routes:JSON.parse(localStorage.getItem('journey-watch:routes:v1')),tracks:JSON.parse(localStorage.getItem('journey-watch:fixed:v2'))}));
  assert.equal(stored.tracks.length,1);
  assert.equal(stored.tracks[0].id,stored.routes[0].id);
  assert.notEqual(stored.routes[0].id,stored.routes[1].id);
  await page.getByRole('button',{name:'Edit 700 then T1',exact:true}).click();
  await page.getByLabel('Earliest departure for leg 2 in Sydney time',{exact:true}).fill(`${serviceDay}T09:50`);
  await save();
  stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('journey-watch:fixed:v2')));
  assert.equal(stored.length,0);
  await page.reload();
  await page.getByRole('button',{name:'Edit Later train',exact:true}).click();
  assert.equal(await page.getByLabel('Specific line for leg 1',{exact:true}).inputValue(),'700');
  assert.equal(await page.getByLabel('Earliest departure for leg 2 in Sydney time',{exact:true}).inputValue(),`${serviceDay}T09:50`);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const dialog=page.locator('#routeDialog');
  assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.screenshot({path:new URL('builder-mobile.png',directory).pathname});
  await page.locator('[data-close=routeDialog]').first().click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: real API planning for 700 → T1, later-service editing, clone/cancel isolation, locked source preservation, unlock on edit, reload persistence, Sydney times from a New York browser, desktop/mobile layout, and no browser errors.');
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
  globalThis.fetch=nativeFetch;
}
