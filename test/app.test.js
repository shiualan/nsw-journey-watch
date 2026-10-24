import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace('void initialise();', '');

// Small DOM adapter for client state and interaction tests; visual layout still
// requires a real browser. No HTTP listener or external subscription is needed.
class Element {
  constructor() { this.children=[]; this.attributes={}; this.events={}; this.value=''; this.hidden=false; this.isConnected=true; this.textContent=''; this.classList={toggle(){}}; this.style={}; }
  append(...elements) { this.children.push(...elements); }
  appendChild(element) { this.append(element); }
  replaceChildren(...elements) { this.children=elements; }
  setAttribute(name,value) { this.attributes[name]=value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name,callback) { this.events[name]=callback; }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}
function app({fetchImpl=async()=>Response.json({}), storageUnavailable=false}={}) {
  const elements=new Map(), timers=[], storage=new Map();
  const element=id=>{ if(!elements.has(id)) elements.set(id,new Element()); return elements.get(id); };
  const context=vm.createContext({
    console, Intl, Date, Map, Set, Response, Event,
    fetch:fetchImpl,
    localStorage:{getItem(){if(storageUnavailable)throw new Error('Storage blocked');return storage.get(arguments[0]) || null;},setItem(name,value){storage.set(name,value);}},
    document:{getElementById:element,createElement:()=>new Element(),querySelector:()=>new Element(),querySelectorAll:()=>[],visibilityState:'visible'},
    setTimeout:callback=>timers.push(callback),clearTimeout(){},setInterval(){}
  });
  vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  return {run,element,timers,context,storage};
}

test('client works without browser storage and requires a tab key', async () => {
  const calls=[];
  const a=app({storageUnavailable:true,fetchImpl:async(path,opts)=>{calls.push({path,opts});return Response.json({stops:[]});}});
  await assert.rejects(a.run("fetchApi('/api/stops?q=Central')"),/Connect/);
  a.run("key='test-tab-key'");
  await a.run("fetchApi('/api/stops?q=Central')");
  assert.equal(calls[0].opts.headers['X-TfNSW-Key'],'test-tab-key');
  a.run("key='temporary-tab-key'");
  await a.run("fetchApi('/api/stops?q=Central')");
  assert.equal(calls[1].opts.headers['X-TfNSW-Key'],'temporary-tab-key');
  a.run('disconnected=true');
  await assert.rejects(a.run("fetchApi('/api/stops?q=Central')"),/Connect/);
});

test('failed refresh removes an old itinerary from the comparison', async () => {
  const a=app({fetchImpl:async()=>{throw new Error('Network unavailable');}});
  a.run("render=()=>{}; updateClock=()=>{}; key='test-tab-key'; routes=[{id:'one',label:'Train'}]; routeResults.set('one',{ok:true,data:{arrival:new Date(Date.now()+60000).toISOString()}})");
  await a.run('refreshRoutes()');
  assert.equal(a.run("routeResults.get('one').ok"),false);
  assert.match(a.run("routeResults.get('one').error"),/Network unavailable/);
  assert.equal(a.run('refreshInProgress'),false);
  assert.equal(a.run('lastSuccessfulAt'),'');
  a.run('setConnectionUI()');
  assert.equal(a.element('monitorState').textContent,'UPDATE ISSUES');
  assert.equal(a.element('dataStatus').textContent,'Some updates unavailable');
});

test('disconnecting while a request is pending prevents old results from restoring live state', async () => {
  let complete;
  const a=app({fetchImpl:()=>new Promise(resolve=>{complete=resolve;})});
  a.run("render=()=>{}; updateClock=()=>{}; key='test-tab-key'; routes=[{id:'one',label:'Train'}]");
  const pending=a.run('refreshRoutes()');
  a.run('refreshVersion++; disconnected=true; routeResults=new Map()');
  complete(Response.json({results:[{ok:true,data:{id:'one',arrival:new Date(Date.now()+60000).toISOString()}}]}));
  await pending;
  assert.equal(a.run('routeResults.size'),0);
  assert.equal(a.run('refreshInProgress'),false);
  assert.equal(a.run('lastSuccessfulAt'),'');
});

test('a locked journey with failed tracking is retained but excluded from recommendations', () => {
  const a=app();
  a.run("tracks.set('one',{baseline:{arrival:new Date(Date.now()+60000).toISOString()},legs:[]}); trackedResults.set('one',{ok:false,error:'Tracking unavailable'})");
  assert.equal(a.run("visibleResult({id:'one'}).data.fixed.comparable"),false);
  assert.equal(a.run("visibleResult({id:'one'}).data.fixed.errors[0].message"),'Tracking unavailable');
});

test('past arrival times cannot win the dashboard recommendation', () => {
  const a=app();
  a.run("routes=[{id:'one'}];routeResults.set('one',{ok:true,data:{arrival:new Date(Date.now()-60000).toISOString()}});renderOverview([{}])");
  assert.equal(a.element('bestArrival').textContent,'--:--');
});

test('stop picker supports arrow keys, Enter selection, and Escape without closing the editor', async () => {
  const choice={id:'10101100',name:'Central Station'};
  const a=app({fetchImpl:async()=>Response.json({stops:[choice]})});
  a.run("key='test-tab-key'");
  let selected=null;
  const picker=a.run('stopPicker')('ORIGIN',()=>selected,value=>{selected=value;},false);
  const input=picker.children[1], drop=picker.children[3];
  input.value='Central'; input.events.input();
  await a.timers.at(-1)();
  assert.equal(input.attributes['aria-expanded'],'true');
  let prevented=0, stopped=0;
  const key=value=>({key:value,preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  input.events.keydown(key('ArrowDown'));
  assert.equal(input.attributes['aria-activedescendant'],drop.children[0].id);
  input.events.keydown(key('Enter'));
  assert.equal(selected.id,choice.id);
  assert.equal(input.value,choice.name);
  assert.equal(drop.hidden,true);
  assert.equal(prevented,2);
  input.value='Parramatta'; input.events.input();
  input.events.keydown(key('Escape'));
  assert.equal(drop.hidden,true);
  assert.equal(stopped,1);
  await a.timers.at(-1)();
  assert.equal(drop.hidden,true, 'a pending lookup must not reopen after Escape');
});


test('client saves portable paths with locked journeys and clears them when rebinding',()=>{
  const a=app();
  a.run(`key='private-test-key';render=()=>{};refreshRoutes=()=>{};
    tracks.set('one',{id:'one',legs:[{id:'leg',tripId:'',feedId:''}]});
    acceptTrackedResults({results:[{ok:true,data:{id:'one',fixed:{legs:[{id:'leg',tripId:'trip',feedId:'buses',startDate:'20261024',
      binding:{source:'static-auto'},staticPath:{tripId:'trip',feedId:'buses',importedAt:'2026-10-24T00:00:00Z',stops:[{name:'Station'}]}}]}}}]});`);
  const saved=JSON.parse(a.storage.get('journey-watch:fixed:v2'));
  assert.equal(saved[0].legs[0].staticPath.stops[0].name,'Station');
  assert.ok(!a.storage.get('journey-watch:fixed:v2').includes('private-test-key'));
  a.run("bindTripId('one','leg','different-trip','buses','20261024')");
  assert.equal(a.run("tracks.get('one').legs[0].staticPath"),undefined);
});
