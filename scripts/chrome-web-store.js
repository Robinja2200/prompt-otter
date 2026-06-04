#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const requiredEnv = [
  'CHROME_CLIENT_ID',
  'CHROME_CLIENT_SECRET',
  'CHROME_REFRESH_TOKEN',
  'CHROME_PUBLISHER_ID',
  'CHROME_EXTENSION_ID',
];

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    throw new Error('Usage: node scripts/chrome-web-store.js <extension.zip>');
  }

  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing Chrome Web Store environment variables: ${missing.join(', ')}`);
  }

  const absoluteZipPath = path.resolve(zipPath);
  const zip = fs.readFileSync(absoluteZipPath);
  const token = await getAccessToken();
  await uploadZip(token, zip);
  await publish(token);
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.CHROME_CLIENT_ID,
    client_secret: process.env.CHROME_CLIENT_SECRET,
    refresh_token: process.env.CHROME_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Chrome OAuth token request failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function uploadZip(token, zip) {
  const url = chromeUrl('upload');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: zip,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chrome upload failed: ${response.status} ${JSON.stringify(json)}`);
  }
  console.log(`Chrome upload status: ${JSON.stringify(json)}`);
}

async function publish(token) {
  const url = chromeUrl('publish');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chrome publish failed: ${response.status} ${JSON.stringify(json)}`);
  }
  console.log(`Chrome publish status: ${JSON.stringify(json)}`);
}

function chromeUrl(action) {
  const publisherId = encodeURIComponent(process.env.CHROME_PUBLISHER_ID);
  const extensionId = encodeURIComponent(process.env.CHROME_EXTENSION_ID);
  if (action === 'upload') {
    return `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisherId}/items/${extensionId}:upload`;
  }
  return `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:publish`;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
