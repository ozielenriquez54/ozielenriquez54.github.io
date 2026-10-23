'use strict';
const {readFileSync}=require('node:fs');
const {X509Certificate}=require('node:crypto');
const {checkServerIdentity}=require('node:tls');

const LOGIN='pilot_clinical_gateway';
function failure(code){return Object.assign(new Error(code),{code});}
function required(env,name){
  const value=env[name];
  if(typeof value!=='string'||!value.trim())throw failure('INVALID_'+name);
  return value;
}
function integer(env,name,fallback,min,max){
  const raw=env[name]??String(fallback);
  if(!/^\d+$/.test(raw)||Number(raw)<min||Number(raw)>max)throw failure('INVALID_'+name);
  return Number(raw);
}

// Shared with the read-only connectivity probe; it needs no Auth key or JWT.
function loadPostgresConfig(env=process.env,readCA=readFileSync,login=LOGIN){
  if(![LOGIN,'pilot_diary_server'].includes(login))throw failure('INVALID_DATABASE_LOGIN');
  if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw failure('INSECURE_TLS_ENVIRONMENT');
  const ref=required(env,'PILOT_SUPABASE_PROJECT_REF');
  if(!/^[a-z0-9]{20}$/.test(ref))throw failure('INVALID_PILOT_SUPABASE_PROJECT_REF');
  const host=required(env,'PILOT_PG_HOST');
  const mode=required(env,'PILOT_PG_MODE');
  const direct=mode==='direct'&&host===`db.${ref}.supabase.co`;
  const session=mode==='session'&&/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  if(!direct&&!session)throw failure('INVALID_PILOT_PG_ENDPOINT');
  const user=required(env,'PILOT_PG_USER');
  if(user!==(direct?login:`${login}.${ref}`))throw failure('INVALID_PILOT_PG_USER');
  const password=required(env,'PILOT_PG_PASSWORD');
  let ca;
  try{
    ca=readCA(required(env,'PILOT_PG_CA_FILE'),'utf8');
    const certs=ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if(!certs?.length||ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,'').trim())throw new Error();
    for(const pem of certs)if(!new X509Certificate(pem).ca)throw new Error();
  }catch{throw failure('INVALID_PILOT_PG_CA');}
  return {
    host,port:5432,database:'postgres',user,password,sslnegotiation:'postgres',
    ssl:{ca,rejectUnauthorized:true,minVersion:'TLSv1.2',servername:host,
      checkServerIdentity:(_hostname,cert)=>checkServerIdentity(host,cert)},
    max:integer(env,'PILOT_PG_POOL_MAX',4,1,10),min:0,
    connectionTimeoutMillis:integer(env,'PILOT_PG_CONNECT_TIMEOUT_MS',5000,100,30000),
    idleTimeoutMillis:30000,maxLifetimeSeconds:300,
    statement_timeout:15000,lock_timeout:3000,
    idle_in_transaction_session_timeout:10000,query_timeout:20000,
    application_name:'twogramms-clinical-gateway',options:'-c search_path=pg_catalog',
    client_encoding:'UTF8',keepAlive:true,keepAliveInitialDelayMillis:10000
  };
}

module.exports={loadPostgresConfig};
