import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { saveIntegration } from '../../src/core/settings/integrations.js';
import { inboundCallerContext, recordInboundSarvamCall, syncSarvamInbound } from '../../src/integrations/voiceagent/inbound.js';
import { placeAgentCall } from '../../src/integrations/voiceagent/sarvam.js';
import { adminContext, adminToken, leadInput } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let known = '';
let untouched = '';
let phone = '';
const stamp = Date.now();
const testApp = `Inbound-test-${stamp}`;
const deploymentId = `Inbound-${stamp}`;
const auth = () => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => {
  app = createApp(); token = await adminToken(app);
  await saveIntegration('sarvam_voice', { isActive: true, credentials: { apiKey:'test-key',webhookSecret:'inbound-test-secret' },
    config: { orgId:'test-org',workspaceId:'test-workspace',appId:testApp,appVersion:'9',connectionId:'test-connection',agentPhoneNumber:'+917965481133',
      inboundDeploymentId:deploymentId,inboundModule:'leads',syncInboundVersion:'true',batchSize:'2',
      agentsByModule:JSON.stringify({leads:{appId:testApp,appVersion:9}}) } });
  const ctx = await adminContext();
  const record = await recordService.createRecord(ctx,'leads',leadInput({full_name:`Inbound Known ${stamp}`,budget:15000000}));
  known=record.id; phone=String(record.values.mobile);
  untouched=(await recordService.createRecord(ctx,'leads',leadInput({full_name:`Inbound Untouched ${stamp}`}))).id;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => { await saveIntegration('sarvam_voice',{isActive:false,config:{batchSize:'25',syncInboundVersion:'false'}}); });

describe('inbound recognition and past AI call identification', () => {
  it('recognizes a unique caller even without a pending outbound call and includes current requirements', async () => {
    const context = await inboundCallerContext(`+91${phone.replace(/\D/g,'').slice(-10)}`,testApp);
    expect(context?.crm_record_id).toBe(known);
    const info=JSON.parse(String(context?.crm_context));
    expect(info.call_direction).toBe('inbound'); expect(info.fields.budget).toBe(15000000); expect(info.identity_verification_required).toBe(true);
    expect(await inboundCallerContext(phone,'another-agent')).toBeNull();
  });
  it('does not reveal a guessed identity for an unknown or shared number', async () => {
    const unknown = await inboundCallerContext('+919000000001',testApp);
    expect(unknown?.crm_record_id).toBe(''); expect(JSON.parse(String(unknown?.crm_context)).match).toBe('none');
    const other=await recordService.createRecord(await adminContext(),'leads',leadInput());
    await db.query('UPDATE ipy_e_leads SET alternate_phone=$2 WHERE record_id=$1',[other.id,phone]);
    try {
      const shared=await inboundCallerContext(phone,testApp);
      expect(shared?.user_name).toBe(''); expect(shared?.crm_record_id).toBe('');
      expect(JSON.parse(String(shared?.crm_context)).match).toBe('ambiguous');
    } finally { await db.query('UPDATE ipy_e_leads SET alternate_phone=NULL WHERE record_id=$1',[other.id]); }
  });
  it('logs inbound calls against a unique CRM record once, including duplicate webhook delivery', async () => {
    const body={app_id:testApp,app_version:9,deployment_id:deploymentId,interaction_id:`20261018/test-${stamp}`,user_phone_number:phone,agent_phone_number:'+917965481133',duration:40};
    await recordInboundSarvamCall(body); await recordInboundSarvamCall(body);
    const rows=await db.query(`SELECT * FROM ipy_call WHERE provider_call_id=$1`,[body.interaction_id]);
    expect(rows.rows).toHaveLength(1); expect(rows.rows[0]).toMatchObject({record_id:known,direction:'inbound',status:'completed',duration_seconds:40});
  });
  it('marks historical outbound calls and filters called, uncalled, and last unsuccessful records', async () => {
    const ctx=await adminContext();
    await db.query(`INSERT INTO ipy_call(direction,from_number,to_number,status,source,record_id,record_module,user_id) VALUES ('outbound','test',$1,'busy','sarvam',$2,'leads',$3)`,[phone,known,ctx.user.id]);
    const called=await recordService.listRecords(ctx,'leads',{aiCalls:'called',search:`Inbound Known ${stamp}`});
    expect(called.rows[0]?.aiCalls).toMatchObject({attempts:1,answered:0,lastStatus:'busy'});
    const failed=await recordService.listRecords(ctx,'leads',{aiCalls:'unsuccessful',search:`Inbound Known ${stamp}`}); expect(failed.rows.map((r) => r.id)).toContain(known);
    const fresh=await recordService.listRecords(ctx,'leads',{aiCalls:'not_called',search:`Inbound Untouched ${stamp}`}); expect(fresh.rows.map((r) => r.id)).toContain(untouched);
    const neighbour=await request(app).get(`/api/records/leads/${known}/neighbours`).query({aiCalls:'called',search:`Inbound Known ${stamp}`}).set(auth());
    expect(neighbour.status).toBe(200); expect(neighbour.body.total).toBe(1);
    const excluded=await recordService.listRecords(ctx,'leads',{aiCalls:'not_called',search:`Inbound Known ${stamp}`}); expect(excluded.total).toBe(0);
  });
  it('enforces the admin batch limit on the server and rejects invalid calling settings', async () => {
    const res=await request(app).post('/api/telephony/sarvam-queues').set(auth()).send({module:'leads',ids:[known,untouched,crypto.randomUUID()]}); expect(res.status).toBe(400);
    const bad=await request(app).put('/api/admin/integrations/sarvam_voice').set(auth()).send({config:{callStart:'26:00'}}); expect(bad.status).toBe(422);
  });
  it('prevents individual outbound dials outside hours without contacting Sarvam', async () => {
    const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher);
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-10-18T15:00:00Z'));
    const result=await placeAgentCall({toNumber:phone,recordId:known,recordModule:'leads',publicBaseUrl:'https://crm.example.com'});
    expect(result).toMatchObject({ok:false,outsideWindow:true}); expect(fetcher).not.toHaveBeenCalled();
  });
  it('syncs inbound v1 to the live CRM v9 and preserves the existing phone routing and schedule', async () => {
    const state={app_id:testApp,app_version:1,status:'active',connection_configs:[{phone_numbers:['+917965481133','+917965481155']}],inbound_config:{start_time:'00:00',end_time:'23:59'}};
    const requests: {method:string;body:Record<string,unknown>}[]=[];
    vi.stubGlobal('fetch',vi.fn(async (_url:string, init:{method:string;body?:string}) => {
      const body=JSON.parse(init.body || '{}'); requests.push({method:init.method,body});
      if(init.method==='PATCH') Object.assign(state,body);
      return new Response(JSON.stringify(state),{status:200});
    }));
    expect(await syncSarvamInbound()).toMatchObject({enabled:true,version:9,status:'active'});
    expect(requests.map((r) => r.method)).toEqual(['GET','PUT','PATCH','PUT','GET']);
    const patch=requests.find((r) => r.method==='PATCH')!.body;
    expect(patch).not.toHaveProperty('connection_configs'); expect(patch).not.toHaveProperty('inbound_config');
    expect(String((patch.webhook_config as {url:string}).url)).toContain('/inbound');
  });
});
