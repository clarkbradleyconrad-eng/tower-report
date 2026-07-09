/**
 * Tower Report bots — repo file access
 *
 * Serverless functions read repo files (registry, prompts, data/*.json)
 * from the function bundle when vercel.json includeFiles covers them, and
 * fall back to the deployed static site otherwise — bots/ and data/ are
 * public static assets, so the fallback always works in production.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function baseUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || 'tower-report.vercel.app';
  return `https://${host}`;
}

export async function readRepoText(rel) {
  try {
    return await readFile(path.join(process.cwd(), rel), 'utf8');
  } catch {
    try {
      const res = await fetch(`${baseUrl()}/${rel}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.text();
    } catch { return null; }
  }
}

export async function readRepoJson(rel) {
  const text = await readRepoText(rel);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
