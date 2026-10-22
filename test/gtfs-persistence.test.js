import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Dynamic import after selecting an isolated test cache directory.
const tempDir = await mkdtemp(join(tmpdir(),'journey-watch-gtfs-'));
process.env.GTFS_DATA_DIR = tempDir;
const {syncStaticFeeds,staticStatus,readIndex}=await import('../src/gtfs-static.js');
const fixture=fileURLToPath(new URL('./fixtures/mini-bus.zip',import.meta.url));

test('timetable sync downloads a ZIP, indexes it and persists locally without the API key',async()=>{
  const zip=await readFile(fixture);
  const feeds=await syncStaticFeeds(['buses'],'TEST_TOKEN_NOT_TO_PERSIST',{
    fetchImpl:async (url,options)=>{
      assert.match(url,/\/v1\/gtfs\/schedule\/buses$/);
      assert.equal(options.headers.Authorization,'apikey TEST_TOKEN_NOT_TO_PERSIST');
      return new Response(zip,{status:200,headers:{'Content-Type':'application/zip'}});
    }
  });
  assert.deepEqual(feeds.started,['buses']);
  let status;
  for(let i=0;i<80;i++){
    status=await staticStatus();
    if(!status.running)break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(status.running,false);
  assert.equal(status.feeds.buses.job.status,'ready',JSON.stringify(status.feeds.buses.job));
  assert.equal(status.feeds.buses.meta.trips,3);
  const index=await readIndex('buses');
  assert.equal(index.trips['B700-100'][4].length,3);
  const meta=await readFile(join(tempDir,'buses.meta.json'),'utf8');
  const compressed=await readFile(join(tempDir,'buses.json.gz'));
  assert.doesNotMatch(meta,/TEST_TOKEN_NOT_TO_PERSIST/);
  assert.equal(compressed.includes(Buffer.from('TEST_TOKEN_NOT_TO_PERSIST')),false);
  await rm(tempDir,{recursive:true,force:true});
});
