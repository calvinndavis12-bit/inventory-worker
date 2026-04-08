/**
 * CannaFlow AI Widget — v1.0
 * Embeddable cannabis dispensary chatbot.
 *
 * Usage:
 *   <script src="https://portal.gocannaflow.com/widget.js"
 *           data-client="YOUR_CLIENT_ID" async></script>
 *
 * Optional:
 *   data-worker="https://inventory-worker.calvinndavis12.workers.dev"
 */

(function () {
  'use strict';

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  const script = document.currentScript || document.querySelector('script[data-client]');
  const CLIENT_ID  = script?.getAttribute('data-client') || '';
  const WORKER_URL = (script?.getAttribute('data-worker') || 'https://inventory-worker.calvinndavis12.workers.dev').replace(/\/$/, '');

  if (!CLIENT_ID) { console.warn('[CannaFlow] Missing data-client on script tag'); return; }
  if (document.getElementById('cf-btn')) return; // prevent double init

  // ── State ─────────────────────────────────────────────────────────────────
  let cfg = { name: 'Your Dispensary', accentColor: '#2d6a4f', botName: 'Budtender AI', orderUrl: '#', emoji: '🌿' };
  let panelOpen = false, isLoading = false;
  let convo = [];          // Claude conversation history [{role, content}]
  let quizAnswers = {};
  let quizStep = 0;        // 0=not started, 1–3=in progress, 99=complete
  let leadDone = false;

  // ── Quiz steps ─────────────────────────────────────────────────────────────
  const QUIZ = [
    { k: 'effect',
      q: "Hey! 👋 I'm your AI budtender. What are you looking for today?",
      o: ['😌 Relax & Unwind', '⚡ Creative Energy', '😴 Help Sleeping', '😊 Social & Euphoric', '🌿 Pain / Stress Relief', '🤷 Just browsing'] },
    { k: 'experience',
      q: "What's your experience level with cannabis?",
      o: ['🌱 New to it', '🙂 Occasional user', '💪 Regular user'] },
    { k: 'type',
      q: "Any preference on product type?",
      o: ['🌸 Flower', '🍬 Edibles', '💨 Vapes', '🍯 Concentrates', '🎲 No preference'] },
  ];

  // ── CSS ────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
:root { --cf-a:#2d6a4f; --cf-al:#52b788; --cf-ap:rgba(45,106,79,.15); }
#cf-widget *, #cf-widget *::before, #cf-widget *::after { box-sizing:border-box; margin:0; padding:0; }
#cf-widget button { cursor:pointer; border:none; background:none; font-family:inherit; }
#cf-widget input  { font-family:inherit; border:none; outline:none; background:none; }
#cf-widget a      { text-decoration:none; }

/* BUBBLE */
#cf-btn {
  position:fixed; bottom:calc(20px + env(safe-area-inset-bottom,0px)); right:20px;
  width:58px; height:58px; border-radius:50%; z-index:99998;
  background:linear-gradient(135deg,var(--cf-a),#1b4332);
  box-shadow:0 4px 20px rgba(0,0,0,.45),0 0 0 3px var(--cf-ap);
  display:flex; align-items:center; justify-content:center;
  transition:transform .2s,box-shadow .2s; -webkit-tap-highlight-color:transparent;
}
#cf-btn:hover  { transform:scale(1.06); }
#cf-btn:active { transform:scale(.94); }
#cf-btn.open   { background:#1e1e1e; }
#cf-btn .ico-o { font-size:24px; }
#cf-btn .ico-c { font-size:20px; color:#888; display:none; }
#cf-btn.open .ico-o { display:none; }
#cf-btn.open .ico-c { display:block; }
@keyframes cf-pulse { 0%{transform:scale(.9);opacity:.8}70%{transform:scale(1.6);opacity:0}100%{transform:scale(1.6);opacity:0} }
#cf-btn::before { content:''; position:absolute; width:100%; height:100%; border-radius:50%; border:2px solid var(--cf-a); animation:cf-pulse 2s ease-out 1.2s infinite; pointer-events:none; }
#cf-btn.seen::before { animation:none; }

/* VEIL */
#cf-veil { position:fixed; inset:0; background:rgba(0,0,0,.55); backdrop-filter:blur(3px); z-index:99998; opacity:0; pointer-events:none; transition:opacity .3s; }
#cf-veil.on { opacity:1; pointer-events:all; }

/* PANEL */
#cf-box {
  position:fixed; z-index:99999; display:flex; flex-direction:column;
  background:#141414; border:1px solid #2a2a2a; overflow:hidden;
  bottom:calc(88px + env(safe-area-inset-bottom,0px)); right:20px;
  width:380px; height:600px; border-radius:20px;
  box-shadow:0 20px 60px rgba(0,0,0,.7);
  transform:translateY(30px) scale(.96); opacity:0; pointer-events:none;
  transition:transform .32s cubic-bezier(.34,1.2,.64,1),opacity .25s;
}
#cf-box.on { transform:translateY(0) scale(1); opacity:1; pointer-events:all; }
@media(max-width:480px){
  #cf-box  { bottom:0; right:0; left:0; width:100%; height:92dvh; max-height:92dvh; border-radius:20px 20px 0 0; border-bottom:none; padding-bottom:env(safe-area-inset-bottom,0); transform:translateY(100%); opacity:1; }
  #cf-box.on { transform:translateY(0); }
  #cf-btn  { bottom:calc(16px + env(safe-area-inset-bottom,0)); right:16px; }
}

/* HEADER */
#cf-hd { flex-shrink:0; background:#0a0a0a; border-bottom:1px solid #2a2a2a; padding:14px 16px 12px; }
@media(max-width:480px){
  #cf-hd { padding:8px 16px 12px; }
  #cf-hd::before { content:''; display:block; width:36px; height:4px; background:#333; border-radius:2px; margin:0 auto 10px; }
}
.cf-hrow  { display:flex; align-items:center; gap:12px; }
.cf-av    { width:40px; height:40px; border-radius:50%; background:linear-gradient(135deg,var(--cf-a),#1b4332); display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0; }
.cf-hi    { flex:1; min-width:0; }
.cf-hname { font-size:15px; font-weight:600; color:#f0f4f0; letter-spacing:.02em; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.cf-hsub  { font-size:11px; color:var(--cf-al); display:flex; align-items:center; gap:5px; margin-top:2px; }
.cf-dot   { width:6px; height:6px; background:#4caf50; border-radius:50%; animation:cf-blink 2s infinite; }
@keyframes cf-blink { 0%,100%{opacity:1}50%{opacity:.35} }
#cf-x     { width:36px; height:36px; border-radius:50%; background:#222; color:#888; font-size:18px; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:background .2s,color .2s; -webkit-tap-highlight-color:transparent; }
#cf-x:hover  { background:#333; color:#f0f4f0; }
#cf-x:active { transform:scale(.93); }

/* MESSAGES */
#cf-msgs { flex:1; overflow-y:auto; overflow-x:hidden; padding:14px 14px 8px; display:flex; flex-direction:column; gap:10px; scroll-behavior:smooth; -webkit-overflow-scrolling:touch; overscroll-behavior:contain; }
#cf-msgs::-webkit-scrollbar { width:3px; }
#cf-msgs::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
.cf-msg { display:flex; align-items:flex-end; gap:8px; max-width:92%; animation:cf-mi .22s ease; }
@keyframes cf-mi { from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)} }
.cf-msg.b { align-self:flex-start; }
.cf-msg.u { align-self:flex-end; flex-direction:row-reverse; }
.cf-mav   { width:28px; height:28px; border-radius:50%; background:linear-gradient(135deg,var(--cf-a),#1b4332); display:flex; align-items:center; justify-content:center; font-size:13px; flex-shrink:0; margin-bottom:2px; }
.cf-msg.u .cf-mav { display:none; }
.cf-mb    { padding:10px 14px; border-radius:16px; font-size:14px; line-height:1.5; color:#e8eee8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.cf-msg.b .cf-mb { background:#1e1e1e; border-bottom-left-radius:4px; }
.cf-msg.u .cf-mb { background:linear-gradient(135deg,var(--cf-a),#1b4332); color:#fff; font-weight:500; border-bottom-right-radius:4px; }
@media(max-width:480px){ .cf-mb { font-size:15px; } .cf-msg { max-width:95%; } }
.cf-tdots { display:flex; gap:4px; padding:8px 4px; align-items:center; }
.cf-tdots span { width:7px; height:7px; border-radius:50%; background:var(--cf-al); animation:cf-bn 1.2s ease infinite; }
.cf-tdots span:nth-child(2) { animation-delay:.18s; }
.cf-tdots span:nth-child(3) { animation-delay:.36s; }
@keyframes cf-bn { 0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-6px);opacity:1} }

/* PRODUCT CAROUSEL */
.cf-cw  { width:100%; overflow:hidden; padding:2px 0 4px; }
.cf-cr  { display:flex; gap:10px; overflow-x:auto; scroll-snap-type:x mandatory; -webkit-overflow-scrolling:touch; padding:4px 2px 10px; overscroll-behavior-x:contain; scrollbar-width:thin; scrollbar-color:var(--cf-a) #222; }
.cf-cr::-webkit-scrollbar { height:4px; }
.cf-cr::-webkit-scrollbar-track { background:#222; border-radius:2px; }
.cf-cr::-webkit-scrollbar-thumb { background:linear-gradient(90deg,var(--cf-a),#1b4332); border-radius:2px; }
.cf-pc  { width:clamp(185px,56vw,215px); flex-shrink:0; scroll-snap-align:start; background:#1e1e1e; border:1px solid #2d2d2d; border-radius:14px; overflow:hidden; display:flex; flex-direction:column; transition:border-color .2s; }
.cf-pc:hover { border-color:var(--cf-al); }
.cf-pp  { width:100%; height:90px; background:linear-gradient(135deg,#1e1e1e,#0a1a0a); display:flex; align-items:center; justify-content:center; font-size:28px; color:var(--cf-al); }
.cf-pb  { padding:10px 10px 8px; flex:1; display:flex; flex-direction:column; gap:5px; }
.cf-pcat { display:inline-block; background:var(--cf-ap); color:var(--cf-al); border-radius:20px; padding:2px 8px; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; margin-bottom:1px; }
.cf-pname { font-size:14px; color:#f0f4f0; font-weight:600; line-height:1.2; }
.cf-pmeta { display:flex; gap:4px; flex-wrap:wrap; margin:3px 0 1px; }
.cf-tag   { padding:2px 7px; border:1px solid #333; border-radius:20px; font-size:11px; color:#aaa; }
.cf-tag.g { border-color:var(--cf-ap); color:var(--cf-al); background:var(--cf-ap); }
.cf-pbtns { display:flex; gap:6px; margin-top:6px; }
.cf-vbtn  { flex:1; height:36px; border:1px solid #333; border-radius:8px; font-size:12px; color:#aaa; display:flex; align-items:center; justify-content:center; transition:all .15s; -webkit-tap-highlight-color:transparent; }
.cf-vbtn:hover { background:#2a2a2a; color:#f0f4f0; }
.cf-obtn  { flex:1.5; height:36px; border-radius:8px; font-size:12px; font-weight:700; color:#fff; background:linear-gradient(135deg,var(--cf-a),#1b4332); display:flex; align-items:center; justify-content:center; transition:filter .15s; -webkit-tap-highlight-color:transparent; }
.cf-obtn:hover { filter:brightness(1.12); }
.cf-obtn:active { transform:scale(.96); }

/* LEAD FORM */
.cf-lead { background:#1a1a1a; border:1px solid #2d3d2d; border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:10px; }
.cf-lead p { font-size:13px; color:#aaa; text-align:center; line-height:1.5; }
.cf-linput { background:#252525; border:1px solid #333; border-radius:8px; padding:9px 12px; font-size:14px; color:#f0f4f0; width:100%; transition:border .15s; }
.cf-linput:focus { border-color:var(--cf-al); }
.cf-linput::placeholder { color:#555; }
.cf-lbtn  { height:40px; border-radius:8px; background:linear-gradient(135deg,var(--cf-a),#1b4332); color:#fff; font-size:14px; font-weight:700; transition:filter .15s; }
.cf-lbtn:hover { filter:brightness(1.1); }
.cf-lskip { font-size:12px; color:#555; text-align:center; background:none; border:none; cursor:pointer; }
.cf-lskip:hover { color:#888; }

/* CHIPS */
#cf-chips-wrap { flex-shrink:0; padding:4px 14px 0; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; scrollbar-width:thin; scrollbar-color:var(--cf-a) #222; padding-bottom:8px; }
#cf-chips-wrap::-webkit-scrollbar { height:4px; }
#cf-chips-wrap::-webkit-scrollbar-thumb { background:linear-gradient(90deg,var(--cf-a),#1b4332); border-radius:2px; }
#cf-chips { display:flex; gap:6px; width:max-content; }
.cf-chip { white-space:nowrap; padding:8px 14px; border:1px solid #333; border-radius:20px; font-size:13px; color:#ccc; background:#1e1e1e; transition:all .15s; min-height:40px; display:flex; align-items:center; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.cf-chip:hover  { border-color:var(--cf-al); color:var(--cf-al); background:var(--cf-ap); }
.cf-chip:active { transform:scale(.95); }
@media(max-width:480px){ .cf-chip { font-size:14px; padding:9px 16px; } }

/* INPUT ROW */
#cf-inp-row { flex-shrink:0; display:flex; align-items:center; gap:8px; padding:10px 14px calc(10px + env(safe-area-inset-bottom,0)); border-top:1px solid #222; background:#0a0a0a; }
#cf-inp { flex:1; height:44px; background:#1e1e1e; border:1px solid #2d2d2d; border-radius:22px; padding:0 16px; font-size:16px; color:#f0f4f0; transition:border-color .2s; -webkit-appearance:none; }
#cf-inp::placeholder { color:#555; }
#cf-inp:focus { border-color:var(--cf-al); }
#cf-send { width:44px; height:44px; border-radius:50%; background:linear-gradient(135deg,var(--cf-a),#1b4332); color:#fff; font-size:17px; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:transform .15s,filter .15s; -webkit-tap-highlight-color:transparent; }
#cf-send:hover   { filter:brightness(1.1); }
#cf-send:active  { transform:scale(.92); }
#cf-send:disabled { opacity:.35; pointer-events:none; }
#cf-ft { flex-shrink:0; text-align:center; padding:4px 0 6px; font-size:10px; color:#2d2d2d; letter-spacing:.06em; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0a0a0a; }
`;
  document.head.appendChild(style);

  // ── DOM ───────────────────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.id = 'cf-widget';
  wrapper.innerHTML = `
<div id="cf-veil"></div>
<button id="cf-btn" aria-label="Chat with our budtender">
  <span class="ico-o">🌿</span>
  <span class="ico-c">✕</span>
</button>
<div id="cf-box" role="dialog" aria-modal="true" aria-label="CannaFlow AI Budtender">
  <div id="cf-hd">
    <div class="cf-hrow">
      <div class="cf-av" id="cf-av">🌿</div>
      <div class="cf-hi">
        <div class="cf-hname" id="cf-hname">Budtender AI</div>
        <div class="cf-hsub"><span class="cf-dot"></span><span id="cf-hsub">Online · Ask about our menu</span></div>
      </div>
      <button id="cf-x" aria-label="Close chat">✕</button>
    </div>
  </div>
  <div id="cf-msgs" role="log" aria-live="polite"></div>
  <div id="cf-chips-wrap"><div id="cf-chips"></div></div>
  <div id="cf-inp-row">
    <input id="cf-inp" type="text" placeholder="Ask about strains, prices…"
      autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send"/>
    <button id="cf-send" aria-label="Send">➤</button>
  </div>
  <div id="cf-ft">POWERED BY CANNAFLOW AI ✦</div>
</div>`;
  document.body.appendChild(wrapper);

  // ── Refs ──────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  const btn  = $('cf-btn'),  veil = $('cf-veil'),  box  = $('cf-box');
  const msgs = $('cf-msgs'), ch   = $('cf-chips'), cw   = $('cf-chips-wrap');
  const inp  = $('cf-inp'),  send = $('cf-send'),  xbtn = $('cf-x');

  // ── Open / Close ─────────────────────────────────────────────────────────
  function show() {
    panelOpen = true;
    btn.classList.add('open', 'seen');
    box.classList.add('on');
    veil.classList.add('on');
    document.body.style.overflow = 'hidden';
    if (!convo.length) setTimeout(() => quiz(1), 300);
    requestAnimationFrame(() => inp.focus());
  }
  function hide() {
    panelOpen = false;
    btn.classList.remove('open');
    box.classList.remove('on');
    veil.classList.remove('on');
    document.body.style.overflow = '';
  }
  btn.addEventListener('click', () => panelOpen ? hide() : show());
  veil.addEventListener('click', hide);
  xbtn.addEventListener('click', hide);

  // ── Config / Branding ─────────────────────────────────────────────────────
  async function loadConfig() {
    try {
      const r = await fetch(`${WORKER_URL}/api/config/${CLIENT_ID}`);
      if (r.ok) {
        const d = await r.json();
        cfg = { ...cfg, ...d };
        applyBranding();
      }
    } catch {}
  }
  function applyBranding() {
    const r = document.querySelector(':root') || document.documentElement;
    r.style.setProperty('--cf-a', cfg.accentColor || '#2d6a4f');
    r.style.setProperty('--cf-al', lighten(cfg.accentColor) || '#52b788');
    r.style.setProperty('--cf-ap', `${cfg.accentColor || '#2d6a4f'}26`);
    $('cf-hname').textContent = cfg.botName || 'Budtender AI';
    $('cf-hsub').textContent  = `${cfg.name || 'Your dispensary'} · Ask about our menu`;
    $('cf-av').textContent    = cfg.emoji || '🌿';
  }
  function lighten(hex) {
    if (!hex) return '#52b788';
    try {
      const n = parseInt(hex.replace('#',''), 16);
      const r = Math.min(255, ((n>>16)&255)+60);
      const g = Math.min(255, ((n>>8)&255)+60);
      const b = Math.min(255, (n&255)+60);
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    } catch { return '#52b788'; }
  }

  // ── Quiz ──────────────────────────────────────────────────────────────────
  function quiz(n) {
    quizStep = n;
    const s = QUIZ[n - 1];
    botMsg(s.q, progressBar(n));
    chips(s.o.map(o => ({ t: o, fn: () => quizAns(n, s.k, o) })));
  }
  function progressBar(cur) {
    const el = mk('div', ''); el.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';
    for (let i = 1; i <= QUIZ.length; i++) {
      const d = mk('div', '');
      d.style.cssText = `flex:1;height:3px;border-radius:2px;background:${i<cur?'var(--cf-al)':i===cur?'var(--cf-al)':'#2d2d2d'};opacity:${i===cur?'1':i<cur?'.7':'.3'};`;
      el.appendChild(d);
    }
    return el;
  }
  function quizAns(n, k, v) {
    quizAnswers[k] = v;
    userMsg(v);
    noChips();
    if (n < QUIZ.length) {
      typing(380, () => quiz(n + 1));
    } else {
      quizStep = 99;
      typing(500, () => showLeadCapture());
    }
  }

  // ── Lead Capture ──────────────────────────────────────────────────────────
  function showLeadCapture() {
    const form = mk('div', 'cf-lead');
    form.innerHTML = `
      <p>Want deals & restock alerts? Drop your email below — or skip to see your recommendations.</p>
      <input class="cf-linput" id="cf-lname"  type="text"  placeholder="Your name (optional)" />
      <input class="cf-linput" id="cf-lemail" type="email" placeholder="Email address" />
      <button class="cf-lbtn" id="cf-lgo">Show My Recommendations →</button>
      <button class="cf-lskip" id="cf-lskip">Skip for now</button>`;
    msgs.appendChild(botRowWrap(form));
    scrollBot();

    $('cf-lgo').addEventListener('click', () => {
      const name  = $('cf-lname')?.value.trim();
      const email = $('cf-lemail')?.value.trim();
      if (email) saveLead(name, email);
      form.closest('.cf-msg')?.remove();
      leadDone = true;
      getRecommendations(name);
    });
    $('cf-lskip').addEventListener('click', () => {
      form.closest('.cf-msg')?.remove();
      leadDone = true;
      getRecommendations(null);
    });
  }

  async function saveLead(name, email) {
    try {
      await fetch(`${WORKER_URL}/api/lead/${CLIENT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, source: 'chat_widget', url: window.location.href }),
      });
    } catch {}
  }

  // ── Recommendations ───────────────────────────────────────────────────────
  async function getRecommendations(name) {
    const greeting = name ? `${name}, here are some picks for you! 🌿\n\n` : '';
    const prompt = `Based on my preferences: effect="${quizAnswers.effect}", experience="${quizAnswers.experience}", type="${quizAnswers.type}" — what products do you recommend?`;
    await aiChat(prompt, greeting);
    chips([
      { t: '💰 Under $30',       fn: () => aiChat('Show me products under $30') },
      { t: '🏆 Top rated',       fn: () => aiChat('What are your most popular products?') },
      { t: '😴 Best for sleep',  fn: () => aiChat('What do you recommend for sleep?') },
      { t: '🎯 Highest THC',     fn: () => aiChat('What has the highest THC?') },
      { t: '🔁 Start over',      fn: () => { noChips(); convo = []; quizAnswers = {}; quizStep = 0; clearMsgs(); quiz(1); } },
    ]);
  }

  // ── AI Chat ───────────────────────────────────────────────────────────────
  async function aiChat(text, greeting = '') {
    if (!text.trim() || isLoading) return;
    if (inp.value) { userMsg(inp.value.trim()); inp.value = ''; }
    else userMsg(text);
    noChips();
    isLoading = true;
    send.disabled = true;
    const t = showTyping();
    try {
      convo.push({ role: 'user', content: text });
      const r = await fetch(`${WORKER_URL}/api/chat/${CLIENT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: convo.slice(-10), quizAnswers, greeting }),
      });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      const reply = d.message || "I'm not sure about that — try asking differently!";
      convo.push({ role: 'assistant', content: reply });
      t.remove();
      botMsg(reply);

      if (d.products?.length) {
        const cwr = mk('div', 'cf-cw');
        const car = mk('div', 'cf-cr');
        d.products.slice(0, 6).forEach(p => car.appendChild(productCard(p)));
        cwr.appendChild(car);
        msgs.appendChild(botRowWrap(cwr));
        scrollBot();
      }

      if (quizStep === 99 && !d.products?.length) {
        chips([
          { t: '🛍️ Show me options', fn: () => aiChat('Show me what you have in stock') },
          { t: '💰 Under $30',       fn: () => aiChat('Show me products under $30') },
          { t: '🔁 Start over',      fn: () => { noChips(); convo = []; quizAnswers = {}; quizStep = 0; clearMsgs(); quiz(1); } },
        ]);
      }
    } catch {
      t.remove();
      botMsg("I'm having trouble connecting right now. Please try again in a moment!");
    } finally {
      isLoading = false;
      send.disabled = false;
    }
  }

  // Handle manual send button / enter key
  function handleSend() {
    const text = inp.value.trim();
    if (!text || isLoading) return;
    inp.value = '';
    if (quizStep === 0) { quiz(1); return; }
    aiChat(text);
  }
  send.addEventListener('click', handleSend);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });

  // ── Product Card ──────────────────────────────────────────────────────────
  function productCard(p) {
    const el = mk('div', 'cf-pc');
    // Emoji placeholder based on category
    const emojis = { flower:'🌸', 'pre-roll':'🚬', vape:'💨', edible:'🍬', concentrate:'🍯', tincture:'💧', topical:'🧴', cbd:'🌿' };
    const ph = mk('div', 'cf-pp');
    ph.textContent = emojis[p.category] || '🌿';
    el.appendChild(ph);

    const body = mk('div', 'cf-pb');
    if (p.category) {
      const cat = mk('div', 'cf-pcat');
      cat.textContent = p.category.replace('-', ' ');
      body.appendChild(cat);
    }
    const name = mk('div', 'cf-pname');
    name.textContent = p.name || '';
    body.appendChild(name);

    const meta = mk('div', 'cf-pmeta');
    if (p.price > 0)      { const t = mk('span', 'cf-tag g'); t.textContent = `$${p.price}`; meta.appendChild(t); }
    if (p.thc)             { const t = mk('span', 'cf-tag');   t.textContent = `${p.thc}% THC`; meta.appendChild(t); }
    if (p.strain_type)     { const t = mk('span', 'cf-tag');   t.textContent = cap(p.strain_type); meta.appendChild(t); }
    body.appendChild(meta);

    const btns = mk('div', 'cf-pbtns');
    const ob = mk('a', 'cf-obtn');
    ob.href = cfg.orderUrl || '#';
    ob.target = '_blank'; ob.rel = 'noopener';
    ob.textContent = 'Order Now →';
    btns.appendChild(ob);
    body.appendChild(btns);
    el.appendChild(body);
    return el;
  }

  // ── DOM Helpers ───────────────────────────────────────────────────────────
  function mk(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  function botRowWrap(content) {
    const r = mk('div', 'cf-msg b');
    const av = mk('div', 'cf-mav'); av.textContent = cfg.emoji || '🌿';
    const w = mk('div', ''); w.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-width:100%;min-width:0;';
    w.appendChild(content); r.appendChild(av); r.appendChild(w);
    return r;
  }
  function botMsg(text, extra) {
    const bub = mk('div', 'cf-mb');
    bub.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    const w = mk('div', ''); w.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    if (extra) w.appendChild(extra);
    w.appendChild(bub);
    const r = mk('div', 'cf-msg b');
    const av = mk('div', 'cf-mav'); av.textContent = cfg.emoji || '🌿';
    r.appendChild(av); r.appendChild(w);
    msgs.appendChild(r); scrollBot();
    return r;
  }
  function userMsg(text) {
    const r = mk('div', 'cf-msg u');
    const b = mk('div', 'cf-mb'); b.textContent = text;
    r.appendChild(b); msgs.appendChild(r); scrollBot();
  }
  function showTyping() {
    const r = mk('div', 'cf-msg b');
    const av = mk('div', 'cf-mav'); av.textContent = cfg.emoji || '🌿';
    const b = mk('div', 'cf-mb');
    b.innerHTML = '<div class="cf-tdots"><span></span><span></span><span></span></div>';
    r.appendChild(av); r.appendChild(b); msgs.appendChild(r); scrollBot();
    return r;
  }
  function typing(ms, cb) { const t = showTyping(); setTimeout(() => { t.remove(); cb(); }, ms); }
  function scrollBot() { msgs.scrollTop = msgs.scrollHeight; }
  function clearMsgs() { msgs.innerHTML = ''; }

  // ── Chips ─────────────────────────────────────────────────────────────────
  function chips(arr) {
    ch.innerHTML = '';
    arr.forEach(item => {
      const c = mk('button', 'cf-chip');
      c.textContent = item.t;
      c.addEventListener('click', () => { noChips(); item.fn(); });
      ch.appendChild(c);
    });
  }
  function noChips() { ch.innerHTML = ''; }

  // ── Init ──────────────────────────────────────────────────────────────────
  loadConfig();
})();
