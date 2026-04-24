/**
 * Dashboard auth + static asset serving.
 *
 * Security model:
 *   - Login via POST /admin/dashboard/login with { token } body
 *   - Token validated against CONFIG_API_TOKEN secret (timing-safe compare)
 *   - On success: HMAC-SHA256 signed session cookie (HttpOnly, Secure, SameSite=Strict)
 *   - Cookie contains: expiry timestamp + HMAC signature
 *   - Every dashboard request validates the cookie signature + expiry
 *   - No cookie or invalid cookie → login page (no redirect to avoid leaking paths)
 *   - 24h session expiry
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { timingSafeEqual } from '../util';
import {
	createSession,
	validateSession,
	getCookie,
	sessionCookieHeader,
	SESSION_COOKIE_NAME,
	SESSION_TTL_MS,
} from '../session';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Login page HTML — minimal, no external deps. */
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>video-resizer dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fafafa;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#141414;border:1px solid #262626;border-radius:12px;padding:32px;width:100%;max-width:380px}
h1{font-size:18px;font-weight:600;margin-bottom:8px}
p{font-size:13px;color:#a1a1aa;margin-bottom:24px}
input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid #262626;background:#0a0a0a;color:#fafafa;font-size:14px;outline:none;margin-bottom:16px}
input:focus{border-color:#3b82f6}
button{width:100%;padding:10px;border-radius:8px;border:none;background:#3b82f6;color:white;font-size:14px;font-weight:500;cursor:pointer}
button:hover{background:#2563eb}
.error{color:#ef4444;font-size:13px;margin-bottom:16px;display:none}
</style>
</head>
<body>
<div class="card">
<h1>video-resizer</h1>
<p>Enter your API token to access the dashboard.</p>
<div id="error" class="error"></div>
<form id="form">
<input type="password" id="token" placeholder="API token" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
</div>
<script>
document.getElementById('form').addEventListener('submit',async e=>{
e.preventDefault();
const token=document.getElementById('token').value;
const errEl=document.getElementById('error');
errEl.style.display='none';
try{
const r=await fetch('/admin/dashboard/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
if(r.ok){window.location.href='/admin/dashboard';}
else{const d=await r.json();errEl.textContent=d.error||'Invalid token';errEl.style.display='block';}
}catch(err){errEl.textContent='Network error';errEl.style.display='block';}
});
</script>
</body>
</html>`;

/** POST /admin/dashboard/login — validate token, set session cookie. */
export async function dashboardLogin(c: HonoContext) {
	const token = c.env.CONFIG_API_TOKEN;
	if (!token) {
		return c.json({ error: 'Dashboard not configured (missing CONFIG_API_TOKEN)' }, 503);
	}

	let body: { token?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!body.token || typeof body.token !== 'string') {
		return c.json({ error: 'Missing token' }, 400);
	}

	if (!timingSafeEqual(body.token, token)) {
		// Constant-time compare prevents timing attacks
		return c.json({ error: 'Invalid token' }, 401);
	}

	const session = await createSession(token);
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
			'Set-Cookie': sessionCookieHeader(session, SESSION_TTL_MS / 1000),
		},
	});
}

/** GET /admin/dashboard — validate session, serve dashboard or login page. */
export async function dashboardAuth(c: HonoContext) {
	const token = c.env.CONFIG_API_TOKEN;
	if (!token) {
		return c.text('Dashboard not configured (missing CONFIG_API_TOKEN)', 503);
	}

	if (!c.env.ASSETS) {
		return c.text('Dashboard not available (ASSETS binding missing)', 404);
	}

	// Check session cookie
	const sessionCookie = getCookie(c.req.raw, SESSION_COOKIE_NAME);
	if (!sessionCookie || !(await validateSession(sessionCookie, token))) {
		// No valid session — serve login page
		return new Response(LOGIN_HTML, {
			status: 200,
			headers: {
				'Content-Type': 'text/html;charset=utf-8',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
			},
		});
	}

	// Valid session — serve dashboard assets
	const url = new URL(c.req.url);
	const assetPath = url.pathname.replace('/admin/dashboard', '') || '/index.html';
	if (assetPath === '/' || assetPath === '') {
		const assetUrl = new URL('/index.html', url.origin);
		return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
	}
	const assetUrl = new URL(assetPath, url.origin);
	return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
}
