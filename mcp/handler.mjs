// RestoreWorth FEMA Data -- remote MCP server (Streamable HTTP, JSON-RPC 2.0 written by hand, no dependency).
// No import on purpose: scripts/build.mjs (MCP_PUBLIC=1) inlines this file after `const DATA = {...}` built by
// mcp/data.mjs from the FEMA files only, and writes dist/api/mcp.js. Nothing is fetched at run time.
function createHandler(DATA) {
  const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
  const PAID = 'amounts paid by NFIP, not repair cost';
  const RATIO_NOTE = 'median ratio of the band, not an estimate for this home';
  const NIS = 'not in source';
  const ANNOT = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };
  const url = path => (path ? DATA.origin + path : NIS);
  // A null in a source file is a value the source does not give: it is said, never turned into 0.
  const nis = v => (v === null || v === undefined ? NIS : Array.isArray(v) ? v.map(nis)
    : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nis(x)])) : v);
  const norm = s => String(s).toLowerCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();
  const countyKey = s => norm(s).replace(/ (county|parish|borough|census area|city and borough|municipality)$/, '');
  const common = (n, window, asOf, page) => ({ n, window, as_of: asOf, page_url: url(page), basis: PAID });

  const stateCode = q => {
    const s = norm(q);
    const hit = DATA.states.find(x => norm(x.code) === s || norm(x.name) === s);
    return hit ? hit.code : null;
  };
  const stateName = code => (DATA.states.find(x => x.code === code) || {}).name || NIS;
  const S = DATA.stateFile;
  const stateRow = code => {
    const r = S.records.find(x => x.state === code);
    if (!r) return null;
    const out = {
      state: code, state_name: stateName(code), ...common(r.n_paid, r.window, S.source.as_of_date, DATA.pages.nfip_state),
      retrieved_utc: r.retrieved_utc, n_claims: r.n_claims, n_paid: r.n_paid, status: r.status,
      q1_paid_usd: r.q1, median_paid_usd: r.median, q3_paid_usd: r.q3, total_paid_usd: r.total_paid,
      median_paid_2024usd: r.median_2024usd, median_paid_excl_dominant_event_usd: r.median_excl_top_event, event_dependent: r.event_dependent,
      dollars: 'nominal dollars; median_paid_2024usd deflated with CPI-U by year of loss'
    };
    if (r.top_event) out.dominant_event = { name: r.top_event, share: r.top_event_share };
    if (r.status !== 'ok') out.note = `Fewer than ${S.method.min_n_paid} paid claims in ${r.window}: the source publishes no statistics for this state.`;
    if (DATA.pages.states[code]) out.state_page_url = url(DATA.pages.states[code]);
    return out;
  };
  const source = (s, extra = {}) => ({ publisher: s.publisher, dataset: s.dataset, dataset_page: s.dataset_page, terms: s.terms, ...extra });

  const TOOLS = {
    nfip_claims_by_state: {
      title: 'NFIP paid building claims by state',
      description: `NFIP paid building claims for one US state or DC, ${S.method.window} (FEMA OpenFEMA, NFIP Redacted Claims v3): number of paid claims, quartiles and median of the amount paid, dominant flood event and its share. These are ${PAID}.`,
      inputSchema: { type: 'object', properties: { state: { type: 'string', minLength: 2, maxLength: 40, description: 'Two-letter USPS code (TX) or state name (Texas)' } }, required: ['state'], additionalProperties: false },
      run: ({ state }) => {
        const code = stateCode(state);
        const row = code && stateRow(code);
        if (!row) return fail(`State "${state}" is not in the NFIP state table (50 states + DC). Use a two-letter code such as TX.`);
        return { tool: 'nfip_claims_by_state', ...row, source: source(S.source, { retrieved_utc: S.source.retrieved_utc }), fema_notice: DATA.fema_notice };
      }
    },
    nfip_claims_by_county: {
      title: 'NFIP paid building claims by county',
      description: `NFIP paid building claims for one county, ${DATA.countyFile.method.window} and ${DATA.countyFile.method.window_recent}. Give a 5-digit FIPS code, or a county name and its state. A county absent from the table (it keeps counties with at least ${DATA.countyFile.method.min_n_paid} paid claims) gets the state row, and the answer says so. These are ${PAID}.`,
      inputSchema: { type: 'object', properties: {
        fips: { type: 'string', pattern: '^[0-9]{5}$', description: '5-digit county FIPS code, e.g. 48201' },
        county: { type: 'string', minLength: 2, maxLength: 60, description: 'County name, e.g. Harris County (needs state)' },
        state: { type: 'string', minLength: 2, maxLength: 40, description: 'Two-letter code or state name, with county' }
      }, additionalProperties: false },
      run: ({ fips, county, state }) => {
        const C = DATA.countyFile;
        let rec = null, code = null;
        if (fips) {
          if (!/^[0-9]{5}$/.test(fips)) return fail('fips must be 5 digits, e.g. 48201.');
          rec = C.records.find(r => r.fips === fips);
          code = rec ? rec.state : DATA.fipsStates[fips.slice(0, 2)] || null;
        } else {
          if (!county || !state) return fail('Give fips, or county and state.');
          code = stateCode(state);
          if (!code) return fail(`State "${state}" not recognized.`);
          rec = C.records.find(r => r.state === code && countyKey(r.county) === countyKey(county));
        }
        const query = fips ? { fips } : { county, state };
        const base = { tool: 'nfip_claims_by_county', query, fema_county_caveat: C.method.fema_county_caveat,
          source: source(C.source, { retrieved_utc: C.source.retrieved_utc, dataset_last_refresh_utc: C.source.dataset_last_refresh_utc, next_refresh_planned: C.source.next_refresh_planned }) };
        if (!rec || !(rec.n_paid_2015_2024 >= C.method.min_n_paid)) {
          const row = code && stateRow(code);
          const reason = rec ? `fewer than ${C.method.min_n_paid} paid claims for this county in ${C.method.window}` : `county not in the county table (it keeps counties with at least ${C.method.min_n_paid} paid claims in ${C.method.window})`;
          if (!row) return fail(`No county row (${reason}) and no state could be identified${fips ? ' from this FIPS; give county and state instead' : ''}.`);
          return { ...base, match: 'state_fallback', note: `State row returned instead: ${reason}.`, ...row, fema_notice: DATA.fema_notice };
        }
        const win = y => {
          const n = rec[`n_paid_${y}`];
          if (!(n >= C.method.min_n_paid)) return { n_paid: n ?? NIS, note: `fewer than ${C.method.min_n_paid} paid claims in this window: statistics not published in the source` };
          const w = { n_paid: n, q1_paid_usd: rec[`q1_paid_${y}`], median_paid_usd: rec[`median_paid_${y}`], q3_paid_usd: rec[`q3_paid_${y}`] };
          if (rec[`top_event_${y}`]) w.dominant_event = { name: rec[`top_event_${y}`], share: rec[`top_event_share_${y}`] };
          return w;
        };
        const page = DATA.pages.counties[rec.fips] || DATA.pages.states[rec.state] || DATA.pages.nfip_state;
        const out = { ...base, match: 'county', fips: rec.fips, county: rec.county, state: rec.state,
          ...common(rec.n_paid_2015_2024, C.method.window, C.source.dataset_last_refresh_utc.slice(0, 10), page),
          dollars: 'nominal dollars', windows: { [C.method.window]: win('2015_2024'), [C.method.window_recent]: win('2020_2024') } };
        if (rec.top_event_2015_2024) out.dominant_event = { name: rec.top_event_2015_2024, share: rec.top_event_share_2015_2024 };
        return { ...out, fema_notice: DATA.fema_notice };
      }
    },
    flood_damage_by_water_depth: {
      title: 'NFIP flood damage by interior water depth',
      description: `Median damage ratio (FEMA actual cash value of the damage / actual cash value of the building) on NFIP paid claims ${DATA.depthFile.method.window}, by interior water depth band and single-family one-floor segment. With building_value_usd, returns ratio x value: the ${RATIO_NOTE}.`,
      inputSchema: { type: 'object', properties: {
        depth_inches: { type: 'integer', minimum: 1, maximum: 240, description: 'Interior water depth in inches (1-240)' },
        building_value_usd: { type: 'number', exclusiveMinimum: 0, maximum: 100000000, description: 'Optional building value in dollars' },
        segment: { type: 'string', enum: Object.keys(DATA.depthFile.method.segments), description: 'Building segment (default single_family_one_floor_no_basement)' }
      }, required: ['depth_inches'], additionalProperties: false },
      run: ({ depth_inches: d, building_value_usd: v, segment = 'single_family_one_floor_no_basement' }) => {
        const D = DATA.depthFile;
        if (!Number.isInteger(d) || d < 1 || d > 240) return fail('depth_inches must be an integer from 1 to 240.');
        if (!D.method.segments[segment]) return fail(`segment must be one of: ${Object.keys(D.method.segments).join(', ')}.`);
        if (v !== undefined && !(typeof v === 'number' && v > 0 && v <= 100000000)) return fail('building_value_usd must be a number above 0.');
        const r = D.records.find(x => x.segment === segment && d >= x.depth_min_in && d <= x.depth_max_in);
        if (!r) return fail('No depth band in the source for this depth and segment.');
        const ok = r.n >= D.method.min_n;
        const out = { tool: 'flood_damage_by_water_depth', depth_inches: d, depth_band_in: r.depth_band_in, segment, segment_label: r.segment_label,
          ...common(r.n, D.method.window, D.source.dataset_last_refresh_utc.slice(0, 10), DATA.pages.depth),
          median_damage_ratio: ok ? r.median_damage_ratio : NIS, median_damage_usd_of_these_claims: ok ? r.median_damage_usd : NIS,
          excluding_harvey_ian: { n: r.n_excl_harvey_ian, median_damage_ratio: r.median_damage_ratio_excl_harvey_ian, median_damage_usd_of_these_claims: r.median_damage_usd_excl_harvey_ian },
          ratio_definition: D.method.ratio, damage_basis: D.method.damage_basis, depth_rule: D.method.depth_rule, heaping_1_inch: D.method.heaping_1_inch,
          basis: `damage ratio = ${D.method.ratio}; damage = ${D.method.damage_basis}. Separate field paid_over_damage: ${PAID} (${D.paid_over_damage.definition}).`, paid_over_damage: D.paid_over_damage };
        if (!ok) out.note = `Fewer than ${D.method.min_n} claims in this band: statistics left empty in the source.`;
        if (v !== undefined && ok) out.building_value = { building_value_usd: v, median_damage_usd: Math.round(r.median_damage_ratio * v), formula: 'median_damage_ratio x building_value_usd', note: RATIO_NOTE };
        return { ...out, source: source(D.source, { retrieved_utc: D.source.retrieved_utc, dataset_last_refresh_utc: D.source.dataset_last_refresh_utc, next_refresh_planned: D.source.next_refresh_planned }), fema_notice: DATA.fema_notice };
      }
    },
    county_profile: {
      title: 'County FEMA profile',
      description: 'FEMA open-data profile of one county by 5-digit FIPS: NFIP paid claims summary, disaster declarations since 2000, FEMA inspections of owner applicants (Individuals and Households Program), NFIP Community Status Book and CRS classes. A value the source does not give is returned as "not in source", never 0.',
      inputSchema: { type: 'object', properties: { fips: { type: 'string', pattern: '^[0-9]{5}$', description: '5-digit county FIPS code, e.g. 48201' } }, required: ['fips'], additionalProperties: false },
      run: ({ fips }) => {
        if (!/^[0-9]{5}$/.test(fips || '')) return fail('fips must be 5 digits, e.g. 48201.');
        const c = DATA.v2.counties[fips];
        if (!c) return fail(`No county profile for FIPS ${fips} (${Object.keys(DATA.v2.counties).length} counties covered). Try nfip_claims_by_county.`);
        const top = (c.claims.top_events || [])[0];
        const out = { tool: 'county_profile', fips, name: c.name, state: c.state,
          ...common(c.claims.n_paid, c.claims.window, c.as_of, DATA.pages.counties[fips] || DATA.pages.states[c.state] || DATA.pages.nfip_state),
          generated_at: c.generated_at, claims: c.claims };
        if (top && c.claims.dominant_event_share != null) out.dominant_event = { name: top.name, share: c.claims.dominant_event_share };
        Object.assign(out, { declarations: c.declarations, owners_assistance: c.owners_assistance, community_status: c.community_status, notes: c.notes, sources: c.sources });
        return { ...out, fema_notice: DATA.fema_notice };
      }
    },
    list_sources: {
      title: 'Sources and refresh dates',
      description: 'Lists every source file this server reads, with publisher, dataset page, terms, as-of and retrieval dates, and the RestoreWorth page that publishes it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => ({ tool: 'list_sources', basis: PAID, page_url: url(DATA.pages.nfip_state || '/'), as_of: S.source.as_of_date, files: [
        { title: S.title, n: S.records.length, window: S.method.window, as_of: S.source.as_of_date, page_url: url(DATA.pages.nfip_state), tools: ['nfip_claims_by_state', 'nfip_claims_by_county'], ...source(S.source, { retrieved_utc: S.source.retrieved_utc }) },
        { title: DATA.countyFile.title, n: DATA.countyFile.records.length, window: DATA.countyFile.method.window, as_of: DATA.countyFile.source.dataset_last_refresh_utc.slice(0, 10), page_url: url(DATA.pages.county_table), tools: ['nfip_claims_by_county'], ...source(DATA.countyFile.source, { retrieved_utc: DATA.countyFile.source.retrieved_utc, next_refresh_planned: DATA.countyFile.source.next_refresh_planned }) },
        { title: DATA.depthFile.title, n: DATA.depthFile.records.length, window: DATA.depthFile.method.window, as_of: DATA.depthFile.source.dataset_last_refresh_utc.slice(0, 10), page_url: url(DATA.pages.depth), tools: ['flood_damage_by_water_depth'], ...source(DATA.depthFile.source, { retrieved_utc: DATA.depthFile.source.retrieved_utc, next_refresh_planned: DATA.depthFile.source.next_refresh_planned }) },
        { title: 'County profiles (FEMA open data and BLS CPI-U, several datasets)', n: Object.keys(DATA.v2.counties).length, tools: ['county_profile'], datasets: DATA.v2.sources }
      ], fema_notice: DATA.fema_notice })
    }
  };
  const fail = text => ({ __error: text });

  const callTool = params => {
    const tool = TOOLS[params && params.name];
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params && params.name}` } };
    const args = params.arguments == null ? {} : params.arguments;
    if (typeof args !== 'object' || Array.isArray(args)) return { result: errResult('arguments must be an object.') };
    const props = tool.inputSchema.properties;
    const extra = Object.keys(args).filter(k => !(k in props));
    if (extra.length) return { result: errResult(`Unknown argument(s): ${extra.join(', ')}.`) };
    for (const k of tool.inputSchema.required || []) if (args[k] === undefined) return { result: errResult(`Missing argument: ${k}.`) };
    for (const [k, v] of Object.entries(args)) {
      const t = props[k].type;
      if (t === 'string' && typeof v !== 'string') return { result: errResult(`${k} must be a string.`) };
      if ((t === 'number' || t === 'integer') && typeof v !== 'number') return { result: errResult(`${k} must be a number.`) };
    }
    const raw = tool.run(args);
    if (raw.__error) return { result: errResult(raw.__error) };
    const out = nis(raw);
    return { result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false } };
  };
  const errResult = text => ({ content: [{ type: 'text', text }], isError: true });

  const dispatch = msg => {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
      return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
    if (msg.id === undefined || msg.id === null) return null; // notification: no response
    const ok = result => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'restoreworth-fema-data', title: 'RestoreWorth FEMA Data', version: DATA.version },
          instructions: `Read-only FEMA open data (NFIP claims, water depth, county profiles) as computed for ${DATA.origin}. Every amount is from FEMA files: ${PAID}. No repair-cost estimate is served.` });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...ANNOT } })) });
      case 'tools/call': { const r = callTool(msg.params); return r.error ? { jsonrpc: '2.0', id: msg.id, error: r.error } : ok(r.result); }
      default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };

  const BASE_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'X-Robots-Tag': 'noindex',
    'Cache-Control': 'no-store'
  };
  const reply = (status, body, sse) => new Response(body === null ? null : sse ? `event: message\ndata: ${JSON.stringify(body)}\n\n` : JSON.stringify(body),
    { status, headers: { ...BASE_HEADERS, ...(body === null ? {} : { 'Content-Type': sse ? 'text/event-stream' : 'application/json' }) } });

  async function POST(request) {
    const ua = request.headers.get('user-agent') || '';
    const accept = (request.headers.get('accept') || '').toLowerCase();
    const sseIdx = accept.indexOf('text/event-stream');
    const jsonIdx = accept.indexOf('application/json');
    if (accept && sseIdx === -1 && jsonIdx === -1 && !/\*\/\*|application\/\*/.test(accept))
      return reply(406, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Not Acceptable: Accept must include application/json or text/event-stream' } }, false);
    let body;
    try { body = JSON.parse(await request.text()); } catch {
      return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, false);
    }
    const first = Array.isArray(body) ? body[0] : body;
    // Parc rule 13/10: SSE for claude.ai (UA Claude-User, clientInfo ClaudeAI) or an Accept listing text/event-stream first.
    const wantSse = /Claude-User/i.test(ua) || /ClaudeAI/i.test((first && first.params && first.params.clientInfo && first.params.clientInfo.name) || '')
      || (sseIdx !== -1 && (jsonIdx === -1 || sseIdx < jsonIdx));
    const msgs = Array.isArray(body) ? body : [body];
    for (const m of msgs) console.log(JSON.stringify({ mcp: m && m.method, tool: m && m.method === 'tools/call' && m.params ? m.params.name : undefined, ua: ua.slice(0, 120) }));
    if (Array.isArray(body) && !body.length) return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, wantSse);
    const out = msgs.map(dispatch).filter(Boolean);
    if (!out.length) return reply(202, null, false);
    return reply(200, Array.isArray(body) ? out : out[0], wantSse);
  }
  const GET = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed: POST JSON-RPC to this endpoint' } }),
    { status: 405, headers: { ...BASE_HEADERS, Allow: 'POST, OPTIONS', 'Content-Type': 'application/json' } });
  const OPTIONS = async () => new Response(null, { status: 204, headers: BASE_HEADERS });
  return { POST, GET, OPTIONS, DELETE: GET, TOOLS };
}

export { createHandler };
