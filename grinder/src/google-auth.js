import { JWT } from 'google-auth-library'

const serviceEmail = process.env.SERVICE_ACCOUNT_EMAIL
const serviceKey = process.env.SERVICE_ACCOUNT_KEY

if (!serviceEmail) {
	throw new Error('SERVICE_ACCOUNT_EMAIL is missing. Set it in grinder/.env for Google APIs.')
}
if (!serviceKey) {
	throw new Error('SERVICE_ACCOUNT_KEY is missing. Set it in grinder/.env for Google APIs.')
}

export let auth = new JWT({
	email: serviceEmail,
	key: serviceKey.replace(/\\n/g, '\n'),
	scopes: [
		'https://www.googleapis.com/auth/drive',
		'https://www.googleapis.com/auth/spreadsheets',
		'https://www.googleapis.com/auth/presentations',
	],
})
