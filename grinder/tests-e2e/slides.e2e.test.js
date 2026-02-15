import assert from 'node:assert/strict'
import test from 'node:test'

import { randomUUID } from 'node:crypto'

function hasGoogleAuthEnv() {
	let hasOAuth = !!(
		process.env.GOOGLE_CLIENT_ID &&
		process.env.GOOGLE_CLIENT_SECRET &&
		process.env.GOOGLE_REFRESH_TOKEN
	)
	let hasServiceAccount = !!(process.env.SERVICE_ACCOUNT_EMAIL && process.env.SERVICE_ACCOUNT_KEY)
	return hasOAuth || hasServiceAccount
}

const spreadsheetId = process.env.GOOGLE_SHEET_ID_MAIN
const rootFolderId = process.env.GOOGLE_ROOT_FOLDER_ID
const templatePresentationId = process.env.GOOGLE_TEMPLATE_PRESENTATION_ID
const templateSlideId = process.env.GOOGLE_TEMPLATE_SLIDE_ID
const templateTableId = process.env.GOOGLE_TEMPLATE_TABLE_ID

const missing = []
if (!spreadsheetId) missing.push('GOOGLE_SHEET_ID_MAIN')
if (!rootFolderId) missing.push('GOOGLE_ROOT_FOLDER_ID')
if (!templatePresentationId) missing.push('GOOGLE_TEMPLATE_PRESENTATION_ID')
if (!templateSlideId) missing.push('GOOGLE_TEMPLATE_SLIDE_ID')
if (!templateTableId) missing.push('GOOGLE_TEMPLATE_TABLE_ID')
if (!hasGoogleAuthEnv()) missing.push('Google auth env (OAuth or service account)')

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
	if (env.SERVICE_ACCOUNT_EMAIL && env.SERVICE_ACCOUNT_KEY) {
		env.GOOGLE_CLIENT_ID = ''
		env.GOOGLE_CLIENT_SECRET = ''
		env.GOOGLE_REFRESH_TOKEN = ''
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

	const before = await getFile(config.rootFolderId, config.autoPresentationName)
	assert.equal(before, undefined, 'e2e presentation name collision: cleanup the previous test file first')

	const spreadsheet = await getSpreadsheet(spreadsheetId, 'properties.title')
	const title = String(spreadsheet?.data?.properties?.title || '')
	assert.match(title, /(test|e2e)/i, `Refusing to run E2E against spreadsheet '${title}'`)

	const template = await getSpreadsheet(templatePresentationId, 'properties.title')
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
