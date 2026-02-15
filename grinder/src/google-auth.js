import { JWT, OAuth2Client } from 'google-auth-library'

const scopes = [
	'https://www.googleapis.com/auth/drive',
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/presentations',
]

function createOauthClient() {
	const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env
	if (!GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_SECRET && !GOOGLE_REFRESH_TOKEN) return null
	if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
		throw new Error('Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN for OAuth')
	}
	const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
	client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN })
	return client
}

function createServiceAccountClient() {
	const { SERVICE_ACCOUNT_EMAIL, SERVICE_ACCOUNT_KEY } = process.env
	if (!SERVICE_ACCOUNT_EMAIL && !SERVICE_ACCOUNT_KEY) return null
	if (!SERVICE_ACCOUNT_EMAIL || !SERVICE_ACCOUNT_KEY) {
		throw new Error('Missing SERVICE_ACCOUNT_EMAIL/SERVICE_ACCOUNT_KEY for service account auth')
	}
	return new JWT({
		email: SERVICE_ACCOUNT_EMAIL,
		key: SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
		scopes,
	})
}

export let auth = createOauthClient() ?? createServiceAccountClient()
if (!auth) {
	throw new Error('Missing Google auth config. Set OAuth or service account env vars.')
}
