// Writes dist/api/mcp.js: one dependency-free function (Vercel Web handler) with the FEMA files of data/ inlined.
// pages.json lists the restoreworth.com pages the deployed function cites; a page not listed is never linked.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mcpBundle } from './mcp/data.mjs';

const pages = JSON.parse(readFileSync(new URL('./pages.json', import.meta.url), 'utf8'));
mkdirSync(new URL('./dist/api/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/api/mcp.js', import.meta.url), mcpBundle({ origin: 'https://restoreworth.com', pages }));
console.log('dist/api/mcp.js written.');
