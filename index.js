import { syncClient, syncAll, getProducts, getCatalogSummary } from './2_worker_inventory.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Allow CORS for client portal
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /api/sync/:clientId — manually trigger an inventory sync
    if (request.method === 'POST' && url.pathname.startsWith('/api/sync/')) {
      const clientId = url.pathname.split('/')[3];
      const result = await syncClient(clientId, env);
      return Response.json(result, { headers: corsHeaders });
    }

    // GET /api/products/:clientId — get all products for the AI chatbot
    if (url.pathname.startsWith('/api/products/')) {
      const clientId = url.pathname.split('/')[3];
      const products = await getProducts(clientId, env);
      return Response.json(products, { headers: corsHeaders });
    }

    // GET /api/catalog-summary/:clientId — get a summary for dashboard display
    if (url.pathname.startsWith('/api/catalog-summary/')) {
      const clientId = url.pathname.split('/')[3];
      const summary = await getCatalogSummary(clientId, env);
      return Response.json(summary, { headers: corsHeaders });
    }

    return new Response('CannaFlow Inventory Worker', { status: 200 });
  },

  // Runs automatically every 15 minutes via cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};
