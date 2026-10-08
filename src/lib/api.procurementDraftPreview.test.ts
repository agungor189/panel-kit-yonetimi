import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api.js';

test('draft FINAL preview is read-only POST while FINAL approval keeps operation identity', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string,string> }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers:init.headers as Record<string,string> });
    return new Response(JSON.stringify({ success:true,data:{} }),{ status:200,headers:{ 'content-type':'application/json' } });
  }) as typeof fetch;
  try {
    await api.post('/procurement/v1/imports/drafts/draft/cost-preview',{});
    assert.equal(calls.length,1);
    assert.equal(calls[0].headers['X-Operation-ID'],undefined);
    await assert.rejects(api.post('/procurement/v1/imports/drafts/draft/finalize',{}),/X-Operation-ID/);
    await api.post('/procurement/v1/imports/drafts/draft/finalize',{}, { operationId:'approved-preview' });
    assert.equal(calls[1].headers['X-Operation-ID'],'approved-preview');
  } finally { globalThis.fetch = original; }
});
