import crypto from 'node:crypto';
import {v2db,storageMode} from '../repositories/jsonStore.js';

const tokenPattern=/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/;
const collection=async()=>{if(storageMode()!=='mongodb-v2')throw Object.assign(new Error('Push notifications require MongoDB V2'),{status:503});return (await v2db()).collection('order-push-tokens');};
export async function initOrderPush(){if(storageMode()!=='mongodb-v2')return;const col=await collection();await col.createIndex({userId:1,tokenHash:1},{unique:true});await col.createIndex({branchId:1,active:1});}
export async function registerOrderPush(user,body){const token=String(body?.token||'');const branchId=String(body?.branchId||'');if(!tokenPattern.test(token))throw Object.assign(new Error('Invalid Expo push token'),{status:400});if(!branchId||!(user.role==='super_admin'||user.branchIds?.includes(branchId)))throw Object.assign(new Error('Branch access denied'),{status:403});const col=await collection();const tokenHash=crypto.createHash('sha256').update(token).digest('hex');await col.updateOne({userId:user.sub,tokenHash},{$set:{token,branchId,active:true,updatedAt:new Date()}},{upsert:true});return {registered:true};}
export async function unregisterOrderPush(user,body){const branchId=String(body?.branchId||'');const col=await collection();await col.updateMany({userId:user.sub,branchId},{$set:{active:false,updatedAt:new Date()}});return {unregistered:true};}
let pending=0;
export async function sendNewOrderPush(branchId,orderId){if(storageMode()!=='mongodb-v2'||pending>=5)return;pending++;
 try{const col=await collection();const rows=await col.find({branchId,active:true},{projection:{token:1,_id:0}}).limit(200).toArray();
 for(let i=0;i<rows.length;i+=100){const messages=rows.slice(i,i+100).map(({token})=>({to:token,title:'Delta Kebab · New order',body:'A new order is waiting for acceptance',sound:'default',priority:'high',channelId:'orders',data:{orderId,branchId}}));
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),4000);try{const res=await fetch('https://exp.host/--/api/v2/push/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(messages),signal:controller.signal});if(!res.ok)console.error('Expo push status:',res.status);}finally{clearTimeout(timeout)}}
 }catch(err){console.error('Order push dispatch failed:',err.message)}finally{pending--}}
