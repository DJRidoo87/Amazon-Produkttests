// Holt Preise über die offizielle Amazon Product Advertising API (PA-API 5.0)
// und schreibt sie sortiert nach prozentualer Ersparnis in deals.json.
//
// Echt:   AMAZON_ACCESS_KEY=... AMAZON_SECRET_KEY=... AMAZON_PARTNER_TAG=... node fetch-deals.mjs
// Test:   node fetch-deals.mjs --mock      (erzeugt Beispieldaten ohne Zugangsdaten)
//
// Benötigt Node 18 oder neuer, keine zusätzlichen Pakete.

import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const MOCK = process.argv.includes('--mock');
const { AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, AMAZON_PARTNER_TAG } = process.env;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// --- Signatur (AWS Signature Version 4) ---------------------------------
async function searchItems(search) {
  const target = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';
  const path = '/paapi5/searchitems';
  const service = 'ProductAdvertisingAPI';

  const body = JSON.stringify({
    Keywords: search.keywords,
    SearchIndex: search.searchIndex,
    ItemCount: config.itemsPerSearch,
    PartnerTag: AMAZON_PARTNER_TAG,
    PartnerType: 'Associates',
    Marketplace: config.marketplace,
    Resources: [
      'ItemInfo.Title',
      'Images.Primary.Medium',
      'Offers.Listings.Price',
      'Offers.Listings.SavingBasis',
    ],
  });

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${config.host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';

  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = `${dateStamp}/${config.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const kDate = hmac('AWS4' + AMAZON_SECRET_KEY, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const res = await fetch(`https://${config.host}${path}`, {
    method: 'POST',
    headers: {
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=utf-8',
      'x-amz-date': amzDate,
      'x-amz-target': target,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${AMAZON_ACCESS_KEY}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });

  if (!res.ok) throw new Error(`API-Fehler ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.SearchResult?.Items ?? [];
}

function toDeal(item, category) {
  const listing = item.Offers?.Listings?.[0];
  const price = listing?.Price?.Amount;
  const basis = listing?.SavingBasis?.Amount;
  if (!price || !basis || basis <= price) return null; // nur echte Preissenkungen

  const percent = listing.Price.Savings?.Percentage ?? Math.round(((basis - price) / basis) * 100);
  return {
    asin: item.ASIN,
    title: item.ItemInfo?.Title?.DisplayValue ?? item.ASIN,
    category,
    price,
    originalPrice: basis,
    currency: listing.Price.Currency ?? 'EUR',
    percent,
    image: item.Images?.Primary?.Medium?.URL ?? null,
    url: item.DetailPageURL,
  };
}

// --- Beispieldaten für den Test ohne Zugang -----------------------------
function mockDeals() {
  const samples = [
    ['Handyzubehör', 'Beispiel: Schutzglas-Set', 7.99, 19.99],
    ['Handyzubehör', 'Beispiel: Magnet-Ladekabel 2 m', 12.49, 16.99],
    ['Küche', 'Beispiel: Edelstahl-Pfannenset', 39.9, 89.9],
    ['Küche', 'Beispiel: Messerblock 6-teilig', 24.9, 34.9],
    ['Technik', 'Beispiel: Bluetooth-Kopfhörer', 29.99, 59.99],
    ['Technik', 'Beispiel: Powerbank 20.000 mAh', 21.99, 27.99],
  ];
  return samples.map(([category, title, price, originalPrice], i) => ({
    asin: `BEISPIEL${i + 1}`,
    title,
    category,
    price,
    originalPrice,
    currency: 'EUR',
    percent: Math.round(((originalPrice - price) / originalPrice) * 100),
    image: null,
    url: '#',
  }));
}

// --- Hauptablauf ---------------------------------------------------------
let deals = [];

if (MOCK) {
  deals = mockDeals();
} else {
  if (!AMAZON_ACCESS_KEY || !AMAZON_SECRET_KEY || !AMAZON_PARTNER_TAG) {
    console.error('Bitte AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY und AMAZON_PARTNER_TAG setzen (oder --mock nutzen).');
    process.exit(1);
  }
  for (const search of config.searches) {
    try {
      const items = await searchItems(search);
      for (const item of items) {
        const deal = toDeal(item, search.label);
        if (deal) deals.push(deal);
      }
      console.log(`${search.label}: ${items.length} Treffer`);
    } catch (err) {
      console.error(`${search.label}: ${err.message}`);
    }
    await sleep(1100); // die API erlaubt anfangs nur ca. 1 Anfrage pro Sekunde
  }
}

deals = deals
  .filter((d) => d.percent >= config.minSavingPercent)
  .sort((a, b) => b.percent - a.percent);

await writeFile(
  new URL('./deals.json', import.meta.url),
  JSON.stringify({ updatedAt: new Date().toISOString(), mock: MOCK, deals }, null, 2),
);
console.log(`${deals.length} Angebote in deals.json gespeichert${MOCK ? ' (Beispieldaten)' : ''}.`);
