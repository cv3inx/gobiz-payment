import express from 'express';
import { config } from '../config.js';
import { openApiSpec } from '../openapi.js';
import { counts } from '../db/transactions.js';
import { cursor } from '../uniqueCode.js';
import { isAuthenticated } from '../security.js';
import { sessionHealth } from '../services/session.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * Custom API docs, rendered client-side from `/openapi.json`.
 *
 * Replaces Swagger UI: that shipped its CSS/JS from `swagger-ui-dist` through the
 * `/docs-assets` Nitro public-asset mount, which the build handled unreliably and
 * left the page blank. This page is fully self-contained — inline CSS and JS, zero
 * external assets — so it renders wherever it is served and survives the Nitro
 * build untouched. The spec stays the single source of truth; only the renderer
 * changed. Try-it uses same-origin fetch, so `connect-src 'self'` is enough.
 */
const DOCS_PAGE = `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
   <meta charset="utf-8">
   <meta name="viewport" content="width=device-width, initial-scale=1">
   <meta name="robots" content="noindex, nofollow">
   <title>GoBiz Payment Gateway — API</title>
   <style>
      :root{
         --bg:#0d1117; --panel:#161b22; --panel2:#0d1117; --border:#30363d;
         --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; --accent-soft:#1f6feb33;
         --get:#3fb950; --post:#d29922; --code-bg:#010409; --radius:10px;
         --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
         --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      }
      @media (prefers-color-scheme:light){:root[data-theme=auto]{
         --bg:#ffffff; --panel:#f6f8fa; --panel2:#fff; --border:#d0d7de;
         --text:#1f2328; --muted:#636c76; --accent:#0969da; --accent-soft:#0969da1a;
         --get:#1a7f37; --post:#9a6700; --code-bg:#f6f8fa;
      }}
      *{box-sizing:border-box}
      html,body{margin:0}
      body{background:var(--bg);color:var(--text);font-family:var(--sans);
         font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
      a{color:var(--accent);text-decoration:none}
      a:hover{text-decoration:underline}
      code{font-family:var(--mono);font-size:.85em;background:var(--code-bg);
         border:1px solid var(--border);border-radius:5px;padding:.1em .4em}
      pre{margin:0;background:var(--code-bg);border:1px solid var(--border);
         border-radius:var(--radius);padding:14px 16px;overflow:auto}
      pre code{background:none;border:none;padding:0;font-size:.82rem;line-height:1.5}
      .layout{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
      /* ── sidebar ── */
      aside{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;
         border-right:1px solid var(--border);background:var(--panel);padding:20px 0}
      aside .brand{padding:0 22px 16px;font-weight:700;font-size:1.05rem;
         display:flex;align-items:center;gap:9px}
      aside .brand .dot{width:9px;height:9px;border-radius:50%;background:var(--get);
         box-shadow:0 0 0 4px var(--get)22}
      aside .grp{padding:14px 22px 6px;font-size:.7rem;letter-spacing:.08em;
         text-transform:uppercase;color:var(--muted);font-weight:600}
      aside nav a{display:flex;align-items:center;gap:8px;padding:5px 22px;
         color:var(--text);font-size:.86rem;border-left:2px solid transparent}
      aside nav a:hover{background:var(--accent-soft);text-decoration:none}
      aside nav a.active{border-left-color:var(--accent);background:var(--accent-soft)}
      aside nav a .m{font-size:.62rem;font-weight:700;width:34px;flex:none}
      /* ── main ── */
      main{max-width:860px;width:100%;margin:0 auto;padding:34px 40px 120px}
      header.page{margin-bottom:10px}
      header.page h1{font-size:1.7rem;margin:0 0 6px}
      header.page .ver{color:var(--muted);font-size:.85rem}
      .lead{color:var(--muted);margin:14px 0 22px}
      .lead p{margin:.5em 0}
      .keybar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;
         background:var(--panel);border:1px solid var(--border);
         border-radius:var(--radius);padding:12px 14px;margin:0 0 30px}
      .keybar label{font-size:.78rem;color:var(--muted);font-weight:600}
      .keybar input{flex:1;min-width:180px;background:var(--panel2);
         border:1px solid var(--border);border-radius:7px;color:var(--text);
         padding:7px 10px;font-family:var(--mono);font-size:.82rem}
      .keybar .hint{font-size:.72rem;color:var(--muted);width:100%}
      /* ── endpoint ── */
      .op{border:1px solid var(--border);border-radius:var(--radius);
         margin:0 0 16px;overflow:hidden;background:var(--panel)}
      .op>summary{list-style:none;cursor:pointer;display:flex;align-items:center;
         gap:12px;padding:14px 16px;user-select:none}
      .op>summary::-webkit-details-marker{display:none}
      .op>summary:hover{background:var(--accent-soft)}
      .badge{font-family:var(--mono);font-weight:700;font-size:.72rem;
         padding:3px 9px;border-radius:6px;letter-spacing:.04em;flex:none;color:#fff}
      .badge.get{background:var(--get)}.badge.post{background:var(--post)}
      .op .path{font-family:var(--mono);font-size:.9rem;font-weight:600}
      .op .sum{color:var(--muted);font-size:.84rem;margin-left:auto;text-align:right}
      .op .lock{font-size:.72rem;color:var(--muted);flex:none}
      .body{padding:4px 18px 20px;border-top:1px solid var(--border)}
      .desc{color:var(--muted);font-size:.9rem;margin:14px 0}
      .desc p{margin:.5em 0}
      h4.sec{font-size:.72rem;letter-spacing:.07em;text-transform:uppercase;
         color:var(--muted);margin:20px 0 8px;font-weight:700}
      table{width:100%;border-collapse:collapse;font-size:.84rem}
      th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);
         vertical-align:top}
      th{color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase;
         letter-spacing:.04em}
      td .req{color:var(--post);font-size:.7rem;font-weight:700}
      .tabs{display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap}
      .tabs button{background:var(--panel2);border:1px solid var(--border);
         color:var(--muted);border-radius:6px 6px 0 0;padding:5px 12px;cursor:pointer;
         font-size:.78rem;font-family:var(--mono)}
      .tabs button.on{color:var(--text);border-bottom-color:var(--panel2);
         background:var(--code-bg)}
      .resp{display:flex;gap:10px;align-items:baseline;padding:7px 0;
         border-bottom:1px solid var(--border);font-size:.86rem}
      .resp .st{font-family:var(--mono);font-weight:700;flex:none;width:42px}
      .st.ok{color:var(--get)}.st.err{color:#f85149}
      /* ── try ── */
      .try{margin-top:18px;border:1px dashed var(--border);border-radius:var(--radius);
         padding:14px}
      .try .params{display:grid;gap:8px;margin-bottom:10px}
      .try .params input{background:var(--panel2);border:1px solid var(--border);
         border-radius:6px;color:var(--text);padding:6px 9px;font-family:var(--mono);
         font-size:.82rem}
      .try textarea{width:100%;min-height:92px;background:var(--panel2);
         border:1px solid var(--border);border-radius:6px;color:var(--text);
         padding:9px;font-family:var(--mono);font-size:.8rem;resize:vertical}
      .try .run{background:var(--accent);color:#fff;border:none;border-radius:7px;
         padding:8px 18px;font-weight:600;cursor:pointer;font-size:.86rem;margin-top:10px}
      .try .run:hover{filter:brightness(1.08)}
      .try .out{margin-top:12px}
      .try .out .status{font-family:var(--mono);font-size:.8rem;margin-bottom:6px;
         color:var(--muted)}
      .err-box{background:var(--panel);border:1px solid #f85149;border-radius:var(--radius);
         padding:16px;color:#f85149;font-family:var(--mono);font-size:.85rem}
      @media (max-width:820px){
         .layout{grid-template-columns:1fr}
         aside{position:static;height:auto;border-right:none;
            border-bottom:1px solid var(--border)}
         main{padding:24px 18px 80px}
         .op .sum{display:none}
      }
   </style>
</head>
<body>
   <div class="layout">
      <aside><div class="brand"><span class="dot"></span>GoBiz Payment</div>
         <nav id="nav"></nav></aside>
      <main id="main"><p class="desc">Loading spec…</p></main>
   </div>
   <script>
   (async () => {
      const KEY = 'gobiz-docs-apikey';
      const $ = (t, c, h) => { const e = document.createElement(t);
         if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
      const esc = s => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
      // Minimal, safe markdown: escape first, then re-introduce a known-small set.
      const md = s => esc(s || '')
         .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
         .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
         .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
         .split(/\\n\\n+/).map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');

      let spec;
      try {
         const r = await fetch('/openapi.json', { headers: { accept: 'application/json' } });
         if (!r.ok) throw new Error('HTTP ' + r.status);
         spec = await r.json();
      } catch (e) {
         document.getElementById('main').innerHTML =
            '<div class="err-box">Could not load /openapi.json — ' + esc(e.message) + '</div>';
         return;
      }

      const apiKeyInput = () => document.getElementById('apikey');
      const resolveRef = o => (o && o.$ref)
         ? o.$ref.split('/').slice(1).reduce((a, k) => a && a[k], spec) : o;

      // Group endpoints by their leading path segment for the sidebar.
      const groupOf = p => p.startsWith('/api/admin') ? 'Admin'
         : p.startsWith('/payment') ? 'Payments'
         : p.startsWith('/history') ? 'History'
         : p.startsWith('/docs') || p.startsWith('/openapi') ? 'Meta' : 'System';
      const ops = [];
      for (const [path, methods] of Object.entries(spec.paths)) {
         for (const [method, op] of Object.entries(methods)) {
            ops.push({ path, method, op, id: (method + path).replace(/[^\\w]+/g, '-') });
         }
      }

      // ── header + key bar ──────────────────────────────────────────────────
      const main = document.getElementById('main');
      main.innerHTML = '';
      const head = $('header', 'page');
      head.append($('h1', '', esc(spec.info.title)));
      head.append($('div', 'ver', 'v' + esc(spec.info.version)));
      main.append(head);
      main.append($('div', 'lead', md(spec.info.description)));

      const bar = $('div', 'keybar');
      bar.append($('label', '', 'X-API-Key'));
      const ki = $('input'); ki.id = 'apikey'; ki.type = 'password';
      ki.placeholder = 'paste API_KEY to authorize try-it & 🔒 endpoints';
      ki.value = localStorage.getItem(KEY) || '';
      ki.oninput = () => { try { localStorage.setItem(KEY, ki.value); } catch {} };
      bar.append(ki);
      bar.append($('div', 'hint', 'Stored only in this browser (localStorage). Sent as the X-API-Key header on try-it requests.'));
      main.append(bar);

      // ── sidebar ───────────────────────────────────────────────────────────
      const nav = document.getElementById('nav');
      const byGroup = {};
      ops.forEach(o => (byGroup[groupOf(o.path)] ||= []).push(o));
      for (const [grp, list] of Object.entries(byGroup)) {
         nav.append($('div', 'grp', grp));
         list.forEach(o => {
            const a = $('a'); a.href = '#' + o.id; a.dataset.id = o.id;
            a.append($('span', 'm', '<span style="color:var(--' + o.method + ')">' + o.method.toUpperCase() + '</span>'));
            a.append($('span', '', esc(o.op.summary || o.path)));
            nav.append(a);
         });
      }

      // ── schema → rows ───────────────────────────────────────────────────────
      const schemaRows = (schema) => {
         schema = resolveRef(schema);
         if (!schema || !schema.properties) return null;
         const required = new Set(schema.required || []);
         const t = $('table');
         t.innerHTML = '<thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>';
         const tb = $('tbody');
         for (const [name, propRaw] of Object.entries(schema.properties)) {
            const prop = resolveRef(propRaw) || propRaw;
            const tr = $('tr');
            tr.append($('td', '', '<code>' + esc(name) + '</code>' +
               (required.has(name) ? ' <span class="req">required</span>' : '')));
            tr.append($('td', '', esc(prop.type || (prop.$ref ? 'object' : '—')) +
               (prop.enum ? '<br><span style="color:var(--muted);font-size:.78rem">' +
                  prop.enum.map(esc).join(' | ') + '</span>' : '')));
            tr.append($('td', '', md(prop.description || '') +
               (prop.example !== undefined ? ' <code>' + esc(JSON.stringify(prop.example)) + '</code>' : '')));
            tb.append(tr);
         }
         t.append(tb); return t;
      };

      const jsonBlock = v => { const p = $('pre'); p.append($('code', '',
         esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2)))); return p; };

      // Tabbed set of examples / payloads.
      const tabbed = (entries) => {
         const wrap = $('div');
         const tabs = $('div', 'tabs');
         const panes = [];
         entries.forEach(([label, node], i) => {
            const b = $('button', i === 0 ? 'on' : '', esc(label));
            node.style.display = i === 0 ? '' : 'none';
            b.onclick = () => {
               tabs.querySelectorAll('button').forEach(x => x.classList.remove('on'));
               panes.forEach(p => p.style.display = 'none');
               b.classList.add('on'); node.style.display = '';
            };
            tabs.append(b); panes.push(node); wrap.append(node);
         });
         wrap.prepend(tabs); return wrap;
      };

      // ── render each operation ────────────────────────────────────────────────
      ops.forEach(({ path, method, op, id }) => {
         const det = $('details', 'op'); det.id = id;
         const sum = $('summary');
         sum.append($('span', 'badge ' + method, method.toUpperCase()));
         sum.append($('span', 'path', esc(path)));
         const secured = (op.security || []).some(s => Object.keys(s).length);
         if (secured) sum.append($('span', 'lock', '🔒'));
         sum.append($('span', 'sum', esc(op.summary || '')));
         det.append(sum);

         const body = $('div', 'body');
         if (op.description) body.append($('div', 'desc', md(op.description)));

         // parameters
         const params = op.parameters || [];
         if (params.length) {
            body.append($('h4', 'sec', 'Parameters'));
            const t = $('table');
            t.innerHTML = '<thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead>';
            const tb = $('tbody');
            params.forEach(p => {
               const tr = $('tr');
               tr.append($('td', '', '<code>' + esc(p.name) + '</code>' +
                  (p.required ? ' <span class="req">required</span>' : '')));
               tr.append($('td', '', esc(p.in)));
               tr.append($('td', '', esc((p.schema && p.schema.type) || '—')));
               tr.append($('td', '', md(p.description || '')));
               tb.append(tr);
            });
            t.append(tb); body.append(t);
         }

         // request body
         let bodyExample = null;
         const rb = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
         if (rb) {
            body.append($('h4', 'sec', 'Request body'));
            const rows = schemaRows(rb.schema);
            if (rows) body.append(rows);
            const exs = rb.examples
               ? Object.entries(rb.examples).map(([k, v]) => [v.summary || k, jsonBlock(v.value)])
               : (rb.schema && resolveRef(rb.schema) && resolveRef(rb.schema).example
                  ? [['example', jsonBlock(resolveRef(rb.schema).example)]] : []);
            if (exs.length) {
               body.append($('h4', 'sec', 'Example payload'));
               body.append(tabbed(exs));
               bodyExample = JSON.stringify(
                  (rb.examples && Object.values(rb.examples)[0].value)
                  || (resolveRef(rb.schema) && resolveRef(rb.schema).example) || {}, null, 2);
            }
         }

         // responses
         if (op.responses) {
            body.append($('h4', 'sec', 'Responses'));
            for (const [code, resp] of Object.entries(op.responses)) {
               const row = $('div', 'resp');
               row.append($('span', 'st ' + (code[0] === '2' ? 'ok' : 'err'), code));
               row.append($('span', '', md(resp.description || '')));
               body.append(row);
               const ex = resp.content && resp.content['application/json'] &&
                  resp.content['application/json'].example;
               if (ex) body.append(jsonBlock(ex));
            }
         }

         // try-it
         body.append(buildTry(path, method, params, bodyExample, secured));
         det.append(body);
         main.append(det);
      });

      function buildTry(path, method, params, bodyExample, secured) {
         const box = $('div', 'try');
         box.append($('h4', 'sec', 'Try it'));
         const pbox = $('div', 'params');
         const pathParams = params.filter(p => p.in === 'path');
         const queryParams = params.filter(p => p.in === 'query');
         const inputs = {};
         [...pathParams, ...queryParams].forEach(p => {
            const i = $('input');
            i.placeholder = p.name + (p.in === 'path' ? ' (path)' : ' (query, optional)');
            inputs[p.name] = { el: i, in: p.in };
            pbox.append(i);
         });
         if (pbox.children.length) box.append(pbox);

         let ta = null;
         if (bodyExample) { ta = $('textarea'); ta.value = bodyExample; box.append(ta); }

         const run = $('button', 'run', 'Send ' + method.toUpperCase());
         const out = $('div', 'out');
         run.onclick = async () => {
            let url = path;
            for (const [name, { el, in: loc }] of Object.entries(inputs))
               if (loc === 'path') url = url.replace('{' + name + '}', encodeURIComponent(el.value || ''));
            const qs = Object.entries(inputs).filter(([, v]) => v.in === 'query' && v.el.value)
               .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v.el.value)).join('&');
            if (qs) url += '?' + qs;

            const headers = {};
            const key = apiKeyInput().value.trim();
            if (key) headers['X-API-Key'] = key;
            const opts = { method: method.toUpperCase(), headers };
            if (ta) { headers['Content-Type'] = 'application/json'; opts.body = ta.value; }

            out.innerHTML = '';
            out.append($('div', 'status', '→ ' + method.toUpperCase() + ' ' + url + ' …'));
            const t0 = performance.now();
            try {
               const r = await fetch(url, opts);
               const ms = Math.round(performance.now() - t0);
               const ct = r.headers.get('content-type') || '';
               out.querySelector('.status').textContent =
                  r.status + ' ' + r.statusText + '  ·  ' + ms + 'ms  ·  ' + ct.split(';')[0];
               if (ct.includes('application/json')) out.append(jsonBlock(await r.json()));
               else if (ct.startsWith('image/')) {
                  const img = $('img'); img.src = url; img.style.maxWidth = '220px';
                  img.style.border = '1px solid var(--border)'; img.style.borderRadius = '8px';
                  out.append(img);
               } else out.append(jsonBlock(await r.text()));
            } catch (e) {
               out.querySelector('.status').textContent = 'Request failed: ' + e.message;
            }
         };
         box.append(run); box.append(out);
         return box;
      }

      // scroll-spy: highlight the sidebar entry of whatever's on screen
      const links = [...nav.querySelectorAll('a')];
      const spy = new IntersectionObserver(es => es.forEach(e => {
         if (e.isIntersecting) {
            links.forEach(l => l.classList.toggle('active', l.dataset.id === e.target.id));
         }
      }), { rootMargin: '-10% 0px -80% 0px' });
      document.querySelectorAll('details.op').forEach(d => spy.observe(d));
      // open the targeted endpoint on load / hash change
      const openHash = () => { const el = document.getElementById(location.hash.slice(1));
         if (el && el.tagName === 'DETAILS') el.open = true; };
      window.addEventListener('hashchange', openHash); openHash();
   })();
   </script>
</body>
</html>`;

export function systemRoutes() {
   const router = express.Router();

   router.get(['/docs', '/docs/'], (req, res) => {
      // Narrower than the API's `default-src 'none'`, which this page cannot use:
      // Swagger UI needs its own inline bootstrap script and injects style tags.
      res.setHeader(
         'Content-Security-Policy',
         "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
         "img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
      );
      res.type('html').send(DOCS_PAGE);
   });

   router.get('/openapi.json', (req, res) => res.json(openApiSpec));

   return router;
}

export function healthRoutes() {
   const router = express.Router();

   /**
    * Liveness + upstream session state. Unauthenticated, so an uptime monitor can
    * poll it without holding the API key.
    *
    * 503 when the GoBiz session is down: payments cannot be detected, so the
    * deployment is degraded even though HTTP is fine.
    *
    * Transaction counts and the code cursor are only returned to an authenticated
    * caller. Volume and revenue pace are business intelligence — an open endpoint
    * publishing "pending: 3, total: 128" tells anyone who asks how much trade this
    * merchant does. `/api/admin/stats` is the place for the full picture.
    */
   router.get('/health', wrap(async (req, res) => {
      const session = await sessionHealth();
      const degraded = session.ok === false;

      const data = {
         session: {
            ok: session.ok,
            lastCheckAt: session.lastCheckAt,
            lastOkAt: session.lastOkAt,
            consecutiveFailures: session.consecutiveFailures,
            reauths: session.reauths,
            lastError: session.lastError,
         },
      };

      if (isAuthenticated(req, config.apiKey)) {
         const [tally, uniqueCodeCursor] = await Promise.all([
            counts(),
            cursor(config.uniqueCodeMax),
         ]);
         Object.assign(data, tally, { uniqueCodeCursor });
      }

      res.status(degraded ? 503 : 200).json({ success: !degraded, data });
   }));

   return router;
}
