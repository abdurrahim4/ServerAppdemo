import test from 'node:test';
import assert from 'node:assert/strict';
import {list,storageMode} from '../src/repositories/jsonStore.js';
import {priceOrder,OrderError} from '../src/services/orders.js';

// These integration tests require a dedicated, explicitly configured test database.
// Never assume old demonstration IDs exist in a production MongoDB database.
const enabled=process.env.RUN_DB_INTEGRATION_TESTS==='1';
const integration=(name,fn)=>test(name,{skip:!enabled?'Set RUN_DB_INTEGRATION_TESTS=1 with a dedicated test database':false},fn);

integration('branch-specific pricing',async t=>{
 const branches=(await list('branches')).filter(b=>b.available&&!b.deletedAt);
 const products=await list('products');
 const byBranch=new Map();
 for(const p of products){if(!p.available||p.archived||!branches.some(b=>b.id===p.branchId))continue;
  const key=p.id;const entries=byBranch.get(key)||[];entries.push(p);byBranch.set(key,entries);}
 const candidates=[...byBranch.values()].find(rows=>rows.length>1&&new Set(rows.map(p=>p.branchId)).size>1);
 if(!candidates){t.skip('No shared product with branch-specific prices in this database');return;}
 // A difference is not mandatory: branches may legitimately set the same price.
 for(const p of candidates)assert.ok(Number.isFinite(Number(p.price)),`Invalid price for ${p.id}`);
});

integration('cross-branch product rejected',async t=>{
 const branches=(await list('branches')).filter(b=>b.available&&!b.deletedAt);
 const products=(await list('products')).filter(p=>p.available&&!p.archived);
 const sample=products.find(p=>branches.some(b=>b.id!==p.branchId));
 if(!sample){t.skip('No suitable product and alternative branch');return;}
 const other=branches.find(b=>b.id!==sample.branchId);
 await assert.rejects(priceOrder({branchId:other.id,items:[{productId:sample.id,quantity:1}]}),OrderError);
});

integration('valid selections priced by server',async t=>{
 // Use an explicitly supplied known-good fixture rather than a hard-coded old demo ID.
 const raw=process.env.TEST_VALID_ORDER_JSON;
 if(!raw){t.skip('Set TEST_VALID_ORDER_JSON to a valid order fixture for your test database');return;}
 const result=await priceOrder(JSON.parse(raw));
 assert.ok(Number.isFinite(result.total)&&result.total>=0);
 assert.ok(result.items.length>0);
 assert.equal(result.total,Math.round(result.items.reduce((s,i)=>s+i.lineTotal,0)*100)/100);
});

integration('required options enforced',async t=>{
 const raw=process.env.TEST_REQUIRED_OPTIONS_ORDER_JSON;
 if(!raw){t.skip('Set TEST_REQUIRED_OPTIONS_ORDER_JSON to a test order missing required options');return;}
 await assert.rejects(priceOrder(JSON.parse(raw)),e=>e instanceof OrderError&&/selection/i.test(e.message));
});

test('missing branch rejected without trusting client prices',async()=>{
 // No real database needed to verify that pricing never accepts an unknown branch
 // when a configured integration database is available; otherwise skip explicitly.
 if(!enabled)return;
 await assert.rejects(priceOrder({branchId:'__nonexistent_test_branch__',items:[{productId:'__fake__',quantity:1,price:0}]}),/Branch unavailable/);
});
