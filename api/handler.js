import { handler } from '../server.js';

// Explicit query routing works whether the runtime preserves the original URL
// or exposes the rewritten destination. Only application API paths are served.
export default async function vercelHandler(req,res) {
  try {
    const url=new URL(req.url,'https://journey-watch.invalid');
    const path=url.searchParams.get('__route') || req.query?.__route;
    if (path) {
      url.pathname=`/api/${Array.isArray(path)?path.join('/'):path}`;
      url.searchParams.delete('__route');
      req.url=url.pathname+url.search;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:'Not found'}));
    }
    await handler(req,res);
  } catch {
    console.error('Journey Watch API request failed.');
    if (!res.headersSent) res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:'Internal server error.'}));
  }
}
