import { JWT, OAuth2Client } from 'google-auth-library'

const scopes = [
	'https://www.googleapis.com/auth/drive',
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/presentations',
]

export let auth

function norm(v) {
	if (typeof v !== 'string') return
	v = v.trim()
	return v ? v : undefined
}

function envOauth() {
	let GOOGLE_CLIENT_ID = norm(process.env.GOOGLE_CLIENT_ID)
	let GOOGLE_CLIENT_SECRET = norm(process.env.GOOGLE_CLIENT_SECRET)
	let GOOGLE_REFRESH_TOKEN = norm(process.env.GOOGLE_REFRESH_TOKEN)
	let any = !!(GOOGLE_CLIENT_ID || GOOGLE_CLIENT_SECRET || GOOGLE_REFRESH_TOKEN)
	let ok = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN)
	return { any, ok, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN }
}

function envServiceAccount() {
	let SERVICE_ACCOUNT_EMAIL = norm(process.env.SERVICE_ACCOUNT_EMAIL)
	let SERVICE_ACCOUNT_KEY = norm(process.env.SERVICE_ACCOUNT_KEY)
	let any = !!(SERVICE_ACCOUNT_EMAIL || SERVICE_ACCOUNT_KEY)
	let ok = !!(SERVICE_ACCOUNT_EMAIL && SERVICE_ACCOUNT_KEY)
	return { any, ok, SERVICE_ACCOUNT_EMAIL, SERVICE_ACCOUNT_KEY }
}

function createOauthClientFromEnv(cfg) {
	const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET)
	client.setCredentials({ refresh_token: cfg.GOOGLE_REFRESH_TOKEN })
	return client
}

function createServiceAccountClientFromEnv(cfg) {
	return new JWT({
		email: cfg.SERVICE_ACCOUNT_EMAIL,
		key: cfg.SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
		scopes,
	})
}

function missingKeys(cfg, keys) {
	let out = []
	for (let k of keys) {
		if (!cfg[k]) out.push(k)
	}
	return out
}

let oauth = envOauth()
let sa = envServiceAccount()

// Default: prefer service account when configured (more stable for automation).
if (sa.ok) {
	auth = createServiceAccountClientFromEnv(sa)
} else if (oauth.ok) {
	auth = createOauthClientFromEnv(oauth)
} else if (sa.any || oauth.any) {
	let parts = []
	if (sa.any) parts.push(`service account missing: ${missingKeys(sa, ['SERVICE_ACCOUNT_EMAIL', 'SERVICE_ACCOUNT_KEY']).join(', ')}`)
	if (oauth.any) parts.push(`oauth missing: ${missingKeys(oauth, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']).join(', ')}`)
	throw new Error(`Incomplete Google auth config (${parts.join('; ')}). Choose OAuth OR service account.`)
} else {
	throw new Error('Missing Google auth config. Set OAuth or service account env vars.')
}
