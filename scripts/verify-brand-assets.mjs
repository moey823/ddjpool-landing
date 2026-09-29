#!/usr/bin/env node
// Distributed by the DJP brand kit. No packages or network required.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function validateEmbeddedRegionId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`Invalid embedded brand region id: ${String(id)}`);
  }
  return id;
}

function regionMarkers(html, id) {
  if (typeof html !== 'string') throw new TypeError('Embedded HTML must be a string');
  validateEmbeddedRegionId(id);
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<!--\\s*djp-brand:${escapedId}:(start|end)\\s*-->`, 'g');
  const markers = [...html.matchAll(pattern)];
  if (markers.length !== 2 || markers[0][1] !== 'start' || markers[1][1] !== 'end') {
    throw new Error(`Expected exactly one ordered marker pair for djp-brand:${id}`);
  }
  const innerStart = markers[0].index + markers[0][0].length;
  const innerEnd = markers[1].index;
  if (innerEnd < innerStart) throw new Error(`Unordered markers for djp-brand:${id}`);
  return {
    regionStart: markers[0].index,
    innerStart,
    innerEnd,
    regionEnd: markers[1].index + markers[1][0].length,
  };
}

export function validateEmbeddedRegions(html, ids) {
  if (typeof html !== 'string') throw new TypeError('Embedded HTML must be a string');
  if (!Array.isArray(ids)) throw new TypeError('Embedded region ids must be an array');
  const seen = new Set();
  const regions = ids.map(id => {
    validateEmbeddedRegionId(id);
    if (seen.has(id)) throw new Error(`Duplicate embedded brand region id: ${id}`);
    seen.add(id);
    return { id, ...regionMarkers(html, id) };
  }).sort((a, b) => a.regionStart - b.regionStart);
  for (let index = 1; index < regions.length; index++) {
    const previous = regions[index - 1], current = regions[index];
    if (current.regionStart < previous.regionEnd) {
      throw new Error(`Overlapping embedded brand regions: ${previous.id} and ${current.id}`);
    }
  }
  return regions;
}

export function extractEmbeddedRegion(html, id) {
  const { innerStart, innerEnd } = regionMarkers(html, id);
  return html.slice(innerStart, innerEnd);
}

export function replaceEmbeddedRegion(html, id, inner) {
  if (typeof inner !== 'string') throw new TypeError('Embedded region content must be a string');
  const { innerStart, innerEnd } = regionMarkers(html, id);
  return html.slice(0, innerStart) + inner + html.slice(innerEnd);
}

export function normalizeEmbeddedRegion(html, id) {
  return replaceEmbeddedRegion(html, id, '');
}

export function normalizeEmbeddedRegions(html, ids) {
  validateEmbeddedRegions(html, ids);
  return ids.reduce((normalized, id) => normalizeEmbeddedRegion(normalized, id), html);
}

export async function verifyBrandAssets(root) {
  const receipt = JSON.parse(await readFile(resolve(root, '.brand-assets.json'), 'utf8'));
  if (receipt.schemaVersion !== 1 || !receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files) || !HASH_PATTERN.test(receipt.sourceHash)) throw new Error('Invalid brand receipt');
  const problems = [];
  const fileNames = new Set(Object.keys(receipt.files));
  for (const [name, expected] of Object.entries(receipt.files)) {
    const path = resolve(root, name), rel = relative(root, path);
    if (isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel) || !HASH_PATTERN.test(expected)) throw new Error(`Invalid receipt entry: ${name}`);
    const data = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!data || createHash('sha256').update(data).digest('hex') !== expected) problems.push(name);
  }

  const embedded = receipt.embedded ?? {};
  if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) throw new Error('Invalid embedded brand receipt');
  let embeddedCount = 0;
  for (const [name, regions] of Object.entries(embedded)) {
    const path = resolve(root, name), rel = relative(root, path);
    if (isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel) || fileNames.has(name) || !regions || typeof regions !== 'object' || Array.isArray(regions) || !Object.keys(regions).length) {
      throw new Error(`Invalid embedded receipt entry: ${name}`);
    }
    const data = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const html = data?.toString('utf8');
    const ids = Object.keys(regions);
    if (html) {
      try {
        validateEmbeddedRegions(html, ids);
      } catch {
        for (const id of ids) problems.push(`${name}#${id}`);
        embeddedCount += ids.length;
        continue;
      }
    }
    for (const [id, expected] of Object.entries(regions)) {
      validateEmbeddedRegionId(id);
      if (!HASH_PATTERN.test(expected)) throw new Error(`Invalid embedded receipt hash: ${name}#${id}`);
      embeddedCount++;
      if (!html) {
        problems.push(`${name}#${id}`);
        continue;
      }
      try {
        const region = extractEmbeddedRegion(html, id);
        const actual = createHash('sha256').update(region, 'utf8').digest('hex');
        if (actual !== expected) problems.push(`${name}#${id}`);
      } catch {
        problems.push(`${name}#${id}`);
      }
    }
  }
  return { problems, count: fileNames.size + embeddedCount, sourceHash: receipt.sourceHash };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyBrandAssets(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (result.problems.length) {
    console.error(`Brand asset drift: ${result.problems.join(', ')}. Edit the central brand kit and sync; do not hand-edit generated files.`);
    process.exitCode = 1;
  } else console.log(`Verified ${result.count} brand files from source ${result.sourceHash.slice(0, 12)}`);
}
