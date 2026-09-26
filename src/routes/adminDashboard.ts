/**
 * Server-rendered shell for the admin SPA (Alpine.js), which calls the
 * cookie-authenticated /admin/api/* endpoints. Own module because the HTML/CSS is large.
 */

export function renderDashboardShell(): string {
  return DASHBOARD_HTML;
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ai-api-bridge · dashboard</title>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"
        integrity="sha384-l8f0VcPi/M1iHPv8egOnY/15TDwqgbOR1anMIJWvU6nLRgZVLTLSaNqi/TOoT5Fh"
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<style>
  :root {
    --bg: #0a1120;
    --panel: #111827;
    --panel-2: #0f1827;
    --border: #182236;
    --text: #e5e7eb;
    --muted: #9ca3af;
    --dim: #6b7280;
    --accent: #3b82f6;
    --accent-2: #6366f1;
    --good: #22c55e;
    --warn: #f59e0b;
    --bad: #ef4444;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, sans-serif; min-height: 100vh; }
  a { color: #93c5fd; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1, h2, h3 { margin: 0; font-weight: 600; }
  h2 { font-size: 1.1rem; margin-bottom: 0.75rem; }
  h3 { font-size: 0.95rem; margin-bottom: 0.5rem; color: var(--muted); }
  [x-cloak] { display: none !important; }

  .app { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
  .sidebar { background: var(--panel); border-right: 1px solid var(--border); padding: 1.5rem 0.75rem; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 0.6rem; padding: 0 0.75rem 1.5rem; }
  .brand .logo { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); display: flex; align-items: center; justify-content: center; font-weight: 700; }
  .brand .title { font-weight: 700; font-size: 0.95rem; }
  .brand .sub { font-size: 0.7rem; color: var(--dim); }
  .nav-section { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); padding: 0.75rem 0.75rem 0.25rem; }
  .nav-item { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.75rem; border-radius: 6px; color: var(--muted); font-size: 0.85rem; cursor: pointer; transition: all 0.15s; }
  .nav-item:hover { background: var(--border); color: var(--text); }
  .nav-item.active { background: #1e3a8a; color: #93c5fd; }
  .nav-spacer { flex: 1; }
  .nav-bottom { padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); font-size: 0.7rem; color: var(--dim); }

  main { padding: 2rem 2.5rem; max-width: 1100px; }
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .page-title { font-size: 1.5rem; font-weight: 700; }
  .page-sub { color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem; }

  .grid { display: grid; gap: 1rem; }
  .grid-4 { grid-template-columns: repeat(4, 1fr); }
  .grid-2 { grid-template-columns: 1fr 1fr; }

  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; }
  .stat .label { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat .value { font-size: 1.6rem; font-weight: 700; margin-top: 0.25rem; }
  .stat .extra { color: var(--dim); font-size: 0.75rem; margin-top: 0.25rem; }

  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); padding: 0.75rem; border-bottom: 1px solid var(--border); font-weight: 600; }
  td { padding: 0.75rem; border-bottom: 1px solid var(--panel-2); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: rgba(255,255,255,0.02); }
  .mono { font-family: ui-monospace, "SF Mono", monospace; font-size: 0.8rem; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }

  .btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.5rem 0.9rem; border-radius: 8px; border: 0; cursor: pointer; font-size: 0.85rem; font-weight: 500; transition: opacity 0.15s; font-family: inherit; }
  .btn:hover:not(:disabled) { opacity: 0.85; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: linear-gradient(90deg, var(--accent), var(--accent-2)); color: white; }
  .btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  .btn-ghost:hover:not(:disabled) { background: var(--border); color: var(--text); }
  .btn-danger { background: var(--bad); color: white; }
  .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.75rem; }

  .input { width: 100%; padding: 0.55rem 0.8rem; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); color: var(--text); font-size: 0.85rem; font-family: inherit; }
  .input:focus { outline: none; border-color: var(--accent); }
  .input.mono { font-family: ui-monospace, monospace; font-size: 0.8rem; }
  label.field { display: block; margin-bottom: 1rem; }
  label.field .label { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 0.35rem; }
  label.field .hint { font-size: 0.7rem; color: var(--dim); margin-top: 0.25rem; }

  .chip { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 4px; font-size: 0.7rem; font-weight: 500; }
  .chip-good { background: rgba(34,197,94,0.15); color: var(--good); }
  .chip-warn { background: rgba(245,158,11,0.15); color: var(--warn); }
  .chip-bad { background: rgba(239,68,68,0.15); color: var(--bad); }
  .chip-info { background: rgba(59,130,246,0.15); color: #93c5fd; }
  .chip-dim { background: var(--border); color: var(--muted); }

  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 1rem; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; max-width: 540px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .modal h2 { margin-bottom: 0.25rem; }

  .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.85rem 1.25rem; border-radius: 8px; color: white; box-shadow: 0 10px 25px rgba(0,0,0,0.4); z-index: 200; font-size: 0.85rem; max-width: 360px; }
  .toast.ok { background: #166534; }
  .toast.err { background: #991b1b; }

  .key-display { font-family: ui-monospace, monospace; font-size: 0.85rem; background: var(--bg); border: 1px solid var(--accent); border-radius: 6px; padding: 0.75rem 1rem; word-break: break-all; user-select: all; margin: 0.75rem 0; color: #93c5fd; }

  .cap-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.4rem; font-size: 0.75rem; margin-top: 0.5rem; }
  .cap { display: flex; align-items: center; gap: 0.3rem; color: var(--muted); }
  .cap.yes { color: var(--good); }
  .cap.no { color: var(--dim); }

  .kv { display: grid; grid-template-columns: minmax(160px, 1fr) 2fr; gap: 0.5rem 1rem; font-size: 0.85rem; }
  .kv .k { color: var(--muted); }
  .kv .v { color: var(--text); word-break: break-all; }

  .footer-note { color: var(--dim); font-size: 0.75rem; margin-top: 2rem; }

  @media (max-width: 720px) {
    .app { grid-template-columns: 1fr; }
    .sidebar { display: none; }
    main { padding: 1rem; }
    .grid-4 { grid-template-columns: repeat(2, 1fr); }
    .grid-2 { grid-template-columns: 1fr; }
  }
</style>
</head>
<body x-data="dashboard()" x-init="boot()" x-cloak>

<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">AI</div>
      <div>
        <div class="title">ai-api-bridge</div>
        <div class="sub">control panel</div>
      </div>
    </div>
    <div class="nav-section">General</div>
    <div class="nav-item" :class="page==='overview' && 'active'" @click="setPage('overview')"><span>▣</span><span>Overview</span></div>

    <div class="nav-section">Resources</div>
    <div class="nav-item" :class="page==='keys' && 'active'" @click="setPage('keys')"><span>🔑</span><span>API Keys</span></div>
    <div class="nav-item" :class="page==='models' && 'active'" @click="setPage('models')"><span>✦</span><span>Models</span></div>

    <div class="nav-section">System</div>
    <div class="nav-item" :class="page==='oauth' && 'active'" @click="setPage('oauth')"><span>🔐</span><span>OAuth</span></div>
    <div class="nav-item" :class="page==='settings' && 'active'" @click="setPage('settings')"><span>⚙</span><span>Settings</span></div>

    <div class="nav-spacer"></div>
    <div class="nav-bottom">
      <div>v<span x-text="system.version || '?'"></span></div>
      <div x-text="'uptime ' + (system.uptimeHuman || '...')"></div>
      <div style="margin-top:0.5rem"><a href="/admin/logout">Sign out</a></div>
    </div>
  </aside>

  <main>
    <!-- ================== OVERVIEW ================== -->
    <template x-if="page === 'overview'">
      <div>
        <div class="page-header">
          <div>
            <div class="page-title">Overview</div>
            <div class="page-sub">Activity over the last <select x-model="range" @change="refreshStats()" class="input" style="display:inline-block;width:auto;padding:0.2rem 0.5rem;font-size:0.8rem"><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select></div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="refreshAll()">↻ Refresh</button>
        </div>

        <div class="grid grid-4">
          <div class="card stat"><div class="label">Requests</div><div class="value" x-text="fmt(stats.overall?.totalRequests || 0)"></div></div>
          <div class="card stat"><div class="label">Input tokens</div><div class="value" x-text="fmt(stats.overall?.totalInputTokens || 0)"></div></div>
          <div class="card stat"><div class="label">Output tokens</div><div class="value" x-text="fmt(stats.overall?.totalOutputTokens || 0)"></div></div>
          <div class="card stat"><div class="label">Errors</div><div class="value" :style="(stats.overall?.errorCount || 0) > 0 ? 'color:var(--bad)' : ''" x-text="fmt(stats.overall?.errorCount || 0)"></div></div>
        </div>

        <div class="card" style="margin-top:1.5rem">
          <h2>Equivalent list-price cost</h2>
          <p style="color:var(--muted);font-size:0.8rem;margin:0 0 0.75rem">What this traffic would cost at the provider's published per-token API prices. It is an estimate for comparison, not a bill.</p>
          <div class="grid grid-2">
            <div><span class="chip chip-info">USD</span> <strong style="font-size:1.4rem;margin-left:0.5rem" x-text="'$' + costUSD().toFixed(4)"></strong></div>
            <div><span class="chip chip-info">BRL</span> <strong style="font-size:1.4rem;margin-left:0.5rem" x-text="'R$' + (costUSD() * 5.2).toFixed(2)"></strong></div>
          </div>
        </div>

        <div class="card" style="margin-top:1.5rem">
          <h2>Latency by model (ms)</h2>
          <table>
            <thead><tr><th>Model</th><th class="num">Count</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th></tr></thead>
            <tbody>
              <template x-for="m in (stats.latencyByModel || [])" :key="m.model">
                <tr><td x-text="m.model"></td><td class="num" x-text="fmt(m.count)"></td><td class="num" x-text="fmt(m.p50Ms)"></td><td class="num" x-text="fmt(m.p95Ms)"></td><td class="num" x-text="fmt(m.p99Ms)"></td></tr>
              </template>
              <tr x-show="(stats.latencyByModel || []).length === 0"><td colspan="5" style="color:var(--dim);text-align:center">No data yet.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card" style="margin-top:1.5rem">
          <h2>Usage by API key</h2>
          <table>
            <thead><tr><th>Key</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th></tr></thead>
            <tbody>
              <template x-for="k in (stats.perKey || [])" :key="k.apiKeyId">
                <tr><td x-text="k.name"></td><td class="num" x-text="fmt(k.requests)"></td><td class="num" x-text="fmt(k.inputTokens)"></td><td class="num" x-text="fmt(k.outputTokens)"></td></tr>
              </template>
              <tr x-show="(stats.perKey || []).length === 0"><td colspan="4" style="color:var(--dim);text-align:center">No data yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ================== API KEYS ================== -->
    <template x-if="page === 'keys'">
      <div>
        <div class="page-header">
          <div>
            <div class="page-title">API Keys</div>
            <div class="page-sub">Issue one key per client application. The full value is shown only when the key is created — it is stored hashed and cannot be recovered afterwards.</div>
          </div>
          <button class="btn btn-primary" @click="openCreateKey()">+ Create key</button>
        </div>

        <div class="card">
          <table>
            <thead><tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Status</th>
              <th class="num">RPM</th>
              <th class="num">TPM</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th></th>
            </tr></thead>
            <tbody>
              <template x-for="k in keys" :key="k.id">
                <tr>
                  <td><strong x-text="k.name"></strong></td>
                  <td class="mono" x-text="k.keyPrefix + '...'"></td>
                  <td><span :class="'chip ' + keyStatusChip(k)" x-text="keyStatusLabel(k)"></span></td>
                  <td class="num mono" x-text="fmt(k.rateLimitRpm)"></td>
                  <td class="num mono" x-text="fmt(k.rateLimitTpm)"></td>
                  <td x-text="formatDate(k.createdAt)" style="color:var(--muted)"></td>
                  <td x-text="k.lastUsedAt ? formatDate(k.lastUsedAt) : '—'" style="color:var(--muted)"></td>
                  <td x-text="k.expiresAt ? formatDate(k.expiresAt) : 'Never'" style="color:var(--muted)"></td>
                  <td style="white-space:nowrap">
                    <button x-show="!k.revokedAt && (!k.expiresAt || k.expiresAt > Date.now())" class="btn btn-ghost btn-sm" @click="openEditKey(k)" style="margin-right:4px">Edit</button>
                    <button x-show="!k.revokedAt && (!k.expiresAt || k.expiresAt > Date.now())" class="btn btn-danger btn-sm" @click="revokeKey(k)">Revoke</button>
                  </td>
                </tr>
              </template>
              <tr x-show="keys.length === 0"><td colspan="9" style="color:var(--dim);text-align:center">No keys yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ================== MODELS ================== -->
    <template x-if="page === 'models'">
      <div>
        <div class="page-header">
          <div>
            <div class="page-title">Available models</div>
            <div class="page-sub">OpenAI aliases (gpt-4o, gpt-4o-mini and friends) are routed to the matching Anthropic model, so an OpenAI client needs no change beyond its base URL. The prices below are the provider's published rates, shown so the usage figures can be read in context.</div>
          </div>
        </div>

        <template x-for="m in models" :key="m.id">
          <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <h2 style="margin:0" x-text="m.displayName"></h2>
                <div style="color:var(--dim);font-size:0.75rem;margin-top:0.15rem">
                  <span class="mono" x-text="m.id"></span>
                </div>
              </div>
              <span class="chip chip-info" x-text="m.family"></span>
            </div>
            <p style="color:var(--muted);margin:0.75rem 0" x-text="m.description"></p>

            <div class="grid grid-2" style="margin-top:1rem">
              <div>
                <h3>Specifications</h3>
                <div class="kv">
                  <div class="k">Context window</div><div class="v mono" x-text="fmt(m.contextWindowTokens) + ' tokens'"></div>
                  <div class="k">Max output</div><div class="v mono" x-text="fmt(m.maxOutputTokens) + ' tokens'"></div>
                </div>
              </div>
              <div>
                <h3>List price (USD / 1M tokens)</h3>
                <div class="kv">
                  <div class="k">Input</div><div class="v mono" x-text="'$' + m.pricing.inputPerMTok.toFixed(2)"></div>
                  <div class="k">Output</div><div class="v mono" x-text="'$' + m.pricing.outputPerMTok.toFixed(2)"></div>
                  <div class="k">Cache write</div><div class="v mono" x-text="'$' + m.pricing.cacheWritePerMTok.toFixed(2)"></div>
                  <div class="k">Cache read</div><div class="v mono" x-text="'$' + m.pricing.cacheReadPerMTok.toFixed(2)"></div>
                </div>
              </div>
            </div>

            <h3 style="margin-top:1rem">Capabilities</h3>
            <div class="cap-grid">
              <div :class="'cap ' + (m.capabilities.streaming ? 'yes' : 'no')"><span x-text="m.capabilities.streaming ? '✓' : '✗'"></span> Streaming</div>
              <div :class="'cap ' + (m.capabilities.vision ? 'yes' : 'no')"><span x-text="m.capabilities.vision ? '✓' : '✗'"></span> Vision (images)</div>
              <div :class="'cap ' + (m.capabilities.toolUse ? 'yes' : 'no')"><span x-text="m.capabilities.toolUse ? '✓' : '✗'"></span> Tool use</div>
              <div :class="'cap ' + (m.capabilities.computerUse ? 'yes' : 'no')"><span x-text="m.capabilities.computerUse ? '✓' : '✗'"></span> Computer use</div>
              <div :class="'cap ' + (m.capabilities.promptCaching ? 'yes' : 'no')"><span x-text="m.capabilities.promptCaching ? '✓' : '✗'"></span> Prompt caching</div>
              <div :class="'cap ' + (m.capabilities.extendedThinking ? 'yes' : 'no')"><span x-text="m.capabilities.extendedThinking ? '✓' : '✗'"></span> Extended thinking</div>
            </div>

            <h3 style="margin-top:1rem">Accepted aliases (send any of them as <code>model</code>)</h3>
            <div style="display:flex;flex-wrap:wrap;gap:0.35rem">
              <template x-for="a in m.aliases" :key="a"><span class="chip chip-dim mono" x-text="a"></span></template>
            </div>
          </div>
        </template>
      </div>
    </template>

    <!-- ================== OAUTH ================== -->
    <template x-if="page === 'oauth'">
      <div>
        <div class="page-header">
          <div>
            <div class="page-title">OAuth status</div>
            <div class="page-sub">State of the upstream credential and of the refresh machinery around it.</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="refreshOAuth()">↻ Refresh</button>
        </div>

        <div class="card">
          <div class="kv">
            <div class="k">Token valid</div>
            <div class="v"><span :class="'chip ' + (oauth.accessTokenValid ? 'chip-good' : 'chip-bad')" x-text="oauth.accessTokenValid ? 'yes' : 'no'"></span></div>

            <div class="k">Expires</div>
            <div class="v"><span x-text="oauth.expiresAt ? formatDate(oauth.expiresAt) : '—'"></span> <span style="color:var(--dim)" x-text="oauth.expiresInSeconds ? '(' + humanDuration(oauth.expiresInSeconds * 1000) + ')' : ''"></span></div>

            <div class="k">Type</div>
            <div class="v"><span :class="'chip ' + (oauth.isLongLived ? 'chip-good' : 'chip-info')" x-text="oauth.isLongLived ? 'long-lived (~1 year, never refreshed)' : 'short-lived (auto-refresh)'"></span></div>

            <div class="k">Circuit breaker</div>
            <div class="v"><span :class="'chip ' + (oauth.circuitBreakerState === 'closed' ? 'chip-good' : 'chip-warn')" x-text="oauth.circuitBreakerState || '—'"></span></div>

            <div class="k">Last refresh</div>
            <div class="v" x-text="oauth.lastRefreshAt ? formatDate(oauth.lastRefreshAt) : 'never (long-lived, or not rotated yet)'"></div>
          </div>
          <p style="color:var(--dim);font-size:0.8rem;margin-top:1.25rem">
            If the credential expires or is revoked, write a fresh one to the file named by <code>CREDENTIALS_PATH</code>. The gateway re-reads it on the next call — no restart needed.
          </p>
        </div>
      </div>
    </template>

    <!-- ================== SETTINGS ================== -->
    <template x-if="page === 'settings'">
      <div>
        <div class="page-header">
          <div>
            <div class="page-title">Settings &amp; system</div>
            <div class="page-sub">Operational facts about the running process.</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="refreshSystem()">↻ Refresh</button>
        </div>

        <div class="grid grid-2">
          <div class="card">
            <h2>Server</h2>
            <div class="kv">
              <div class="k">Version</div><div class="v mono" x-text="system.version"></div>
              <div class="k">Node</div><div class="v mono" x-text="system.nodeVersion"></div>
              <div class="k">Hostname</div><div class="v mono" x-text="system.hostname"></div>
              <div class="k">Platform</div><div class="v mono" x-text="system.platform"></div>
              <div class="k">Uptime</div><div class="v mono" x-text="system.uptimeHuman"></div>
              <div class="k">PID</div><div class="v mono" x-text="system.pid"></div>
              <div class="k">Memory</div><div class="v mono" x-text="system.memoryHuman"></div>
            </div>
          </div>
          <div class="card">
            <h2>Database</h2>
            <div class="kv">
              <div class="k">Path</div><div class="v mono" x-text="system.dbPath"></div>
              <div class="k">Size</div><div class="v mono" x-text="system.dbSizeHuman"></div>
              <div class="k">Mode</div><div class="v mono">WAL</div>
              <div class="k">Migrations applied</div><div class="v mono" x-text="(system.migrations || []).join(', ')"></div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:1rem">
          <h2>Exposed endpoints</h2>
          <table>
            <thead><tr><th>URL</th><th>Auth</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td class="mono">POST /v1/chat/completions</td><td><span class="chip chip-info">Bearer / x-api-key</span></td><td>OpenAI-compatible (streaming + non-streaming, tools, vision)</td></tr>
              <tr><td class="mono">POST /v1/messages</td><td><span class="chip chip-info">Bearer / x-api-key</span></td><td>Anthropic-compatible (native passthrough)</td></tr>
              <tr><td class="mono">POST /v1/messages/count_tokens</td><td><span class="chip chip-info">Bearer / x-api-key</span></td><td>Counts tokens without running inference</td></tr>
              <tr><td class="mono">GET /v1/models</td><td><span class="chip chip-info">Bearer / x-api-key</span></td><td>Lists the model aliases</td></tr>
              <tr><td class="mono">GET /healthz</td><td><span class="chip chip-dim">public</span></td><td>Liveness (always 200 while the process is up)</td></tr>
              <tr><td class="mono">GET /readyz</td><td><span class="chip chip-dim">public</span></td><td>Readiness (DB + OAuth check)</td></tr>
              <tr><td class="mono">/admin/*</td><td><span class="chip chip-info">admin token / cookie</span></td><td>This dashboard and the JSON endpoints behind it</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

  </main>
</div>

<!-- ================== MODAL: Create Key ================== -->
<template x-if="showCreateModal">
  <div class="modal-bg" @click.self="closeCreateModal()">
    <div class="modal">
      <h2>New API key</h2>
      <p style="color:var(--muted);font-size:0.85rem;margin:0.25rem 0 1.25rem">Set this key's limits. The full value appears ONCE, right after it is created.</p>

      <label class="field">
        <span class="label">Name / application</span>
        <input class="input" x-model="newKey.name" placeholder="e.g. mobile-app, n8n, sandbox" autofocus />
        <span class="hint">Identifies this key in the logs and in this dashboard.</span>
      </label>

      <div class="grid grid-2">
        <label class="field">
          <span class="label">Rate limit · requests/min</span>
          <input type="number" class="input mono" x-model.number="newKey.rateLimitRpm" min="1" />
          <span class="hint">Default 60. The provider's own limits apply on top of this one.</span>
        </label>
        <label class="field">
          <span class="label">Rate limit · tokens/min</span>
          <input type="number" class="input mono" x-model.number="newKey.rateLimitTpm" min="1000" step="1000" />
          <span class="hint">Default 100k. Input plus output.</span>
        </label>
      </div>

      <label class="field">
        <span class="label">Daily token budget (optional)</span>
        <input type="number" class="input mono" x-model.number="newKey.dailyTokenBudget" placeholder="leave empty for unlimited" min="0" step="1000" />
        <span class="hint">Once set, requests are refused for the rest of the day when the key's input+output total passes it.</span>
      </label>

      <label class="field">
        <span class="label">Expires</span>
        <select class="input" x-model="newKey.expiresPreset" @change="newKey.expiresInDays = newKey.expiresPreset === 'custom' ? (newKey.expiresInDays || 30) : Number(newKey.expiresPreset)">
          <option value="0">Never expires</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="180">180 days</option>
          <option value="365">1 year</option>
          <option value="custom">Custom</option>
        </select>
        <input x-show="newKey.expiresPreset === 'custom'" type="number" class="input mono" x-model.number="newKey.expiresInDays" min="1" placeholder="days" style="margin-top:0.5rem" />
        <span class="hint" x-show="newKey.expiresPreset && newKey.expiresPreset !== '0'">After that date the key is rejected automatically — no manual revocation needed.</span>
      </label>

      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
        <button class="btn btn-ghost" @click="closeCreateModal()">Cancel</button>
        <button class="btn btn-primary" :disabled="!newKey.name || creating" @click="submitCreateKey()" x-text="creating ? 'Creating...' : 'Create key'"></button>
      </div>
    </div>
  </div>
</template>

<!-- ================== MODAL: Edit Key ================== -->
<template x-if="editKey">
  <div class="modal-bg" @click.self="closeEditKey()">
    <div class="modal">
      <h2>Edit limits</h2>
      <p style="color:var(--muted);font-size:0.85rem;margin:0.25rem 0 1.25rem">
        <strong x-text="editKey.name"></strong> ·
        <span class="mono" x-text="editKey.keyPrefix + '...'"></span>
      </p>

      <div class="grid grid-2">
        <label class="field">
          <span class="label">Rate limit · requests/min</span>
          <input type="number" class="input mono" x-model.number="editKey.rateLimitRpm" min="1" />
        </label>
        <label class="field">
          <span class="label">Rate limit · tokens/min</span>
          <input type="number" class="input mono" x-model.number="editKey.rateLimitTpm" min="1000" step="1000" />
        </label>
      </div>

      <label class="field">
        <span class="label">Daily token budget (optional)</span>
        <input type="number" class="input mono" x-model.number="editKey.dailyTokenBudget" placeholder="empty = unlimited" min="0" step="1000" />
        <span class="hint">Leave it empty to drop the daily quota.</span>
      </label>

      <label class="field">
        <span class="label">Expiration</span>
        <select class="input" x-model="editKey.expiresPreset" @change="onEditExpiresPresetChange()">
          <option value="keep">Keep current (<span x-text="editKey.expiresAt ? formatDate(editKey.expiresAt) : 'no expiry'"></span>)</option>
          <option value="0">Remove expiry (never expires)</option>
          <option value="7">Extend to 7 days from now</option>
          <option value="30">Extend to 30 days from now</option>
          <option value="90">Extend to 90 days from now</option>
          <option value="180">Extend to 180 days from now</option>
          <option value="365">Extend to 1 year from now</option>
          <option value="custom">Custom (in days)</option>
        </select>
        <input x-show="editKey.expiresPreset === 'custom'" type="number" class="input mono" x-model.number="editKey.expiresInDays" min="1" placeholder="days" style="margin-top:0.5rem" />
      </label>

      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
        <button class="btn btn-ghost" @click="closeEditKey()">Cancel</button>
        <button class="btn btn-primary" :disabled="editingSaving" @click="submitEditKey()" x-text="editingSaving ? 'Saving...' : 'Save changes'"></button>
      </div>
    </div>
  </div>
</template>

<!-- ================== MODAL: Created (one-time view) ================== -->
<template x-if="createdKey">
  <div class="modal-bg" @click.self="acknowledgeCreated()">
    <div class="modal">
      <h2 style="color:var(--good)">✓ Key created</h2>
      <p style="color:var(--muted);font-size:0.85rem;margin:0.25rem 0 1rem">Copy the value below NOW — it cannot be shown again.</p>
      <div class="key-display" x-text="createdKey.plaintext"></div>
      <p style="font-size:0.8rem;color:var(--muted)">
        <strong x-text="createdKey.row.name"></strong> ·
        <span x-text="createdKey.row.rateLimitRpm + ' RPM · ' + fmt(createdKey.row.rateLimitTpm) + ' TPM'"></span> ·
        <span x-text="createdKey.row.expiresAt ? 'expires ' + formatDate(createdKey.row.expiresAt) : 'no expiry'"></span>
      </p>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1.5rem">
        <button class="btn btn-ghost" @click="copyToClipboard(createdKey.plaintext)">📋 Copy</button>
        <button class="btn btn-primary" @click="acknowledgeCreated()">Copied, close</button>
      </div>
    </div>
  </div>
</template>

<!-- ================== TOAST ================== -->
<template x-if="toast">
  <div :class="'toast ' + toast.kind" x-text="toast.message"></div>
</template>

<script>
function dashboard() {
  return {
    page: location.hash.replace('#', '') || 'overview',
    range: '24',
    stats: { overall: null, latencyByModel: [], perKey: [] },
    keys: [],
    models: [],
    oauth: {},
    system: {},
    showCreateModal: false,
    creating: false,
    newKey: { name: '', rateLimitRpm: 60, rateLimitTpm: 100000, dailyTokenBudget: null, expiresPreset: '0', expiresInDays: null },
    createdKey: null,
    editKey: null,
    editingSaving: false,
    toast: null,

    async boot() {
      window.addEventListener('hashchange', () => { this.page = location.hash.replace('#', '') || 'overview'; this.lazyLoad(); });
      await this.refreshAll();
    },
    setPage(p) { this.page = p; location.hash = p; this.lazyLoad(); },
    lazyLoad() {
      if (this.page === 'keys' && this.keys.length === 0) this.refreshKeys();
      if (this.page === 'models' && this.models.length === 0) this.refreshModels();
      if (this.page === 'oauth' && !this.oauth.expiresAt) this.refreshOAuth();
      if (this.page === 'settings' && !this.system.version) this.refreshSystem();
    },
    async refreshAll() {
      await Promise.all([this.refreshStats(), this.refreshSystem(), this.refreshKeys(), this.refreshModels(), this.refreshOAuth()]);
    },
    async refreshStats() {
      const r = await this.api('GET', '/admin/api/stats?rangeHours=' + this.range);
      if (r) this.stats = r;
    },
    async refreshKeys() { const r = await this.api('GET', '/admin/api/keys'); if (r) this.keys = r.data; },
    async refreshModels() { const r = await this.api('GET', '/admin/api/models'); if (r) this.models = r.data; },
    async refreshOAuth() { const r = await this.api('GET', '/admin/api/oauth-status'); if (r) this.oauth = r; },
    async refreshSystem() { const r = await this.api('GET', '/admin/api/system'); if (r) this.system = r; },

    openCreateKey() {
      this.newKey = { name: '', rateLimitRpm: 60, rateLimitTpm: 100000, dailyTokenBudget: null, expiresPreset: '0', expiresInDays: null };
      this.showCreateModal = true;
    },
    closeCreateModal() { this.showCreateModal = false; },
    async submitCreateKey() {
      if (!this.newKey.name) return;
      this.creating = true;
      const body = {
        name: this.newKey.name.trim(),
        rateLimitRpm: this.newKey.rateLimitRpm || 60,
        rateLimitTpm: this.newKey.rateLimitTpm || 100000,
        dailyTokenBudget: this.newKey.dailyTokenBudget || null,
      };
      const days = this.newKey.expiresPreset === '0' ? null : (this.newKey.expiresPreset === 'custom' ? this.newKey.expiresInDays : Number(this.newKey.expiresPreset));
      if (days && days > 0) body.expiresInDays = days;
      const r = await this.api('POST', '/admin/api/keys', body);
      this.creating = false;
      if (r) {
        this.createdKey = r;
        this.showCreateModal = false;
        this.refreshKeys();
        this.showToast('Key created.', 'ok');
      }
    },
    acknowledgeCreated() { this.createdKey = null; },
    async revokeKey(k) {
      if (!confirm('Revoke the key "' + k.name + '"? Any application still using it starts getting 401 immediately.')) return;
      const r = await this.api('POST', '/admin/api/keys/' + k.id + '/revoke');
      if (r !== null) { this.showToast('Key revoked.', 'ok'); this.refreshKeys(); }
    },
    openEditKey(k) {
      // Clone the row + add transient fields for the modal form. Never
      // mutate the original key in this.keys; the dashboard re-fetches
      // after save and shows the canonical server-side values.
      this.editKey = {
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        rateLimitRpm: k.rateLimitRpm,
        rateLimitTpm: k.rateLimitTpm,
        dailyTokenBudget: k.dailyTokenBudget,
        expiresAt: k.expiresAt,
        expiresPreset: 'keep',
        expiresInDays: 30,
      };
    },
    closeEditKey() { this.editKey = null; },
    onEditExpiresPresetChange() {
      // Custom preset → enable the "days" input with a sensible default.
      if (this.editKey && this.editKey.expiresPreset === 'custom' && !this.editKey.expiresInDays) {
        this.editKey.expiresInDays = 30;
      }
    },
    async submitEditKey() {
      if (!this.editKey) return;
      this.editingSaving = true;
      const k = this.editKey;
      const body = {};
      if (typeof k.rateLimitRpm === 'number' && k.rateLimitRpm > 0) body.rateLimitRpm = k.rateLimitRpm;
      if (typeof k.rateLimitTpm === 'number' && k.rateLimitTpm > 0) body.rateLimitTpm = k.rateLimitTpm;
      // dailyTokenBudget: empty string / NaN → null (remove quota); else send the number.
      if (k.dailyTokenBudget === null || k.dailyTokenBudget === '' || Number.isNaN(k.dailyTokenBudget)) {
        body.dailyTokenBudget = null;
      } else if (typeof k.dailyTokenBudget === 'number' && k.dailyTokenBudget >= 0) {
        body.dailyTokenBudget = k.dailyTokenBudget;
      }
      // Expiration:
      //   'keep'   -> omit from the body (the server leaves it alone)
      //   '0'      -> expiresInDays:0 (the server clears the expiry)
      //   '<num>'  -> expiresInDays:<num>
      //   'custom' -> expiresInDays = k.expiresInDays
      if (k.expiresPreset === '0') {
        body.expiresInDays = 0;
      } else if (k.expiresPreset === 'custom' && k.expiresInDays > 0) {
        body.expiresInDays = k.expiresInDays;
      } else if (k.expiresPreset && k.expiresPreset !== 'keep') {
        const n = Number(k.expiresPreset);
        if (Number.isFinite(n) && n > 0) body.expiresInDays = n;
      }
      const r = await this.api('PATCH', '/admin/api/keys/' + k.id, body);
      this.editingSaving = false;
      if (r) {
        this.editKey = null;
        this.refreshKeys();
        this.showToast('Limits updated.', 'ok');
      }
    },
    async copyToClipboard(text) {
      try { await navigator.clipboard.writeText(text); this.showToast('Copied.', 'ok'); }
      catch (e) { this.showToast('Copy failed — select the value manually.', 'err'); }
    },

    async api(method, path, body) {
      try {
        const opts = { method, credentials: 'same-origin', headers: { 'accept': 'application/json' } };
        if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
        const r = await fetch(path, opts);
        if (r.status === 401) { location.href = '/admin/login'; return null; }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          this.showToast('Error ' + r.status + ': ' + (err.error?.message || r.statusText), 'err');
          return null;
        }
        if (r.status === 204) return {};
        return await r.json();
      } catch (e) { this.showToast('Network error: ' + e.message, 'err'); return null; }
    },

    showToast(message, kind = 'ok') {
      this.toast = { message, kind };
      setTimeout(() => { this.toast = null; }, 3500);
    },

    fmt(n) { return Number(n || 0).toLocaleString('en-US'); },
    formatDate(ms) { if (!ms) return '—'; const d = new Date(ms); return d.toLocaleString('en-US'); },
    humanDuration(ms) {
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'min';
      const h = Math.floor(m / 60);
      if (h < 48) return h + 'h';
      const d = Math.floor(h / 24);
      if (d < 60) return d + ' days';
      const mo = Math.floor(d / 30);
      return mo + ' months';
    },
    keyStatusLabel(k) {
      if (k.revokedAt) return 'revoked';
      if (k.expiresAt && k.expiresAt < Date.now()) return 'expired';
      if (!k.enabled) return 'disabled';
      return 'active';
    },
    keyStatusChip(k) {
      const l = this.keyStatusLabel(k);
      if (l === 'active') return 'chip-good';
      if (l === 'expired') return 'chip-warn';
      return 'chip-bad';
    },
    costUSD() {
      const o = this.stats.overall;
      if (!o) return 0;
      // Approximate using opus rates as a "worst case" — pricing varies per model.
      const inUSD = (o.totalInputTokens || 0) / 1_000_000 * 15;
      const outUSD = (o.totalOutputTokens || 0) / 1_000_000 * 75;
      return inUSD + outUSD;
    },
  };
}
</script>
</body></html>`;
