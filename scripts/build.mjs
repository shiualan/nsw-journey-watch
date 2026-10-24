import { access, readFile } from 'node:fs/promises';
// Static assets are already deployable. Verify required entry points without
// copying local credentials, cached timetables, or browser test artifacts.
for (const path of ['public/index.html','public/app.js','public/styles.css','api/handler.js']) await access(new URL(`../${path}`,import.meta.url));
const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
if(config.outputDirectory!=='public')throw new Error('Only public assets may be published.');
console.log('Static assets and Vercel API entry point are ready. No API key is needed at build time.');
