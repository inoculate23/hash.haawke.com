import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import worker, { SequenceCounter } from '../src/index.js';

const credential = 'test-only-service-token-'.repeat(3);
function environment() {
  const records = new Map(), storage = new Map();
  const { privateKey } = generateKeyPairSync('ed25519');
  const env = {
    HAAWKE_ARTIFACT_SERVICE_TOKEN: credential,
    HAAWKE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    PROVENANCE: { get: async key => records.get(key) ?? null, put: async (key, value) => records.set(key, value) },
  };
  const sequencer = new SequenceCounter({ storage: { get: async key => storage.get(key), put: async (key, value) => storage.set(key, value) } }, env);
  env.SEQUENCER = { idFromName: () => 'test', get: () => ({ fetch: (url, init) => sequencer.fetch(new Request(url, init)) }) };
  return { env, records, storage };
}
function request(operation, body, authorized = true) {
  return new Request(`https://haawke-verify.haawkeai.workers.dev/v1/artifacts/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body),
  });
}
test('shared route hashes exact UTF-8 using the real existing worker helper', async () => {
  const { env, records } = environment();
  const content = '  e\u0301\r\nHaawke 🌊  ';
  const response = await worker.fetch(request('hash', { content, content_type: 'text/plain' }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sha256: createHash('sha256').update(content, 'utf8').digest('hex'), canonicalization: 'haawke-utf8-exact-v1' });
  assert.equal(records.size, 0);
});
test('sealing reuses real registration and sequencer; repeated seals preserve the first record', async () => {
  const { env, records, storage } = environment();
  const content = 'private-test-artifact\r\n';
  const digest = createHash('sha256').update(content).digest('hex');
  const input = { content, content_type: 'text/plain', title: 'private@example.test', metadata: { source: 'chatgpt' }, request_id: crypto.randomUUID() };
  const first = await (await worker.fetch(request('seal', input), env, {})).json();
  assert.equal(first.sha256, digest); assert.equal(first.status, 'REGISTERED');
  assert.equal(first.verification_url, `https://haawke-verify.haawkeai.workers.dev/verify/${digest}`);
  const original = records.get(`record:${digest}`);
  assert.ok(original);
  const record = JSON.parse(original);
  assert.equal(record.content.output_hash, digest);
  assert.equal(record.identity.author, 'Haawke artifact service');
  assert.equal(record.anthropic.model, null);
  assert.ok(record.verification.signature);
  for (const value of [content, 'private@example.test', credential, input.request_id]) assert.ok(!original.includes(value));
  const second = await (await worker.fetch(request('seal', { ...input, request_id: crypto.randomUUID() }), env, {})).json();
  assert.equal(second.status, 'EXISTS');
  assert.equal(records.get(`record:${digest}`), original);
  assert.equal(storage.get('seq'), 1);
  // Test keys differ from the published Haawke key: the real Verify handler
  // must report invalid rather than making a fake verification claim.
  const check = await (await worker.fetch(new Request(`https://haawke-verify.haawkeai.workers.dev/verify/${digest}`, { headers: { Accept: 'application/json' } }), env, {})).json();
  assert.equal(check.sha256, digest); assert.equal(check.certificate_valid, false);
});
test('unauthorized, malformed, and binary content cannot write to the existing registry', async () => {
  const { env, records } = environment();
  assert.equal((await worker.fetch(request('seal', { content: 'x', content_type: 'text/plain' }, false), env, {})).status, 401);
  assert.equal((await worker.fetch(request('seal', { content: 'x', content_type: 'application/pdf', request_id: crypto.randomUUID() }), env, {})).status, 400);
  assert.equal((await worker.fetch(request('hash', { content: '\ud800', content_type: 'text/plain' }), env, {})).status, 400);
  assert.equal(records.size, 0);
});

test('new generation metadata is signed and exposed as a real v2 projection without private IDs',async()=>{
 const {env,records}=environment();const content='new Phoenix model response e\u0301\r\n';const digest=createHash('sha256').update(content).digest('hex');
 const provenance={model:'deepseek-ai/DeepSeek-V4.1-Flash',provider:'baseten',session_type:'human-initiated'};
 const sealed=await (await worker.fetch(request('seal',{content,content_type:'text/plain',request_id:crypto.randomUUID(),provenance}),env,{})).json();assert.equal(sealed.status,'REGISTERED');
 const original=records.get('record:'+digest),record=JSON.parse(original);assert.equal(record.schema_version,'2.0');assert.equal(record.anthropic.model,provenance.model);assert.equal(record.identity.session_type,provenance.session_type);assert.equal(record.chain.sequence_number,1);
 const before=new Map(records);const view=await(await worker.fetch(new Request('https://haawke-verify.haawkeai.workers.dev/verify/'+digest,{headers:{Accept:'application/json'}}),env,{})).json();
 assert.equal(view.schema_version,'2.0');assert.equal(view.content.output_hash,digest);assert.equal(view.sha256,digest);assert.equal(view.model,provenance.model);assert.equal(view.anthropic.model,provenance.model);assert.equal(view.chain.sequence_number,record.chain.sequence_number);assert.equal(view.timestamp.registered_at,record.timestamp.registered_at);assert.equal(view.certificate_hash_valid,true);
 assert.equal(view.identity.session_type,'human-initiated');for(const key of ['session_id','api_endpoint','tool_surface'])assert.equal(Object.hasOwn(view.anthropic,key),false);assert.equal(Object.hasOwn(view,'environment'),false);assert.deepEqual(records,before);
 const again=await(await worker.fetch(request('seal',{content,content_type:'text/plain',request_id:crypto.randomUUID(),provenance:{...provenance,model:'different/model'}}),env,{})).json();assert.equal(again.status,'EXISTS');assert.equal(records.get('record:'+digest),original);
});
test('true legacy lookup and duplicate sealing do not upgrade or rewrite the legacy record',async()=>{
 const {env,records,storage}=environment();const content='genuine legacy artifact';const digest=createHash('sha256').update(content).digest('hex');const legacy={hash:digest,filename:'old.txt',author:'Legacy',registered:'2024-01-01T00:00:00Z',ots_status:'confirmed'};const original=JSON.stringify(legacy);records.set(digest,original);
 const view=await(await worker.fetch(new Request('https://haawke-verify.haawkeai.workers.dev/verify/'+digest,{headers:{Accept:'application/json'}}),env,{})).json();assert.equal(view.hash,digest);assert.equal(view.author,'Legacy');assert.equal(Object.hasOwn(view,'schema_version'),false);assert.equal(Object.hasOwn(view,'content'),false);
 const sealed=await(await worker.fetch(request('seal',{content,content_type:'text/plain',request_id:crypto.randomUUID(),provenance:{model:'known/model',provider:'baseten',session_type:'human-initiated'}}),env,{})).json();assert.equal(sealed.status,'PROVENANCE_PENDING');assert.equal(records.get(digest),original);assert.equal(records.has('record:'+digest),false);assert.equal(storage.get('seq'),undefined);
});
test('malformed or private generation metadata cannot write records',async()=>{
 for(const provenance of [{model:'x',provider:'baseten',session_type:'human-initiated',email:'private@example.test'},{model:'<img onerror=alert(1)>',provider:'baseten',session_type:'human-initiated'},{model:'x',provider:'baseten',session_type:'api'},{model:'x',provider:'baseten',session_type:'human-initiated',session_id:'private-session'},null]){const {env,records}=environment();const r=await worker.fetch(request('seal',{content:'x',content_type:'text/plain',request_id:crypto.randomUUID(),provenance}),env,{});assert.equal(r.status,400);assert.equal(records.size,0);}
});
test('stored private session/environment fields remain withheld and certificate tampering stays detectable',async()=>{
 const {env,records}=environment();const digest=createHash('sha256').update('private projection check').digest('hex');const response=await worker.fetch(new Request('https://haawke-verify.haawkeai.workers.dev/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:{output_hash:digest,filename:'check.txt'},identity:{author:'Service',session_type:'human-initiated'},anthropic:{model:'Known/model',session_id:'private-session-sentinel',api_endpoint:'private-endpoint-sentinel',tool_surface:'private-tool-sentinel'},environment:{sealing_machine:'private-machine-sentinel'},timestamp:{local_log_at:'private-log-sentinel'}})}),env,{});assert.equal(response.status,201);
 const original=records.get('record:'+digest);const read=()=>worker.fetch(new Request('https://haawke-verify.haawkeai.workers.dev/verify/'+digest,{headers:{Accept:'application/json'}}),env,{});const view=await(await read()).json();assert.equal(view.certificate_hash_valid,true);assert.equal(records.get('record:'+digest),original);const projection={content:view.content,identity:view.identity,anthropic:view.anthropic,chain:view.chain,timestamp:view.timestamp,anchor:view.anchor,verification:view.verification};for(const label of ['session','endpoint','tool','machine','log'])assert.ok(!JSON.stringify(projection).includes('private-'+label+'-sentinel'));assert.equal(view.qr_payload,JSON.parse(original).verification.qr_payload);
 const changed=JSON.parse(original);changed.anthropic.model='Tampered/model';records.set('record:'+digest,JSON.stringify(changed));const invalid=await(await read()).json();assert.equal(invalid.certificate_hash_valid,false);assert.equal(invalid.certificate_valid,false);
});
