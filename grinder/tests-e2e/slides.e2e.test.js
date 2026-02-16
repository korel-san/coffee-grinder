import assert from 'node:assert/strict'
import test from 'node:test'

import { readEnv } from '../src/env.js'
import { OAuth2Client } from 'google-auth-library'
import { sleep } from '../src/sleep.js'
import { normalizeTopic as normalizeTopicValue } from '../config/topics.js'

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

async function cleanupOldE2ePresentations(rootFolderId, expectedPresentationNames) {
	const { auth } = await import('../src/google-auth.js')
	const { default: Drive } = await import('@googleapis/drive')
	const { trashFile, getFile } = await import('../src/google-drive.js')

	const drive = await Drive.drive({ version: 'v3', auth })
	const basePrefix = 'coffee-grinder-e2e-'
	const query = `'${rootFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.presentation' and name contains '${basePrefix}'`

	const { data } = await drive.files.list({
		q: query,
		fields: 'files(id, name)',
	})
	const files = data?.files || []

	let removed = 0
	const explicitNames = Array.isArray(expectedPresentationNames)
		? expectedPresentationNames
		: expectedPresentationNames
			? [expectedPresentationNames]
			: []

	const explicit = new Set()
	for (const name of explicitNames) {
		if (!name) continue
		const file = await getFile(rootFolderId, name)
		if (file?.id) explicit.add(file.id)
	}

	for (const fileId of explicit) {
		await trashFile(fileId)
		removed += 1
	}

	for (const file of files) {
		if (!file?.id) continue
		if (explicit.has(file.id)) continue
		await trashFile(file.id)
		removed += 1
	}

	if (removed > 0) {
		console.log(`test:e2e:slides cleanup: removed ${removed} stale deck(s)`)
	} else {
		console.log('test:e2e:slides cleanup: no stale decks found')
	}
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

test('e2e: slides builds test deck from existing sheet data', {
	timeout: 25 * 60_000,
	skip: missing.length ? missing.join(', ') : false,
}, async () => {
	const namedPresentationName = process.env.GOOGLE_PRESENTATION_NAME?.trim()
	assert.ok(namedPresentationName, 'GOOGLE_PRESENTATION_NAME must be set in environment')

	process.env.GOOGLE_PRESENTATION_NAME = namedPresentationName

	const config = await import('../config/google-drive.js')
	const env = process.env

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

	const { getSpreadsheet, loadTable } = await import('../src/google-sheets.js')
	const { getFile } = await import('../src/google-drive.js')
	const { auth } = await import('../src/google-auth.js')
	const { default: Slides } = await import('@googleapis/slides')

	const cleanupNames = [namedPresentationName]
	await cleanupOldE2ePresentations(config.rootFolderId, cleanupNames)

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

	const spreadsheet = await explainMissingEntity('spreadsheet', spreadsheetId, () =>
		getSpreadsheet(spreadsheetId, 'properties.title'))
	const title = String(spreadsheet?.data?.properties?.title || '')
	assert.match(title, /(test|e2e)/i, `Refusing to run E2E against spreadsheet '${title}'`)

	const template = await explainMissingEntity('template presentation', templatePresentationId, () =>
		Slides.slides({ version: 'v1', auth }).presentations.get({
			presentationId: templatePresentationId,
			fields: 'presentationId,slides.objectId',
		}))
	assert.ok(template?.data, 'test template presentation should be accessible')

	const baseline = template
	const baselineSlides = baseline.data.slides?.length || 0

	const table = await loadTable(spreadsheetId, `${config.newsSheet}`)
	assert.equal(table.headers?.includes('topic'), true, "news sheet must include 'topic' column")
	assert.ok(table.length > 0, 'E2E slides requires news data in test sheet')

	const normalizeTopic = (topic) => normalizeTopicValue(topic)

	const toProcess = table.filter(row => row.topic !== 'other')
	if (toProcess.length === 0) {
		assert.fail(`E2E slides requires at least one row with topic != 'other' in news sheet, got ${table.length} rows total`)
	}

	const badTopics = []
	const normalizedProcess = toProcess.map(row => {
		const mapped = normalizeTopic(row.topic)
		if (!mapped) badTopics.push(row.topic)
		return { ...row, topic: mapped || row.topic }
	})
	if (badTopics.length) {
		assert.fail(`E2E slides found unknown topic(s) not present in config/topics.js: ${badTopics.slice(0, 5).join(', ')}`)
	}

	const { news } = await import('../src/store.js')
	for (const normalized of normalizedProcess) {
		const row = news.find(item => String(item.id || '') === String(normalized.id || '') || String(item.url || '') === String(normalized.url || ''))
		if (row) {
			row.topic = normalized.topic
		}
	}

	const slidesClient = await import('../src/3.slides.js')
	await slidesClient.slides()
	const { presentationExists } = await import('../src/google-slides.js')

	let exists
	for (let i = 0; i < 6; i++) {
		exists = await getFile(config.rootFolderId, namedPresentationName)
		if (exists?.id) break
		await sleep(1000)
	}
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
		let title = String(row.titleRu || row.titleEn || '').trim()
		if (title.length > 0) {
			assert.ok(text.includes(title), `title should be present in deck text: ${title}`)
			break
		}
	}
	const templateSlides = baselineSlides > 0 ? (done.data.slides || []).slice(baselineSlides) : done.data.slides || []
	for (let i = 0; i < templateSlides.length && i < normalizedProcess.length; i++) {
		const slideText = collectStrings(templateSlides[i]).join('\n')
		const placeholders = [...new Set((slideText.match(/{{[^}]+}}/g) || []))]
		assert.ok(
			placeholders.length === 0,
			`generated slide #${baselineSlides + i + 1} still has unresolved placeholders: ${placeholders.join(', ')} (topic=${normalizedProcess[i]?.topic || toProcess[i]?.topic}, title=${normalizedProcess[i]?.titleEn || toProcess[i]?.titleEn})`,
		)
	}
	assert.equal(await presentationExists(), named.id, 'cached deck id should point to created presentation')
})
