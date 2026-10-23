'use strict';
const {readJsonBody}=require('./manual-macros-http.cjs');
async function handleDiary(req,res,service,approvedOrigin){
  const route=req.url.split('?',1)[0];
  if(!['/api/diary/day','/api/diary/foods','/api/diary/save','/api/diary/personal-foods'].includes(route))return false;
  const send=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
  try{
    if(!service){send(503,{error:'DIARY_DISABLED'});return true;}
    const origin=approvedOrigin??'http://'+req.headers.host,writing=route.endsWith('/save')||(route.endsWith('/personal-foods')&&req.method==='POST');
    if(req.method!==(writing?'POST':'GET')||req.headers['sec-fetch-site']==='cross-site'||
      (req.headers.origin&&req.headers.origin!==origin)||(writing&&req.headers.origin!==origin))throw new Error();
    const token=/^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(req.headers.authorization??'')?.[1];if(!token)throw new Error();
    const url=new URL(req.url,origin),keys=[...url.searchParams.keys()];let value;
    if(route.endsWith('/save')&&writing){if(keys.length)throw new Error();value=await service.save(token,await readJsonBody(req));}
    else if(route.endsWith('/personal-foods')&&writing){if(keys.length)throw new Error();value=await service.createFood(token,await readJsonBody(req));}
    else if(route.endsWith('/foods')){
      if(req.method!=='GET'||keys.length!==2||['gymId','clientId'].some(k=>url.searchParams.getAll(k).length!==1))throw new Error();
      value=await service.foods(token,{gymId:url.searchParams.get('gymId'),clientId:url.searchParams.get('clientId')});
    }
    else{if(keys.length!==3||['gymId','clientId','date'].some(k=>url.searchParams.getAll(k).length!==1))throw new Error();
      value=await service.read(token,{gymId:url.searchParams.get('gymId'),clientId:url.searchParams.get('clientId')},url.searchParams.get('date'));}
    send(200,{data:value});
  }catch{send(400,{error:'DIARY_REQUEST_REJECTED_OR_RESULT_UNKNOWN'});}
  return true;
}
module.exports={handleDiary};
