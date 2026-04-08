/**
 * CannaFlow — Inventory Sync for Cloudflare Workers
 *
 * HOW TO USE:
 * Add this file to your existing worker project, then add
 * the routes and cron handler to your main worker entry point
 * (see the comments at the bottom of this file).
 *
 * Add these secrets to your worker via Wrangler CLI:
 *   npx wrangler secret put SUPABASE_URL
 *   npx wrangler secret put SUPABASE_SERVICE_KEY   ← NOT the anon key
 *
 * Add this to your wrangler.toml for auto-sync every 15 min:
 *   [triggers]
 *   crons = ["*\/15 * * * *"]
 */

// ── Normalized category map ───────────────────────────────────────────────────

const CATEGORY_MAP = {
  flower: 'flower', bud: 'flower', herb: 'flower', cannabis: 'flower',
  'pre-roll': 'pre-roll', preroll: 'pre-roll', joint: 'pre-roll', blunt: 'pre-roll',
  vape: 'vape', cartridge: 'vape', cart: 'vape', disposable: 'vape', pod: 'vape',
  concentrate: 'concentrate', wax: 'concentrate', shatter: 'concentrate',
  resin: 'concentrate', rosin: 'concentrate', hash: 'concentrate', dab: 'concentrate',
  edible: 'edible', edibles: 'edible', gummy: 'edible', gummies: 'edible',
  chocolate: 'edible', beverage: 'edible', capsule: 'edible', candy: 'edible',
  tincture: 'tincture', tinctures: 'tincture', oil: 'tincture', drops: 'tincture',
  topical: 'topical', topicals: 'topical', cream: 'topical', balm: 'topical',
  cbd: 'cbd', accessory: 'accessory', accessories: 'accessory',
};

function normalizeCategory(raw) {
  if (!raw) return 'other';
  return CATEGORY_MAP[raw.toLowerCase().trim()] || 'other';
}

// ── Supabase client (Workers-compatible, no npm needed) ───────────────────────

function makeSupabase(url, key) {
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  async function query(table, options = {}) {
    let endpoint = `${url}/rest/v1/${table}`;
    const params = new URLSearchParams();

    if (options.select)  params.set('select', options.select);
    if (options.eq)      Object.entries(options.eq).forEach(([k, v]) => params.set(k, `eq.${v}`));
    if (options.order)   params.set('order', options.order);
    if (options.limit)   params.set('limit', options.limit);

    const qs = params.toString();
    if (qs) endpoint += '?' + qs;

    const res = await fetch(endpoint, {
      method: options.method || 'GET',
      headers: {
        ...headers,
        ...(options.method === 'POST' || options.method === 'PATCH'
          ? { 'Prefer': options.upsert ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal' }
          : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase ${options.method || 'GET'} ${table}: ${res.status} ${text}`);
    }

    return (!options.method || options.method === 'GET') ? res.json() : null;
  }

  return {
    from: (table) => ({
      select:  (cols = '*') => query(table, { select: cols }),
      selectWhere: (cols, eq) => query(table, { select: cols, eq }),
      insert:  (body) => query(table, { method: 'POST', body }),
      upsert:  (body) => query(table, { method: 'POST', body, upsert: true,
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' } }),
      patch:   (eq, body) => query(table, { method: 'PATCH', eq, body }),
    }),
  };
}

// ── Dutchie POS Adapter (Workers-compatible) ──────────────────────────────────

const DUTCHIE_BASE = 'https://api.pos.dutchie.com';

function dutchieAuth(apiKey) {
  // Workers have btoa() built in — no Buffer needed
  return 'Basic ' + btoa(apiKey + ':');
}

async function dutchieGet(path, apiKey) {
  const res = await fetch(`${DUTCHIE_BASE}${path}`, {
    headers: { Authorization: dutchieAuth(apiKey), Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Dutchie ${path}: ${res.status}`);
  return res.json();
}

async function fetchDutchieInventory(apiKey) {
  // Fetch products + inventory levels in parallel
  const [rawProducts, inventoryRaw] = await Promise.allSettled([
    dutchieGet('/products', apiKey),
    dutchieGet('/reporting/inventory', apiKey),
  ]);

  const products = rawProducts.status === 'fulfilled'
    ? (Array.isArray(rawProducts.value) ? rawProducts.value : rawProducts.value?.data || [])
    : [];

  // Build quantity map (falls back gracefully if Reporting scope not granted)
  const qtyMap = new Map();
  if (inventoryRaw.status === 'fulfilled') {
    const inv = Array.isArray(inventoryRaw.value)
      ? inventoryRaw.value
      : inventoryRaw.value?.data || [];
    inv.forEach(i => qtyMap.set(String(i.productId || i.id), i.quantityOnHand ?? i.quantity ?? -1));
  }

  return products.map(p => {
    const sourceId = String(p.productId || p.id || '');
    const qty = qtyMap.get(sourceId) ?? -1;
    const variants = (p.pricing || p.weights || []).map(w => ({
      weight: w.weight ?? null, unit: w.unit || 'g',
      price: w.price ?? 0, quantity: -1,
    }));
    const basePrice = variants.length
      ? Math.min(...variants.map(v => v.price).filter(Boolean))
      : (p.price ?? 0);
    const st = (p.strainType || '').toLowerCase();

    return {
      id: `dutchie_${sourceId}`,
      source_id: sourceId,
      name: p.name || p.productName || 'Unnamed',
      brand: p.brandName || p.brand || '',
      category: normalizeCategory(p.category || p.type || ''),
      subcategory: p.subcategory || p.productType || '',
      description: p.description || '',
      price: basePrice,
      in_stock: qty !== 0,
      quantity: qty,
      thc: parseFloat(p.thcPercentage || p.thc || 0) || null,
      cbd: parseFloat(p.cbdPercentage || p.cbd || 0) || null,
      strain_type: ['indica','sativa','hybrid'].includes(st) ? st : null,
      effects: p.effects || [],
      images: (p.images || []).map(i => i.url || i),
      variants,
      source: 'dutchie',
    };
  });
}

// ── Smart Scraper (Workers-compatible, no cheerio) ────────────────────────────

async function detectAndScrape(websiteUrl) {
  const res = await fetch(websiteUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CannaFlowBot/1.0)' },
    signal: AbortSignal.timeout(12_000),
  });
  const html = await res.text();

  // Check for Dutchie embedded menu
  const dutchieSlug = (html.match(/dutchie\.com\/embedded-menu\/([a-z0-9-]+)/i)
    || html.match(/"dispensary[Ss]lug"\s*:\s*"([a-z0-9-]+)"/i))?.[1];

  if (dutchieSlug) {
    return { products: await fetchDutchieEmbedMenu(dutchieSlug), platform: 'dutchie_embed' };
  }

  // Check for Jane / iHeartJane — prefer URL-based match (more reliable than generic storeId)
  const janeUrlMatch = html.match(/iheartjane\.com[^"'<\s]*?\/stores?\/(\d+)/i);
  // Only fall back to storeId JSON if it's clearly inside a Jane-related context
  const janeCtxMatch = html.match(/iheartjane[^}]{0,300}?['"](storeId|store_id)['"]\s*:\s*['""]?(\d+)/is);
  const janeId = janeUrlMatch?.[1] || janeCtxMatch?.[2];

  if (janeId) {
    console.log(`[Scraper] Detected Jane store ID: ${janeId} from ${websiteUrl}`);
    return { products: await fetchJaneMenu(janeId), platform: 'jane' };
  }

  // Generic HTML parse using regex (no cheerio in Workers)
  return { products: scrapeHtmlProducts(html, websiteUrl), platform: 'generic_html' };
}

async function fetchDutchieEmbedMenu(slug) {
  const query = `query M($s:String!){dispensaryMenu(dispensarySlug:$s,pricingType:RECREATIONAL){products{id name brandName category description strainType thcPercentage cbdPercentage images{url} effects pricing{weight unit price}}}}`;
  const res = await fetch('https://dutchie.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { s: slug } }),
  });
  const json = await res.json();
  const raw = json?.data?.dispensaryMenu?.products || [];

  return raw.map(p => {
    const st = (p.strainType || '').toLowerCase();
    const variants = (p.pricing || []).map(w => ({ weight: w.weight, unit: w.unit || 'g', price: w.price, quantity: -1 }));
    return {
      id: `embed_${p.id}`,
      source_id: String(p.id),
      name: p.name || '',
      brand: p.brandName || '',
      category: normalizeCategory(p.category),
      description: p.description || '',
      price: variants.length ? Math.min(...variants.map(v => v.price).filter(Boolean)) : 0,
      in_stock: true,
      quantity: -1,
      thc: p.thcPercentage ? parseFloat(p.thcPercentage) : null,
      cbd: p.cbdPercentage ? parseFloat(p.cbdPercentage) : null,
      strain_type: ['indica','sativa','hybrid'].includes(st) ? st : null,
      effects: p.effects || [],
      images: (p.images || []).map(i => i.url || i),
      variants,
      source: 'scraper',
    };
  });
}

async function fetchJaneMenu(storeId) {
  // Jane's API has evolved — try known endpoints in order
  const endpoints = [
    `https://api.iheartjane.com/v1/stores/${storeId}/menu-products?page=1&per_page=500`,
    `https://api.iheartjane.com/v2/stores/${storeId}/products?per_page=500`,
    `https://api.iheartjane.com/v1/stores/${storeId}/menu`,
  ];

  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; CannaFlowBot/1.0)',
    'Accept': 'application/json',
  };

  let lastStatus = null;
  for (const url of endpoints) {
    const res = await fetch(url, { headers: reqHeaders });
    console.log(`[Jane] ${url} → ${res.status}`);
    if (res.ok) {
      const json = await res.json();
      // Handle different response shapes across API versions
      const raw = json?.data?.products || json?.menu_products || json?.products || json?.data || [];
      return Array.isArray(raw) ? raw.map(p => ({
        id: `jane_${p.id || p.product_id}`,
        source_id: String(p.id || p.product_id),
        name: p.name || p.product_name || '',
        brand: p.brand || p.brand_name || '',
        category: normalizeCategory(p.kind || p.category || ''),
        description: p.description || '',
        price: p.price_each ?? p.price ?? 0,
        in_stock: p.available !== false,
        quantity: p.available_count ?? -1,
        thc: p.percent_thc ? parseFloat(p.percent_thc) : null,
        cbd: p.percent_cbd ? parseFloat(p.percent_cbd) : null,
        strain_type: p.kind || null,
        effects: p.activities || [],
        images: p.image ? [p.image] : [],
        variants: [],
        source: 'scraper',
      })) : [];
    }
    lastStatus = res.status;
  }
  throw new Error(`Jane API: all endpoints returned ${lastStatus} for store ${storeId}`);
}

function scrapeHtmlProducts(html, siteUrl) {
  // Regex-based extraction — works without cheerio in Workers
  const products = [];
  // Find JSON-LD product data (many modern dispensary sites include this)
  const jsonLdMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Product' || item['@type'] === 'ItemList') {
          const list = item['@type'] === 'ItemList'
            ? (item.itemListElement || []).map(e => e.item || e)
            : [item];
          list.forEach((p, i) => {
            if (!p.name) return;
            products.push({
              id: `scrape_${Buffer ? Buffer.from(p.name).toString('base64').slice(0,12) : btoa(p.name).slice(0,12)}_${i}`,
              source_id: p.sku || p.name,
              name: p.name,
              brand: p.brand?.name || '',
              category: normalizeCategory(p.category || ''),
              description: p.description || '',
              price: parseFloat(p.offers?.price || p.offers?.[0]?.price || 0) || 0,
              in_stock: p.offers?.availability !== 'OutOfStock',
              quantity: -1,
              thc: null, cbd: null, strain_type: null,
              effects: [], images: p.image ? [p.image] : [],
              variants: [],
              source: 'scraper',
            });
          });
        }
      }
    } catch {}
  }

  if (products.length > 0) return products;

  // Last resort: find price patterns near product-like text blocks
  const pricePattern = /\$(\d+(?:\.\d{2})?)/g;
  const prices = [...html.matchAll(pricePattern)].map(m => parseFloat(m[1]));
  if (prices.length === 0) return [];

  // Log a warning — site needs manual config or Dutchie embed
  console.warn(`[Scraper] Could not extract structured data from ${siteUrl} — manual products needed`);
  return [];
}

// ── Core Sync Function ────────────────────────────────────────────────────────

export async function syncClient(clientId, env) {
  const supa = makeSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  // Get client config
  const clients = await supa.from('clients').selectWhere(
    '*',
    { id: clientId }
  );
  const client = clients?.[0];
  if (!client || !client.sync_enabled) return { status: 'skipped', reason: 'disabled' };

  const startedAt = Date.now();

  // Update status to 'syncing'
  await supa.from('sync_status').upsert({
    client_id: clientId, status: 'syncing', error: null,
  });

  try {
    let products = [];
    let platform = client.inventory_source || 'manual';

    if (client.inventory_source === 'dutchie' && client.dutchie_api_key) {
      products = await fetchDutchieInventory(client.dutchie_api_key);
      platform = 'dutchie';
    } else if (client.inventory_source === 'scraper' && client.website_url) {
      const result = await detectAndScrape(client.website_url);
      products = result.products;
      platform = result.platform;
    }

    if (products.length === 0 && client.inventory_source !== 'manual') {
      throw new Error('Sync returned 0 products — check URL or API key');
    }

    // Upsert all products into Supabase
    if (products.length > 0) {
      const rows = products.map(p => ({ ...p, client_id: clientId, last_synced_at: new Date().toISOString() }));

      // Supabase upsert in batches of 200
      for (let i = 0; i < rows.length; i += 200) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/menu_items`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(rows.slice(i, i + 200)),
        });
      }

      // Delete products no longer in feed
      const currentIds = products.map(p => p.id);
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/menu_items?client_id=eq.${clientId}&id=not.in.(${currentIds.map(id => `"${id}"`).join(',')})`,
        {
          method: 'DELETE',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          },
        }
      );
    }

    const inStock = products.filter(p => p.in_stock).length;
    const duration = Date.now() - startedAt;

    await supa.from('sync_status').upsert({
      client_id: clientId,
      status: 'success',
      platform,
      product_count: products.length,
      in_stock_count: inStock,
      last_synced_at: new Date().toISOString(),
      error: null,
      duration_ms: duration,
    });

    console.log(`[Sync] ✓ ${client.name}: ${products.length} products (${platform}) in ${duration}ms`);
    return { status: 'success', clientId, productCount: products.length, platform };

  } catch (err) {
    await supa.from('sync_status').upsert({
      client_id: clientId,
      status: 'error',
      error: err.message,
    });
    console.error(`[Sync] ✗ ${client.name || clientId}: ${err.message}`);
    return { status: 'error', clientId, error: err.message };
  }
}

export async function syncAll(env) {
  const supa = makeSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const clients = await supa.from('clients').selectWhere('id', { sync_enabled: true });
  if (!clients?.length) return [];

  // Run all syncs in parallel (Workers handles concurrency fine)
  const results = await Promise.allSettled(clients.map(c => syncClient(c.id, env)));
  return results.map(r => r.value || { status: 'error', error: r.reason?.message });
}

export async function getProducts(clientId, env, filters = {}) {
  const supa = makeSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  let products = await supa.from('menu_items').selectWhere('*', { client_id: clientId });

  if (filters.inStockOnly !== false) products = products.filter(p => p.in_stock);
  if (filters.category) products = products.filter(p => p.category === filters.category);
  if (filters.strainType) products = products.filter(p => p.strain_type === filters.strainType);
  if (filters.maxPrice) products = products.filter(p => p.price <= filters.maxPrice);
  if (filters.query) {
    const q = filters.query.toLowerCase();
    products = products.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q) ||
      p.brand?.toLowerCase().includes(q)
    );
  }
  return products;
}

// Compact summary for your AI system prompt
export async function getCatalogSummary(clientId, env) {
  const products = await getProducts(clientId, env);
  const byCategory = {};
  for (const p of products) {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  }
  return Object.entries(byCategory).map(([cat, items]) => {
    const summaries = items.slice(0, 8).map(p => {
      const parts = [p.name];
      if (p.price > 0) parts.push(`$${p.price}`);
      if (p.thc)       parts.push(`${p.thc}% THC`);
      if (p.strain_type) parts.push(p.strain_type);
      return `${p.name} (${parts.slice(1).join(', ')})`;
    });
    return `${cat.toUpperCase()}: ${summaries.join('; ')}${items.length > 8 ? ` +${items.length-8} more` : ''}`;
  }).join('\n');
}

// ── HOW TO ADD THIS TO YOUR EXISTING WORKER ──────────────────────────────────
//
// In your main worker file (e.g. index.js or worker.js), add:
//
// import { syncClient, syncAll, getProducts, getCatalogSummary } from './worker_inventory.js';
//
// export default {
//   // Your existing fetch handler — just add these routes:
//   async fetch(request, env, ctx) {
//     const url = new URL(request.url);
//
//     // POST /api/sync/:clientId  — trigger sync from your admin dashboard
//     if (request.method === 'POST' && url.pathname.startsWith('/api/sync/')) {
//       const clientId = url.pathname.split('/')[3];
//       const result = await syncClient(clientId, env);
//       return Response.json(result);
//     }
//
//     // GET /api/products/:clientId  — chatbot reads inventory
//     if (url.pathname.startsWith('/api/products/')) {
//       const clientId = url.pathname.split('/')[3];
//       const filters = Object.fromEntries(url.searchParams);
//       const products = await getProducts(clientId, env, filters);
//       return Response.json(products);
//     }
//
//     // GET /api/catalog-summary/:clientId  — compact AI system prompt
//     if (url.pathname.startsWith('/api/catalog-summary/')) {
//       const clientId = url.pathname.split('/')[3];
//       const summary = await getCatalogSummary(clientId, env);
//       return Response.json({ summary });
//     }
//
//     // ... rest of your existing routes
//   },
//
//   // Cron trigger — runs every 15 min automatically
//   async scheduled(event, env, ctx) {
//     ctx.waitUntil(syncAll(env));
//   },
// };
//
// Then add to wrangler.toml:
//   [triggers]
//   crons = ["*\/15 * * * *"]
//
// And add secrets:
//   npx wrangler secret put SUPABASE_URL
//   npx wrangler secret put SUPABASE_SERVICE_KEY
