import crypto from 'node:crypto';
import {v2db,storageMode} from '../repositories/jsonStore.js';
const path='admin-web-push';
let sender;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const col=async()=>(await v2db()).collection(path);
export async function initAdminPush(){
 if(storageMode()!=='mongodb-v2'||!process.env.WEB_PUSH_PUBLIC_KEY||!process.env.WEB_PUSH_PRIVATE_KEY||!process.env.WEB_PUSH_SUBJECT)return;
 try{const {default:push}=await import('web-push');push.setVapidDetails(process.env.WEB_PUSH_SUBJECT,process.env.WEB_PUSH_PUBLIC_KEY,process.env.WEB_PUSH_PRIVATE_KEY);await (await col()).createIndex({endpointHash:1},{unique:true});await (await col()).createIndex({userId:1});sender=push;}catch(e){console.error('Admin push disabled: initialization failed');}
}
export function adminPushConfig(){return {enabled:!!sender,publicKey:sender?process.env.WEB_PUSH_PUBLIC_KEY:null};}
function endpointHash(endpoint){return crypto.createHash('sha256').update(endpoint).digest('hex');}
export function validateSubscription(body){
 const endpoint=body?.endpoint;let url;try{url=new URL(endpoint);}catch{throw fail(400,'Invalid push endpoint');}
 const host=url.hostname;const allowed=host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host==='web.push.apple.com'||host.endsWith('.push.apple.com')||host.endsWith('.notify.windows.com');
 if(!allowed||url.protocol!=='https:'||url.port||url.username||url.password||url.hash||endpoint.length>2048)throw fail(400,'Unsupported push endpoint');
 const keys=body?.keys;for(const [key,len] of [['p256dh',65],['auth',16]]){if(typeof keys?.[key]!=='string'||!/^[A-Za-z0-9_-]+$/.test(keys[key])||Buffer.from(keys[key],'base64url').length!==len)throw fail(400,'Invalid push keys');}
 return {endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
export async function registerAdminPush(user,body){if(!sender)throw fail(503,'Admin push unavailable');const subscription=validateSubscription(body);const c=await col();await c.updateOne({endpointHash:endpointHash(subscription.endpoint)},{$set:{userId:user.sub,subscription,updatedAt:new Date()}},{upsert:true});return {registered:true};}
export async function unregisterAdminPush(user,body){if(typeof body?.endpoint!=='string'||body.endpoint.length>2048)throw fail(400,'Invalid endpoint');await (await col()).deleteOne({userId:user.sub,endpointHash:endpointHash(body.endpoint)});return {unregistered:true};}
let pending=0;
export async function sendAdminPush(branchId,orderId){if(!sender||pending>=5)return;pending++;try{
 const db=await v2db();const c=await col();const rows=await c.find({}).limit(100).toArray();if(!rows.length)return;
 const users=await db.collection('users').find({id:{$in:[...new Set(rows.map(r=>r.userId))]},active:true,role:'super_admin'},{projection:{id:1}}).toArray();const active=new Set(users.map(u=>u.id));
 const payload=JSON.stringify({title:'Delta Kebab · New order',body:'A new order is waiting for acceptance',orderId,branchId,tag:`order-${orderId}`});
 for(let i=0;i<rows.length;i+=5)await Promise.allSettled(rows.slice(i,i+5).map(async row=>{if(!active.has(row.userId))return;try{await sender.sendNotification(row.subscription,payload,{TTL:300,urgency:'high',timeout:5000});}catch(e){if([404,410].includes(e.statusCode))await c.deleteOne({_id:row._id,updatedAt:row.updatedAt});else console.error('Admin push delivery failed',e.statusCode||'network');}}));
 }catch{console.error('Admin push dispatch failed');}finally{pending--;}}
