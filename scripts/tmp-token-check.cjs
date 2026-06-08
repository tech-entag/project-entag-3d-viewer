const fs = require('fs');
const https = require('https');

const base = 'https://project-entag-3d-viewer-kf4snaq9i-citizendevio.vercel.app';
const raw = fs.readFileSync('creds.txt','utf8').trim();
const [client_id, client_secret] = raw.split(':');

function req(method, url, body){
  return new Promise((resolve,reject)=>{
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const r = https.request({
      method,
      hostname:u.hostname,
      path:u.pathname + u.search,
      port:443,
      rejectUnauthorized:false,
      headers: data ? { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    },res=>{
      let b='';
      res.on('data',d=>b+=d);
      res.on('end',()=>{
        let j=null;
        try{j=JSON.parse(b);}catch{}
        resolve({status:res.statusCode, body:b, json:j, headers:res.headers});
      });
    });
    r.on('error',reject);
    if(data) r.write(data);
    r.end();
  });
}

(async()=>{
  const modelUrl = `${base}/test-fixtures/cutting-blade-1-k110-1.STEP`;
  const up = await req('POST', `${base}/api/autodesk`, {
    url:modelUrl,
    part_id:`diag-${Date.now()}`,
    version:'token-check',
    client_id,
    client_secret,
    auto_modelid:true
  });
  console.log('autodesk status', up.status);
  if(!up.json?.urn || !up.json?.accessToken){
    console.log('autodesk body', up.body.slice(0,500));
    process.exit(1);
  }
  console.log('autodesk autoFollowup', JSON.stringify(up.json.autoFollowup||null));

  const qs = new URLSearchParams({ urn: up.json.urn, access_token: up.json.accessToken, lookupAttempts:'20', lookupIntervalMs:'2000' });
  const vs = await req('GET', `${base}/api/viewer-source?${qs.toString()}`);
  console.log('viewer-source status', vs.status);
  console.log('viewer-source body', vs.body.slice(0,700));
})();
