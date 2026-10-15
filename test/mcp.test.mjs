// Remote MCP server (mcp/handler.mjs + mcp/data.mjs, shipped as dist/api/mcp.js by build.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mcpBundle, NOTICE_RE, STATE_FILE, FEMA_DIR } from '../mcp/data.mjs';

const PAGES = ['/nfip-flood-claims-by-state.html', '/flood-damage-by-water-depth.html', '/flood-data/texas/', '/flood-data/texas/harris-county-tx/'];
const bundle = mcpBundle({ pages: PAGES, origin: 'https://restoreworth.com' });
const file = join(mkdtempSync(join(tmpdir(), 'rw-mcp-')), 'mcp.mjs');
writeFileSync(file, bundle);
const { POST, GET, OPTIONS } = await import(pathToFileURL(file).href);
const PAID = 'amounts paid by NFIP, not repair cost';
const stateRec = code => JSON.parse(readFileSync(STATE_FILE, 'utf8')).records.find(r => r.state === code);

const rpc = (body, headers = {}) => POST(new Request('https://restoreworth.com/api/mcp', { method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const call = async (name, args) => {
  const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200);
  const { result } = await res.json();
  return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
};
const common = (out, name) => {
  assert.equal(out.tool, name);
  assert.ok(JSON.stringify(out).includes(PAID), `${name}: "${PAID}"`);
  assert.ok(out.as_of && out.page_url, `${name}: as_of and page_url`);
  assert.ok(PAGES.some(p => out.page_url === `https://restoreworth.com${p}`), `${name}: page_url is a built page`);
  assert.equal(out.fema_notice, out.fema_notice.match(NOTICE_RE)[0]);
  assert.match(out.fema_notice, /not endorsed by FEMA/);
  assert.doesNotMatch(JSON.stringify(out), /\b(fair|reasonable|normal)\b|nfip-claims-by-county\.html|null/i);
};

test('mcp: initialize, initialized notification (202), ping, tools/list', async () => {
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'restoreworth-fema-data');
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  assert.deepEqual((await (await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })).json()).result, {});
  const { tools } = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()).result;
  assert.deepEqual(tools.map(t => t.name), ['nfip_claims_by_state', 'nfip_claims_by_county', 'flood_damage_by_water_depth', 'county_profile', 'list_sources']);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, false);
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  assert.equal((await (await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' })).json()).error.code, -32601);
});

test('mcp: nfip_claims_by_state reads the state file (code or name), insufficient n is "not in source"', async () => {
  const tx = await call('nfip_claims_by_state', { state: 'Texas' });
  common(tx, 'nfip_claims_by_state');
  const r = stateRec('TX');
  assert.equal(tx.n, r.n_paid);
  assert.equal(tx.median_paid_usd, r.median);
  assert.equal(tx.window, '2020-2024');
  assert.deepEqual(tx.dominant_event, { name: r.top_event, share: r.top_event_share });
  assert.equal(tx.state_page_url, 'https://restoreworth.com/flood-data/texas/');
  const ak = await call('nfip_claims_by_state', { state: 'ak' });
  common(ak, 'nfip_claims_by_state');
  assert.equal(ak.median_paid_usd, 'not in source');
  assert.match(ak.note, /Fewer than 100 paid claims/);
  assert.match((await call('nfip_claims_by_state', { state: 'Atlantis' })).error, /not in the NFIP state table/);
  assert.match((await call('nfip_claims_by_state', { state: 'TX', x: 1 })).error, /Unknown argument/);
});

test('mcp: nfip_claims_by_county by FIPS and by name; absent county falls back to the state row and says so', async () => {
  const rec = JSON.parse(readFileSync(join(FEMA_DIR, 'nfip_claims_by_county.json'), 'utf8')).records.find(r => r.fips === '48201');
  const byFips = await call('nfip_claims_by_county', { fips: '48201' });
  common(byFips, 'nfip_claims_by_county');
  assert.equal(byFips.match, 'county');
  assert.equal(byFips.n, rec.n_paid_2015_2024);
  assert.equal(byFips.windows['2015-2024'].median_paid_usd, rec.median_paid_2015_2024);
  assert.deepEqual(byFips.dominant_event, { name: rec.top_event_2015_2024, share: rec.top_event_share_2015_2024 });
  assert.equal(byFips.page_url, 'https://restoreworth.com/flood-data/texas/harris-county-tx/');
  const byName = await call('nfip_claims_by_county', { county: 'harris county', state: 'TX' });
  assert.equal(byName.fips, '48201');
  for (const args of [{ fips: '48999' }, { county: 'Nowhere', state: 'Texas' }]) {
    const fb = await call('nfip_claims_by_county', args);
    common(fb, 'nfip_claims_by_county');
    assert.equal(fb.match, 'state_fallback');
    assert.match(fb.note, /State row returned instead: county not in the county table/);
    assert.equal(fb.n, stateRec('TX').n_paid);
    assert.equal(fb.page_url, 'https://restoreworth.com/nfip-flood-claims-by-state.html');
  }
  // A state with no county in the table: the FIPS prefix still finds the state (Census county file).
  const mn = await call('nfip_claims_by_county', { fips: '27053' });
  assert.equal(mn.match, 'state_fallback');
  assert.equal(mn.state, 'MN');
  const thin = await call('nfip_claims_by_county', { fips: '01089' });
  assert.match(thin.windows['2020-2024'].note, /fewer than 100 paid claims/);
  assert.match((await call('nfip_claims_by_county', { county: 'Harris' })).error, /fips, or county and state/);
});

test('mcp: flood_damage_by_water_depth gives band, segment and ratio x value, labelled as the band median', async () => {
  const rec = JSON.parse(readFileSync(join(FEMA_DIR, 'flood_damage_by_water_depth.json'), 'utf8')).records
    .find(r => r.segment === 'single_family_one_floor_no_basement' && r.depth_band_in === '7-12');
  const out = await call('flood_damage_by_water_depth', { depth_inches: 10, building_value_usd: 200000 });
  common(out, 'flood_damage_by_water_depth');
  assert.equal(out.depth_band_in, '7-12');
  assert.equal(out.n, rec.n);
  assert.equal(out.median_damage_ratio, rec.median_damage_ratio);
  assert.equal(out.building_value.median_damage_usd, Math.round(rec.median_damage_ratio * 200000));
  assert.equal(out.building_value.note, 'median ratio of the band, not an estimate for this home');
  assert.equal(out.page_url, 'https://restoreworth.com/flood-damage-by-water-depth.html');
  const slab = await call('flood_damage_by_water_depth', { depth_inches: 240, segment: 'single_family_one_floor_slab_not_elevated' });
  assert.equal(slab.depth_band_in, '73-240');
  assert.equal(slab.building_value, undefined);
  assert.match((await call('flood_damage_by_water_depth', { depth_inches: 241 })).error, /1 to 240/);
});

test('mcp: county_profile returns the v2 blocks; a null in the source is "not in source", never 0', async () => {
  const out = await call('county_profile', { fips: '48201' });
  common(out, 'county_profile');
  const src = JSON.parse(readFileSync(join(FEMA_DIR, 'v2/counties/harris-county-tx.json'), 'utf8'));
  assert.deepEqual(out.declarations, JSON.parse(JSON.stringify(src.declarations).replace(/null/g, '"not in source"')));
  assert.equal(out.owners_assistance.n_inspected, src.owners_assistance.n_inspected);
  assert.equal(out.community_status.crs_classed, src.community_status.crs_classed);
  assert.ok(out.community_status.communities.some(c => c.name === 'HOUSTON, CITY OF' && c.multi_county));
  assert.deepEqual(out.dominant_event, { name: src.claims.top_events[0].name, share: src.claims.dominant_event_share });
  // A county whose source carries a null in a kept block: the null is said, not turned into 0.
  const dir = join(FEMA_DIR, 'v2/counties');
  const withNull = readdirSync(dir).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .find(c => /null/.test(JSON.stringify([c.declarations, c.owners_assistance, c.claims.median_paid])));
  if (withNull) assert.match(JSON.stringify(await call('county_profile', { fips: withNull.id })), /not in source/);
  assert.match((await call('county_profile', { fips: '99999' })).error, /No county profile/);
});

test('mcp: list_sources lists the FEMA files with dates and pages', async () => {
  const out = await call('list_sources', {});
  common(out, 'list_sources');
  assert.equal(out.files.length, 4);
  for (const f of out.files.slice(0, 3)) assert.ok(f.as_of && f.dataset_page.startsWith('https://www.fema.gov/'));
  assert.ok(out.files[3].datasets.some(d => d.dataset === 'NfipCommunityStatusBook'));
});

test('mcp transport: JSON by default, SSE for Claude-User / ClaudeAI / Accept SSE first, 406, 405, CORS, noindex', async () => {
  const ping = { jsonrpc: '2.0', id: 9, method: 'ping' };
  const json = await rpc(ping);
  assert.equal(json.headers.get('content-type'), 'application/json');
  assert.equal(json.headers.get('x-robots-tag'), 'noindex');
  assert.equal(json.headers.get('access-control-allow-origin'), '*');
  const sseCases = [
    [ping, { 'user-agent': 'Claude-User (claude.ai)' }],
    [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Anthropic/ClaudeAI', version: '1' } } }, {}],
    [ping, { accept: 'text/event-stream, application/json' }],
    [ping, { accept: 'text/event-stream' }]
  ];
  for (const [body, headers] of sseCases) {
    const res = await rpc(body, headers);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.match(text, /^event: message\ndata: \{.*\}\n\n$/s);
    assert.equal(JSON.parse(text.split('data: ')[1]).id, body.id);
  }
  assert.equal((await rpc(ping, { accept: 'text/html' })).status, 406);
  assert.equal((await rpc('{bad')).status, 400);
  assert.equal((await GET()).status, 405);
  const pre = await OPTIONS();
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Mcp-Session-Id/);
});

test('mcp bundle: FEMA files only, no import', () => {
  assert.doesNotMatch(bundle, /^import /m);
  const nums = s => new Set(s.match(/\d+(?:\.\d+)?/g).map(n => String(Number(n)))); // 71205.0 in a file = 71205 in JSON
  const fema = nums([readFileSync(STATE_FILE, 'utf8'), readFileSync('mcp/handler.mjs', 'utf8'), readFileSync(join(FEMA_DIR, '../sources/national_county2020.txt'), 'utf8'),
    ...['nfip_claims_by_county.json', 'flood_damage_by_water_depth.json'].map(f => readFileSync(join(FEMA_DIR, f), 'utf8')),
    ...['states', 'counties'].flatMap(d => readdirSync(join(FEMA_DIR, 'v2', d)).map(f => readFileSync(join(FEMA_DIR, 'v2', d, f), 'utf8')))].join('\n'));
  const inBundle = nums(bundle);
  // Every number of the function comes from the FEMA files, the Census county file or the handler.
  assert.deepEqual([...inBundle].filter(n => !fema.has(n)), []);
});
