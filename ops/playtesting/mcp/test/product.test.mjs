import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';
import { createProductClient } from '../src/product.mjs';

test('MCP list and create operations reuse the account opponent library', async (t) => {
  const calls = [];
  const product = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ decks: [] }));
  });
  product.listen(0, '127.0.0.1');
  await once(product, 'listening');
  t.after(() => product.close());
  const client = createProductClient(`http://127.0.0.1:${product.address().port}`);
  await client.operation('library-fixture', 'list_decks', {});
  const deckId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const deck = { cards: [{ name: 'Forest', quantity: 60 }], sideboard: [] };
  await client.operation('library-fixture', 'update_deck', { deckId, expectedRevision: 2, name: 'Rival', format: 'Pioneer', archetype: 'Ramp', deck });
  assert.deepEqual(calls, [
    { path: '/api/playtesting/decks?library=agent', method: 'GET', auth: 'Bearer library-fixture' },
    { path: `/api/playtesting/decks/${deckId}`, method: 'PUT', auth: 'Bearer library-fixture', body: { name: 'Rival', format: 'Pioneer', archetype: 'Ramp', data: deck, expectedRevision: 2 } },
  ]);
});

test('[PM-AC-08] Railway library and play grants authorize the corresponding MCP tools', async (t) => {
  const product = createServer((req, res) => {
    assert.equal(req.url, '/internal/verify');
    const scopes = req.headers.authorization === 'Bearer play-fixture' ? ['play'] : ['library', 'history'];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ accountId: 'fixture', engineName: 'TestAgent', scopes }));
  });
  product.listen(0, '127.0.0.1');
  await once(product, 'listening');
  t.after(() => product.close());

  const client = createProductClient(`http://127.0.0.1:${product.address().port}`);
  const play = await client.authorize('play-fixture');
  assert.deepEqual(play.scopes, ['play', 'catalog']);
  const library = await client.authorize('library-fixture');
  assert.deepEqual(library.scopes, ['library', 'history', 'catalog', 'decks']);
});


test('[PM-DATA-02] get_deck round-trips through validate_deck with independently optional printing fields in both zones', async t => {
  const header={id:'fixture',library:'agent',name:'Fixture deck',format:'Pioneer',revision:2,listVersion:1};
  const cards=[
    {cardName:'Island',setCode:null,cardNumber:null,amount:56},
    {cardName:'Opt',setCode:'ELD',cardNumber:null,amount:2},
    {cardName:'Spell Pierce',setCode:null,cardNumber:'080',amount:1},
    {cardName:'Island',setCode:'M21',cardNumber:'265',amount:1},
  ];
  const sideboard=cards.map(card=>({...card,amount:1}));
  const stored={...header,data:{...header,source:{site:'fixture'},cards,sideboard}};
  const expectedCards=[
    {cardName:'Island',amount:56},{cardName:'Opt',setCode:'ELD',amount:2},
    {cardName:'Spell Pierce',cardNumber:'080',amount:1},{cardName:'Island',setCode:'M21',cardNumber:'265',amount:1},
  ];
  const expected={name:header.name,cards:expectedCards,sideboard:expectedCards.map(card=>({...card,amount:1}))};
  const api=createServer((req,res)=>{
    assert.equal(req.url,'/api/playtesting/decks/fixture');
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(stored));
  });
  api.listen(0,'127.0.0.1'); await once(api,'listening');
  t.after(()=>{api.closeAllConnections();api.close();});
  const product=createProductClient('http://127.0.0.1:'+api.address().port);
  const validated=[];
  const server=createMcpServer({
    authorize:async()=>({accountId:'owner',engineName:'Fixture',scopes:['decks','library']}),
    product:product.operation,
    createEngine:()=>({validateDeck:async args=>{validated.push(args);return {valid:true};}}),
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const client=new Client({name:'deck-round-trip',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+server.address().port+'/mcp'),{
    requestInit:{headers:{Authorization:'Bearer synthetic'}},
  }));
  t.after(()=>client.close());
  const call=(name,args)=>client.callTool({name,arguments:args});
  const response=await call('get_deck',{deckId:header.id});
  assert.equal(response.isError,false);
  const saved=JSON.parse(response.content[0].text);
  const tool=(await client.listTools()).tools.find(item=>item.name==='validate_deck');
  const checkSchema=new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  await t.test('reads keep the product envelope and omit only absent printing fields',()=>{
    assert.deepEqual(saved,{...stored,data:{...stored.data,...expected}});
  });
  await t.test('the complete saved payload and legacy null entries reach the same engine list',async()=>{
    for(const data of [saved.data,stored.data,expected]){
      assert.equal(checkSchema({format:saved.format,deck:data}).valid,true,'A client using the advertised schema can submit this list');
      const result=await call('validate_deck',{format:saved.format,deck:data});
      assert.equal(result.isError,false);
      assert.deepEqual(validated.at(-1),{format:saved.format,deck:expected});
    }
  });
  await t.test('a caller can select a particular printing without mutating the stored list',async()=>{
    const edited=structuredClone(saved.data);
    Object.assign(edited.sideboard[0],{setCode:'ELD',cardNumber:'008'});
    assert.equal((await call('validate_deck',{format:saved.format,deck:edited})).isError,false);
    assert.deepEqual(validated.at(-1).deck.sideboard[0],{cardName:'Island',amount:1,setCode:'ELD',cardNumber:'008'});
    assert.equal(stored.data.sideboard[0].setCode,null);
  });
  await t.test('bad printing and card fields are still rejected before engine validation',async()=>{
    const count=validated.length;
    for(const field of [{setCode:33},{setCode:'x'.repeat(13)},{cardNumber:false},{cardNumber:'1'.repeat(21)},
      {amount:0},{cardName:null},{cardName:''},{arbitrary:'unknown-card-field'}]){
      const bad={...stored.data,sideboard:[{...cards[0],...field}]};
      assert.equal(checkSchema({format:header.format,deck:bad}).valid,false);
      assert.equal((await call('validate_deck',{format:header.format,deck:bad})).isError,true);
    }
    assert.equal(validated.length,count);
  });
});
