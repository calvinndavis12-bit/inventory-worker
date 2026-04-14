import { syncClient, syncAll, getProducts, getCatalogSummary } from './2_worker_inventory.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function supa(env) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return {
    async get(table, eq = {}) {
      const qs = Object.entries(eq).map(([k,v]) => `${k}=eq.${v}`).join('&');
      const r = await fetch(`${url}/rest/v1/${table}?select=*${qs ? '&'+qs : ''}`, { headers: h });
      if (!r.ok) throw new Error(`Supabase GET ${table}: ${r.status} ${await r.text()}`);
      return r.json();
    },
    async insert(table, body) {
      const r = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`Supabase POST ${table}: ${r.status} ${await r.text()}`);
    },
  };
}

function buildInventoryContext(products) {
  if (!products.length) return 'No products currently in stock.';
  const byCategory = {};
  for (const p of products) {
    const cat = p.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }
  return Object.entries(byCategory).map(([cat, items]) => {
    const list = items.slice(0, 12).map(p => {
      const parts = [];
      if (p.price > 0) parts.push(`$${p.price}`);
      if (p.thc)       parts.push(`${p.thc}%THC`);
      if (p.strain_type) parts.push(p.strain_type);
      return `${p.id}|${p.name}${parts.length ? ' ('+parts.join(',')+')' : ''}`;
    });
    return `[${cat.toUpperCase()}]\n${list.join('\n')}`;
  }).join('\n\n');
}

async function handleChat(clientId, body, env) {
  const db = supa(env);

  const [clients, products] = await Promise.all([
    db.get('clients', { id: clientId }),
    db.get('menu_items', { client_id: clientId }),
  ]);

  const client = clients?.[0];
  if (!client) return { message: "Sorry, I couldn't find this dispensary.", products: [] };

  const inStock = (products || []).filter(p => p.in_stock !== false);
  const inventoryCtx = buildInventoryContext(inStock);

  const systemPrompt =
`You are a friendly AI budtender for ${client.name || 'this dispensary'}.
Keep EVERY response to 1 sentence only — short, direct, warm. No lists. No paragraphs. One sentence max.
Never give medical advice. Customers must be 21+ to purchase.

CURRENT IN-STOCK INVENTORY (${inStock.length} products):
${inventoryCtx}

CRITICAL — respond ONLY with valid JSON, no markdown, no extra text:
{"message":"Your single sentence reply here","productIds":["exact_product_id_1","exact_product_id_2"]}

When not recommending products: {"message":"Your reply","productIds":[]}
Product IDs are the value before | in each inventory line. Use exact IDs only.`;

  const { message, history = [] } = body;

  const messages = [
    ...(history || []).filter(m => m.role && m.content).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemPrompt,
      messages,
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.text();
    throw new Error(`Claude API ${claudeRes.status}: ${err}`);
  }

  const claudeData = await claudeRes.json();
  const rawText = claudeData.content?.[0]?.text || '{"message":"Sorry, try again!","productIds":[]}';

  let parsed = { message: '', productIds: [] };
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch?.[0] || rawText);
  } catch {
    parsed = { message: rawText.replace(/^[^a-zA-Z]*/, '').slice(0, 200), productIds: [] };
  }

  const recommended = (parsed.productIds || [])
    .map(id => inStock.find(p => p.id === id || p.source_id === String(id)))
    .filter(Boolean)
    .slice(0, 5);

  return {
    message: (parsed.message || '').trim(),
    products: recommended,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {

      if (request.method === 'GET' && url.pathname.startsWith('/api/config/')) {
        const clientId = url.pathname.split('/')[3];
        const db = supa(env);
        const rows = await db.get('clients', { id: clientId });
        const client = rows?.[0];
        if (!client) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
        return Response.json({
          name:        client.name        || 'Your Dispensary',
          botName:     client.bot_name    || 'Budtender AI',
          accentColor: client.accent_color || '#2d6a4f',
          orderUrl:    client.order_url   || client.website_url || '#',
          emoji:       client.bot_emoji   || '🌿',
        }, { headers: corsHeaders });
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/chat/')) {
        const clientId = url.pathname.split('/')[3];
        const body = await request.json();
        const result = await handleChat(clientId, body, env);
        return Response.json(result, { headers: corsHeaders });
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/lead/')) {
        const clientId = url.pathname.split('/')[3];
        const { name, email, phone, source, url: pageUrl } = await request.json();
        if (!email && !phone) return Response.json({ error: 'email or phone required' }, { status: 400, headers: corsHeaders });
        const db = supa(env);
        await db.insert('leads', {
          client_id: clientId,
          name: name || null,
          email: email || null,
          phone: phone || null,
          source: source || 'chat_widget',
          page_url: pageUrl || null,
        });
        return Response.json({ success: true }, { headers: corsHeaders });
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/sync/')) {
        const clientId = url.pathname.split('/')[3];
        const result = await syncClient(clientId, env);
        return Response.json(result, { headers: corsHeaders });
      }

      if (url.pathname.startsWith('/api/products/')) {
        const clientId = url.pathname.split('/')[3];
        const products = await getProducts(clientId, env);
        return Response.json(products, { headers: corsHeaders });
      }

      if (url.pathname.startsWith('/api/catalog-summary/')) {
        const clientId = url.pathname.split('/')[3];
        const summary = await getCatalogSummary(clientId, env);
        return Response.json(summary, { headers: corsHeaders });
      }

      if (url.pathname.startsWith('/api/debug/')) {
        const clientId = url.pathname.split('/')[3];
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/clients?select=*&id=eq.${clientId}`, {
          headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
        });
        return Response.json({ httpStatus: res.status, rows: await res.json() }, { headers: corsHeaders });
      }

      return new Response('CannaFlow Worker', { status: 200, headers: corsHeaders });

    } catch (err) {
      return Response.json(
        { error: err.message || 'Internal server error' },
        { status: 500, headers: corsHeaders }
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};
