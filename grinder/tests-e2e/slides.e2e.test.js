import assert from 'node:assert/strict'
import test from 'node:test'

import { randomUUID } from 'node:crypto'
import { readEnv } from '../src/env.js'
import { OAuth2Client } from 'google-auth-library'

function hasOAuthConfig() {
	return !!(
		process.env.GOOGLE_CLIENT_ID &&
		process.env.GOOGLE_CLIENT_SECRET &&
		process.env.GOOGLE_REFRESH_TOKEN
	)
}

function hasServiceAccountConfig() {
	return !!(process.env.SERVICE_ACCOUNT_EMAIL && process.env.SERVICE_ACCOUNT_KEY)
}

function createOAuthClient() {
	const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET
	return clientId && clientSecret && process.env.GOOGLE_REFRESH_TOKEN
		? (() => {
			const client = new OAuth2Client(clientId, clientSecret)
			client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
			return client
		})()
		: undefined
}

async function canAccessTemplate(client, templateId) {
	if (!client) return false
	const { default: Slides } = await import('@googleapis/slides')
	const slidesClient = await Slides.slides({ version: 'v1', auth: client })
	try {
		await slidesClient.presentations.get({ presentationId: templateId, fields: 'presentationId' })
		return true
	} catch {
		return false
	}
}

async function pickAuthMode(templateId) {
	const hasOAuth = hasOAuthConfig()
	const hasSA = hasServiceAccountConfig()

	if (!hasOAuth && !hasSA) return null
	if (hasOAuth && hasSA) {
		if (await canAccessTemplate(createOAuthClient(), templateId)) return 'oauth'
		return 'service-account'
	}
	return hasOAuth ? 'oauth' : 'service-account'
}


const spreadsheetId = readEnv('GOOGLE_SHEET_ID_MAIN')
const rootFolderId = readEnv('GOOGLE_ROOT_FOLDER_ID')
const templatePresentationId = readEnv('GOOGLE_TEMPLATE_PRESENTATION_ID')
const templateSlideId = readEnv('GOOGLE_TEMPLATE_SLIDE_ID')

const missing = []
if (!spreadsheetId) missing.push('GOOGLE_SHEET_ID_MAIN')
if (!rootFolderId) missing.push('GOOGLE_ROOT_FOLDER_ID')
if (!templatePresentationId) missing.push('GOOGLE_TEMPLATE_PRESENTATION_ID')
if (!templateSlideId) missing.push('GOOGLE_TEMPLATE_SLIDE_ID')
if (!hasOAuthConfig() && !hasServiceAccountConfig()) missing.push('Google auth env (OAuth or service account)')

const basePresentationName = `coffee-grinder-e2e-${randomUUID()}`

test('e2e: slides builds test deck from existing sheet data', {
	timeout: 25 * 60_000,
	skip: missing.length ? missing.join(', ') : false,
}, async () => {
	const shortId = randomUUID().slice(0, 8)
	const runtimeName = `${basePresentationName}-${shortId}`
	const namedPresentationName = `${runtimeName}-test`

	const env = process.env
	env.GOOGLE_AUTO_PRESENTATION_NAME = namedPresentationName

	const authMode = await pickAuthMode(templatePresentationId)
	assert.ok(authMode, 'Unable to pick Google auth credentials for E2E')
	if (authMode === 'oauth') {
		env.SERVICE_ACCOUNT_EMAIL = ''
		env.SERVICE_ACCOUNT_KEY = ''
		console.log('test:e2e:slides using OAuth for Google access')
	} else {
		env.GOOGLE_CLIENT_ID = ''
		env.GOOGLE_CLIENT_SECRET = ''
		env.GOOGLE_REFRESH_TOKEN = ''
		console.log('test:e2e:slides using service account for Google access')
	}

	// Force auto mode in store/google-slides to use autoPresentationName and avoid
	// collisions with regular production runs.
	process.argv[2] = `e2e-auto-${shortId}`

	const config = await import('../config/google-drive.js')
	const { getSpreadsheet, loadTable } = await import('../src/google-sheets.js')
	const { presentationExists } = await import('../src/google-slides.js')
	const { getFile } = await import('../src/google-drive.js')
	const { auth } = await import('../src/google-auth.js')
	const { default: Slides } = await import('@googleapis/slides')

	const explainMissingEntity = async (label, id, fetcher) => {
		try {
			return await fetcher()
		} catch (err) {
			const msg = `${err?.message || err}`
			if (/Requested entity was not found|not found/i.test(msg)) {
				const saEmail = process.env.SERVICE_ACCOUNT_EMAIL || ''
				const authHint = saEmail
					? `service account ${saEmail}`
					: 'OAuth credentials'
				assert.fail(`E2E slides cannot access ${label} (${id}). `
					+ `Check that this ID exists, belongs to the right Google account, `
					+ `and is shared with ${authHint}`)
			}
			throw err
		}
	}

	const before = await getFile(config.rootFolderId, config.autoPresentationName)
	assert.equal(before, undefined, 'e2e presentation name collision: cleanup the previous test file first')

	const spreadsheet = await explainMissingEntity('spreadsheet', spreadsheetId, () =>
		getSpreadsheet(spreadsheetId, 'properties.title'))
	const title = String(spreadsheet?.data?.properties?.title || '')
	assert.match(title, /(test|e2e)/i, `Refusing to run E2E against spreadsheet '${title}'`)

	const template = await explainMissingEntity('template presentation', templatePresentationId, () =>
		getSpreadsheet(templatePresentationId, 'properties.title'))
	assert.ok(template?.data, 'test template presentation should be accessible')

	const baseline = await Slides.slides({ version: 'v1', auth }).presentations.get({
		presentationId: templatePresentationId,
	})
	const baselineSlides = baseline.data.slides?.length || 0

	const table = await loadTable(spreadsheetId, `${config.newsSheet}`)
	assert.equal(table.headers?.includes('topic'), true, "news sheet must include 'topic' column")
	const toProcess = table.filter(row => !row.sqk && row.topic !== 'other')
	if (toProcess.length === 0) {
		console.warn('E2E slides: no rows to process were found in news sheet')
	}

	const slidesClient = await import('../src/3.slides.js')
	await slidesClient.slides()

	const exists = await getFile(config.rootFolderId, config.autoPresentationName)
	assert.ok(exists, 'presentation should be created')
	assert.ok(exists.id !== templatePresentationId, 'should not keep template id')
	assert.match(exists.name || '', /(e2e|test)/i)
	assert.equal(exists.name, namedPresentationName, 'presentation name should contain e2e marker')
	const named = exists

	const done = await Slides.slides({ version: 'v1', auth }).presentations.get({
		presentationId: named.id,
	})

	const finalSlides = done.data.slides?.length || 0
	if (toProcess.length > 0) {
		assert.ok(
			finalSlides >= baselineSlides + toProcess.length,
			`expected at least ${baselineSlides + toProcess.length} slides, got ${finalSlides}`,
		)
	}

	function collectStrings(value) {
		if (value == null) return []
		if (typeof value === 'string') return [value]
		if (Array.isArray(value)) return value.flatMap(collectStrings)
		if (typeof value === 'object') return Object.values(value).flatMap(collectStrings)
		return []
	}

	const text = collectStrings(done.data).join('\n')
	for (let row of toProcess.slice(0, 3)) {
		let title = String(row.titleEn || row.titleRu || '').trim()
		if (title.length > 0) {
			assert.ok(text.includes(title), `title should be present in deck text: ${title}`)
			break
		}
	}
	assert.ok(!text.includes('{{'), 'template placeholders should be replaced')
	assert.equal(await presentationExists(), named.id, 'cached deck id should point to created presentation')
})
