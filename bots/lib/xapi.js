/**
 * Tower Report — X (Twitter) API v2 client
 *
 * OAuth 1.0a signing for POST /2/tweets.
 * Env vars required:
 *   X_API_KEY            — consumer key
 *   X_API_SECRET         — consumer secret
 *   X_ACCESS_TOKEN       — access token (your account, write access)
 *   X_ACCESS_TOKEN_SECRET
 */

import { createHmac } from 'node:crypto';

function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function xCreds() {
  return {
    apiKey: process.env.X_API_KEY || '',
    apiSecret: process.env.X_API_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || '',
  };
}

export function credsOk(c) {
  return !!(c.apiKey && c.apiSecret && c.accessToken && c.accessTokenSecret);
}

function oauthHeader(method, url, creds) {
  const o = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: Date.now().toString(36) + Math.random().toString(36).slice(2),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  // JSON body: body params NOT included in signature base string
  const paramStr = Object.keys(o).sort().map(k => pct(k) + '=' + pct(o[k])).join('&');
  const base = [method.toUpperCase(), pct(url), pct(paramStr)].join('&');
  const key = pct(creds.apiSecret) + '&' + pct(creds.accessTokenSecret);
  o.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(o).sort().map(k => pct(k) + '="' + pct(o[k]) + '"').join(', ');
}

/**
 * Post a tweet. Returns the X API response data.
 * Throws on API error — caller decides whether to retry or log.
 */
export async function postTweet(text, creds) {
  const url = 'https://api.twitter.com/2/tweets';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader('POST', url, creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: String(text).slice(0, 280) }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X API ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}
