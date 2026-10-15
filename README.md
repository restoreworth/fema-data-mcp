# restoreworth-fema-data-mcp

Source of the remote MCP server of [restoreworth.com](https://restoreworth.com/mcp.html), listed in the MCP registry as `com.restoreworth/fema-data`.
It serves FEMA open data (NFIP claims, flood damage by water depth, county profiles), read-only, with no key.
Every amount comes from FEMA files: amounts paid by NFIP, not repair cost. No repair-cost estimate is served.

- Endpoint: `https://restoreworth.com/api/mcp`
- Documentation page: https://restoreworth.com/mcp.html
- NFIP page: https://restoreworth.com/nfip-flood-claims-by-state.html

## Tools

Descriptions as returned by `tools/list`.

| Tool | Description |
| --- | --- |
| `nfip_claims_by_state` | NFIP paid building claims for one US state or DC, 2020-2024 (FEMA OpenFEMA, NFIP Redacted Claims v3): number of paid claims, quartiles and median of the amount paid, dominant flood event and its share. These are amounts paid by NFIP, not repair cost. |
| `nfip_claims_by_county` | NFIP paid building claims for one county, 2015-2024 and 2020-2024. Give a 5-digit FIPS code, or a county name and its state. A county absent from the table (it keeps counties with at least 100 paid claims) gets the state row, and the answer says so. These are amounts paid by NFIP, not repair cost. |
| `flood_damage_by_water_depth` | Median damage ratio (FEMA actual cash value of the damage / actual cash value of the building) on NFIP paid claims 2015-2024, by interior water depth band and single-family one-floor segment. With building_value_usd, returns ratio x value: the median ratio of the band, not an estimate for this home. |
| `county_profile` | FEMA open-data profile of one county by 5-digit FIPS: NFIP paid claims summary, disaster declarations since 2000, FEMA inspections of owner applicants (Individuals and Households Program), NFIP Community Status Book and CRS classes. A value the source does not give is returned as "not in source", never 0. |
| `list_sources` | Lists every source file this server reads, with publisher, dataset page, terms, as-of and retrieval dates, and the RestoreWorth page that publishes it. |

## Transport

Streamable HTTP, JSON-RPC 2.0, no session.

- `POST`: JSON response by default. The response is sent as Server-Sent Events (`text/event-stream`) when `text/event-stream` comes first in the `Accept` header, or when the client is claude.ai.
- `GET` and `DELETE`: 405.
- `OPTIONS`: 204 with CORS headers.

```sh
curl -s -X POST https://restoreworth.com/api/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nfip_claims_by_state","arguments":{"state":"TX"}}}'
```

With Claude Code: `claude mcp add --transport http restoreworth-fema https://restoreworth.com/api/mcp`

## Sources

Dates as returned by `list_sources`.

| File | Dataset | As of | Retrieved |
| --- | --- | --- | --- |
| NFIP paid building claims by state, 2020-2024 | [NFIP Redacted Claims - v3](https://www.fema.gov/openfema-data-page/nfip-redacted-claims-v3) | 2026-09-08 | 2026-10-03 |
| NFIP paid building claims by county, 2015-2024 | [NFIP Redacted Claims - v3](https://www.fema.gov/openfema-data-page/nfip-redacted-claims-v3) | 2026-09-09 | 2026-10-09 |
| Flood damage by interior water depth, 2015-2024 | [NFIP Redacted Claims - v3](https://www.fema.gov/openfema-data-page/nfip-redacted-claims-v3) | 2026-09-09 | 2026-10-09 |
| County profiles (339 counties) | OpenFEMA NfipClaims (as of 2026-09-09), DisasterDeclarationsSummaries, HousingAssistanceOwners, NfipCommunityStatusBook (as of 2026-10-11); BLS CPI-U annual averages 2005-2025 | see left | 2026-10-12 |

`data/sources/national_county2020.txt` is the [U.S. Census Bureau 2020 county file](https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt), used only to map a FIPS state prefix to its state.

FEMA notice:

> This product uses the Federal Emergency Management Agency’s OpenFEMA API, but is not endorsed by FEMA. The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the data have been retrieved from the Agency's website(s).

## Build and test

Node.js 20 or later, no npm dependency.

```sh
node build.mjs   # writes dist/api/mcp.js: mcp/handler.mjs with the files of data/ inlined
node --test      # runs test/mcp.test.mjs against a freshly generated bundle
```

`pages.json` lists the restoreworth.com pages the function links to. `dist/api/mcp.js` exports `POST`, `GET`, `OPTIONS` and `DELETE` (Web `Request` / `Response`), as a Vercel function expects. Nothing is fetched at run time.

## License

Code: MIT, see [LICENSE](LICENSE).
Data in `data/`: not covered by the MIT license; FEMA data is subject to the [OpenFEMA terms and conditions](https://www.fema.gov/about/openfema/terms-conditions).
The Census Bureau county file and the BLS CPI-U averages are U.S. Government works, in the public domain (17 U.S.C. § 105). The aggregates computed from these files carry no additional license.
