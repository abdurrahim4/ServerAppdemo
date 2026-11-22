import {awardLoyaltyForDeliveredOrder} from '../customerAccounts.js';
import crypto from 'node:crypto';
import {sendNewOrderPush} from './orderPush.js';
import {list,mutate,storageMode,findRecord,insertRecord,updateOrderRecord,v2db,startV2Session} from '../repositories/jsonStore.js';
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
const extraSizeSurcharge=(groups,selections,size)=>{const group=groups.find(g=>/^(size|rozmiar|wielkość|rozmiary)$/i.test(String(g.id))||/size|rozmiar|wielkość/i.test(String(g.name)));const chosen=group?.options?.find(o=>(selections?.[group.id]||[]).includes(o.id));const name=String(chosen?.name||chosen?.id||'').toLowerCase();return /mega|large|duż|duz|big/.test(name)?2:/medium|śred|sred|mid/.test(name)?1:size==='large'||size==='mega'?2:size==='medium'?1:0};
// Public-facing order numbers; internal UUID IDs remain unchanged.
const displayOrderNumber = sequence => `DKB-${String(sequence).padStart(2,'0')}`;
async function allocateMongoOrderNumber(db, session) {
 const result=await db.collection('order-counters').findOneAndUpdate(
  {_id:'global-orders'}, {$inc:{sequence:1}}, {upsert:true,returnDocument:'after',...(session?{session}:{})});
 return displayOrderNumber(result.sequence);
}
export class OrderError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export async function priceOrder(body) {
 const branches=await list('branches');
 if(!branches.some(b=>b.id===body.branchId&&b.available)) throw new OrderError('Branch unavailable');
 const products=storageMode()==='mongodb-v2'?[]:await list('products'), groups=storageMode()==='mongodb-v2'?[]:await list('customization-groups');
 const db=storageMode()==='mongodb-v2'?await v2db():null;
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>40) throw new OrderError('Invalid cart');
 const categories=await list('categories');
 const items=[];for(const item of body.items){
  let product=products.find(p=>p.id===item.productId&&p.branchId===body.branchId&&!p.archived&&p.available);
  let groupList=groups;
  if(db){const assignment=await db.collection('branchProducts').findOne({branchId:body.branchId,productId:item.productId,available:true});
    if(assignment){const master=await db.collection('productCatalog').findOne({id:item.productId,active:{$ne:false}});if(master){const size=item.size||'small';if(!['small','medium','large'].includes(size))throw new OrderError('Invalid size');product={...master,price:assignment.prices[size]/100,selectedSize:size};groupList=await db.collection('sharedOptionGroups').find({id:{$in:master.customizationGroupIds||[]}}).toArray();}}
    if(!product){product=await db.collection('products').findOne({id:item.productId,branchId:body.branchId,available:true,archived:{$ne:true}});groupList=await db.collection('customization-groups').find({id:{$in:product?.customizationGroupIds||[]}}).toArray();}
  }
  if(!product) throw new OrderError('Product unavailable for selected branch');
  if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>30) throw new OrderError('Invalid quantity');
  const selections=item.selections||{};
  if(Object.keys(selections).some(id=>!product.customizationGroupIds.includes(id))) throw new OrderError('Unknown customization group');
  let extras=0,extrasVat=0;const chosen=[];
  for(const id of product.customizationGroupIds){
   const group=groupList.find(g=>g.id===id);if(!group) throw new OrderError('Invalid product configuration',500);
   const ids=selections[id]||[];
   if(!Array.isArray(ids)||ids.length<group.min||ids.length>group.max||new Set(ids).size!==ids.length) throw new OrderError(`Invalid ${group.name} selections`);
   for(const optionId of ids){const option=group.options.find(o=>o.id===optionId&&o.available);if(!option) throw new OrderError('Unavailable customization');const optionPrice=money(Number(option.price)+(String(group.id).toLowerCase()==='extras'?extraSizeSurcharge(groupList,selections,product.selectedSize):0));extras+=optionPrice;const optionVat=money(optionPrice*(Number(group.vatRate)||0)/100);extrasVat+=optionVat;chosen.push({groupId:id,groupName:group.name,optionId,name:option.name,price:optionPrice,vatRate:Number(group.vatRate)||0,vatAmount:optionVat});}
  }
  const category=categories.find(c=>c.id===product.categoryId);
  const categoryVatRate=Number(category?.vatRate)||0;
  const unitSubtotal=money(product.price+extras);
  const unitVat=money(product.price*categoryVatRate/100+extrasVat);
  const unitPrice=money(unitSubtotal+unitVat);
  items.push({productId:product.id,name:structuredClone(product.name),categoryId:product.categoryId,categoryVatRate,quantity:item.quantity,basePrice:product.price,size:product.selectedSize||null,selections:chosen,unitSubtotal,unitVat,unitPrice,lineSubtotal:money(unitSubtotal*item.quantity),lineVat:money(unitVat*item.quantity),lineTotal:money(unitPrice*item.quantity),instructions:String(item.instructions||'').slice(0,500)});
 }
 return {items,subtotal:money(items.reduce((s,x)=>s+x.lineSubtotal,0)),vatTotal:money(items.reduce((s,x)=>s+x.lineVat,0)),total:money(items.reduce((s,x)=>s+x.lineTotal,0))};
}
export async function createOrder(body,io){
 const {items,subtotal,vatTotal,total}=await priceOrder(body);
 const now=new Date().toISOString();
 const deliveryFee=body.orderType==='pickup'?0:Number(body.delivery?.deliveryFee||0);
 const finalTotal=money(total+deliveryFee);
 const order={id:`DKB-${crypto.randomUUID()}`,orderType:body.orderType==='pickup'?'pickup':'delivery',branchId:body.branchId,customer:{name:body.customer.name.trim(),phone:body.customer.phone.trim(),address:String(body.customer.address||'').trim(),...(body.customer.email?{email:body.customer.email}:{}),...(body.customer.username?{username:body.customer.username}:{}),...(body.customer.mailingAddress?{mailingAddress:body.customer.mailingAddress}:{})},...(body.deliveryInstructions?{deliveryInstructions:body.deliveryInstructions}:{}),items,subtotal,vatTotal,deliveryFee,deliveryDistanceKm:body.orderType==='pickup'?null:(body.delivery?.distanceKm||null),deliveryPromotion:body.delivery?.promotion||null,total:finalTotal,currency:'PLN',customerId:body.customerId||null,paymentMethod:body.paymentMethod,status:'new',createdAt:now,updatedAt:now,history:[{status:'new',at:now}],cancellationReason:null};
 const record=storageMode()==='mongodb-v2' ? await (async()=>{
  // Reward and order are committed atomically. A failed order cannot consume a reward.
  if(body.redeemReward && body.customerId){
   const db=await v2db();const session=await startV2Session();
   if(!session?.withTransaction)throw new OrderError('Reward checkout temporarily unavailable',503);
   try{
    let created;
    await session.withTransaction(async()=>{
     order.idempotencyKey=body.idempotencyKey||null;
     if(order.idempotencyKey){const existing=await db.collection('orders').findOne({branchId:body.branchId,idempotencyKey:order.idempotencyKey},{session});if(existing){created={order:existing,created:false};return}}
     const rewards=db.collection('customer-rewards');
     const requested=Number.isInteger(body.redeemRewardCount)?body.redeemRewardCount:1;
     if(requested<1||requested>100)throw new OrderError('Invalid reward count',400);
     const available=await rewards.find({customerId:body.customerId,status:'available',amount:{$gt:0}},{session,projection:{_id:0,id:1,amount:1}}).sort({createdAt:1}).limit(100).toArray();
     const chosen=[];let discountCents=0;const maxCents=Math.round(total*100);
     for(const reward of available){
       if(chosen.length>=requested)break;
       const cents=Math.round(Number(reward.amount)*100);
       if(cents<=0||discountCents+cents>maxCents)continue;
       chosen.push(reward);discountCents+=cents;
     }
     if(!chosen.length)throw new OrderError('No applicable rewards available for this order',409);
     const ids=chosen.map(r=>r.id);
     const update=await rewards.updateMany({customerId:body.customerId,status:'available',id:{$in:ids}},{$set:{status:'redeemed',redeemedAt:now,redeemedOrderId:order.id}},{session});
     if(update.modifiedCount!==ids.length)throw new OrderError('Reward balance changed; please retry',409);
     order.rewardDiscount=money(discountCents/100);order.redeemedRewardIds=ids;
     order.total=money(finalTotal-order.rewardDiscount);
     order.orderNumber=await allocateMongoOrderNumber(db,session);
     await db.collection('orders').insertOne(order,{session});created={order,created:true};
    });return created;
   }catch(e){if(e.code===11000&&body.idempotencyKey){const existing=await findRecord('orders',{branchId:body.branchId,idempotencyKey:body.idempotencyKey});if(existing)return {order:existing,created:false}}throw e}
   finally{await session.endSession()}
  }

  order.idempotencyKey=body.idempotencyKey||null;
  if(order.idempotencyKey){const existing=await findRecord('orders',{branchId:body.branchId,idempotencyKey:order.idempotencyKey});if(existing)return {order:existing,created:false};}
  try {order.orderNumber=await allocateMongoOrderNumber(await v2db());await insertRecord('orders',order);return {order,created:true};}
  catch(err){if(err.code===11000&&order.idempotencyKey){const existing=await findRecord('orders',{branchId:body.branchId,idempotencyKey:order.idempotencyKey});if(existing)return {order:existing,created:false};}throw err;}
 })() : await mutate('orders',rows=>{
  if(body.idempotencyKey){const existing=rows.find(x=>x.idempotencyKey===body.idempotencyKey&&x.branchId===body.branchId);if(existing)return {order:existing,created:false};}
  // Legacy JSON/collection mode: mutate serializes order creation.
  const highest=rows.reduce((max,row)=>Math.max(max,Number(/^DKB-(\d+)$/.exec(row.orderNumber||'')?.[1]||0)),0);
  order.orderNumber=displayOrderNumber(highest+1);
  order.idempotencyKey=body.idempotencyKey||null;rows.push(order);return {order,created:true};
 });
 if(record.created){
  io.to(`branch:${body.branchId}`).emit('order:new',{eventId:crypto.randomUUID(),order:record.order});
  // Best-effort notification: never block checkout or alter order status.
  void sendNewOrderPush(body.branchId,record.order.id).catch(err=>{
    console.error('New-order push dispatch failed:',err.message);
  });
 }
 return record;
}
const transitions={new:['preparing','cancelled'],preparing:['delivering','cancelled'],delivering:['delivered'],delivered:[],cancelled:[]};
export async function changeStatus(branchId,id,status,reason,io){
 const updated=storageMode()==='mongodb-v2' ? await (async()=>{
  const current=await findRecord('orders',{id,branchId});if(!current)throw new OrderError('Order not found',404);
  if(!transitions[current.status]?.includes(status))throw new OrderError('Invalid status transition',409);
  if(status==='cancelled'&&!String(reason||'').trim())throw new OrderError('Cancellation reason required');
  const at=new Date().toISOString();const result=await updateOrderRecord(branchId,id,current.status,{status,updatedAt:at,cancellationReason:status==='cancelled'?reason:current.cancellationReason,historyEntry:{status,at}});
  if(!result)throw new OrderError('Order status changed concurrently; retry',409);return result;
 })() : await mutate('orders',rows=>{
  const order=rows.find(o=>o.id===id&&o.branchId===branchId);
  if(!order)throw new OrderError('Order not found',404);
  if(!transitions[order.status].includes(status))throw new OrderError('Invalid status transition',409);
  if(status==='cancelled'&&!String(reason||'').trim())throw new OrderError('Cancellation reason required');
  order.status=status;order.updatedAt=new Date().toISOString();order.history.push({status,at:order.updatedAt});if(status==='cancelled')order.cancellationReason=reason;return structuredClone(order);
 });
 if(status==='cancelled'&&storageMode()==='mongodb-v2'){
  const ids=updated.redeemedRewardIds|| (updated.redeemedRewardId?[updated.redeemedRewardId]:[]);
  if(ids.length){const db=await v2db();await db.collection('customer-rewards').updateMany({id:{$in:ids},customerId:updated.customerId,status:'redeemed',redeemedOrderId:updated.id},{$set:{status:'available'},$unset:{redeemedAt:'',redeemedOrderId:''}});}
 }
 if(status==='delivered'&&updated.customerId)await awardLoyaltyForDeliveredOrder(updated).catch(e=>console.error('Loyalty award pending retry for order',updated.id,e.message));
 io.to(`branch:${branchId}`).emit('order:updated',{eventId:crypto.randomUUID(),order:updated});return updated;
}
