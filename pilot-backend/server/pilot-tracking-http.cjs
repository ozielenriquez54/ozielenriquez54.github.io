'use strict';
const {readJsonBody}=require('./manual-macros-http.cjs');
// Explicitly injected local handler; not imported by any production launcher.
async function handleTracking(req,res,service,origin){
  const path=req.url.split('?',1)[0];
  if(!['/api/tracking/history','/api/tracking/save','/api/tracking/food'].includes(path))return false;
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  try{
    if(!service){send(503,{error:'TRACKING_DISABLED'});return true;}
    const writing=path!=='/api/tracking/history';
    if(!origin||req.headers.host!==new URL(origin).host||req.method!==(writing?'POST':'GET')||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==origin)||(writing&&req.headers.origin!==origin))throw Error();
    const token=/^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(req.headers.authorization??'')?.[1];if(!token)throw Error();
    const url=new URL(req.url,origin);let data;
    if(writing){if(url.search)throw Error();const c=await readJsonBody(req);data=await (path.endsWith('/food')?service.saveFood(token,c):service.save(token,c));}
    else{
      const keys=['gymId','clientId','from','to'];
      if([...url.searchParams].length!==4||keys.some(k=>url.searchParams.getAll(k).length!==1))throw Error();
      data=await service.history(token,{gymId:url.searchParams.get('gymId'),clientId:url.searchParams.get('clientId')},url.searchParams.get('from'),url.searchParams.get('to'));
    }
    send(200,{data});
  }catch{send(400,{error:'TRACKING_REQUEST_REJECTED_OR_RESULT_UNKNOWN'});}
  return true;
}
module.exports={handleTracking};
