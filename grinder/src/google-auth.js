import { JWT } from 'google-auth-library'

let auth
if (process.env.MOCK_SHEETS === '1') {
	auth = null
} else {
	const { SERVICE_ACCOUNT_EMAIL, SERVICE_ACCOUNT_KEY } = process.env
	if (!SERVICE_ACCOUNT_EMAIL || !SERVICE_ACCOUNT_KEY) {
		throw new Error('Missing SERVICE_ACCOUNT_EMAIL/SERVICE_ACCOUNT_KEY')
	}
	auth = new JWT({
		email: SERVICE_ACCOUNT_EMAIL,
		key: SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
		scopes: [
			'https://www.googleapis.com/auth/drive',
			'https://www.googleapis.com/auth/spreadsheets',
			'https://www.googleapis.com/auth/presentations',
		],
	})
}

export { auth }
