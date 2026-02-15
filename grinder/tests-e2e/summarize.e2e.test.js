import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function hasGoogleAuthEnv() {
	let hasOAuth = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN)
	let hasServiceAccount = !!(process.env.SERVICE_ACCOUNT_EMAIL && process.env.SERVICE_ACCOUNT_KEY)
	return hasOAuth || hasServiceAccount
}

const spreadsheetId = process.env.GOOGLE_SHEET_ID_MAIN
const articleUrl = process.env.E2E_ARTICLE_URL

const missing = []
if (!spreadsheetId) missing.push('GOOGLE_SHEET_ID_MAIN (set this to a TEST spreadsheet id in .env.e2e)')
if (!articleUrl) missing.push('E2E_ARTICLE_URL')
if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY')
if (!process.env.NEWS_API_KEY) missing.push('NEWS_API_KEY')
if (!hasGoogleAuthEnv()) missing.push('Google auth env (OAuth or service account)')

if (missing.length) {
	console.warn('E2E summarize skipped; missing env:', missing.join(', '))
}

test('e2e: summarize writes artifacts into test sheet', { timeout: 12 * 60_000, skip: missing.length ? missing.join(', ') : false }, async () => {
	let { clear, ensureSheet, getSpreadsheet, load, loadTable, save } = await import('../src/google-sheets.js')

	let ss = await getSpreadsheet(spreadsheetId, 'properties.title')
	let title = ss?.data?.properties?.title || ''
	assert.match(title, /(test|e2e)/i, `Refusing to run E2E against non-test spreadsheet title: '${title}'`)

	// Keep E2E cheap by default; allow overriding via env.
	process.env.OPENAI_SUMMARIZE_MODEL ||= 'gpt-4o-mini'
	process.env.OPENAI_FACTS_MODEL ||= 'gpt-4o-mini-search-preview'
	process.env.OPENAI_VIDEOS_MODEL ||= 'gpt-4o-mini-search-preview'
	process.env.OPENAI_WEBSEARCH_CONTEXT_SIZE ||= 'low'

	await ensureSheet(spreadsheetId, 'news')
	await ensureSheet(spreadsheetId, 'prompts')
	await clear(spreadsheetId, 'news!A:Z')
	await clear(spreadsheetId, 'prompts!A:Z')

	let id = '1'
	let headers = [
		'id',
		'source',
		'url',
		'summary',
		'text',
		'topic',
		'priority',
		'factsRu',
		'videoUrls',
		'titleEn',
		'titleRu',
	]
	let row = [
		id,
		'E2E',
		articleUrl,
		'',
		'',
		'',
		'',
		'',
		'',
		'E2E article',
		'',
	]
	await save(spreadsheetId, 'news!A1', [headers, row])

	// Clean local artifacts to make assertions meaningful.
	for (let p of [`articles/${id}.html`, `articles/${id}.txt`]) {
		if (fs.existsSync(p)) fs.unlinkSync(p)
	}

	// Import after seeding so store loads the fresh test sheet.
	let { summarize } = await import('../src/2.summarize.js')
	await summarize()

	// Ensure final write is flushed.
	let { save: flush } = await import('../src/store.js')
	await flush()

	let table = await loadTable(spreadsheetId, 'news')
	assert.equal(table.length, 1)

	let e = table[0]
	assert.ok(String(e.url || '').trim().length > 0, 'expected url to be set')
	assert.ok(String(e.text || '').trim().length > 400, 'expected extracted text')
	assert.ok(String(e.summary || '').trim().length > 0, 'expected summary')
	assert.ok(String(e.factsRu || '').trim().length > 0, 'expected factsRu')
	assert.match(String(e.videoUrls || ''), /https?:\/\//, 'expected at least one video URL')

	assert.ok(fs.existsSync(`articles/${id}.txt`), 'expected articles/{id}.txt artifact')

	let prompts = await load(spreadsheetId, 'prompts!A:A')
	let names = (prompts || []).map(r => r?.[0]).filter(Boolean)
	assert.ok(names.includes('summarize:summary'), 'expected seeded summarize:summary prompt')
	assert.ok(names.includes('summarize:facts'), 'expected seeded summarize:facts prompt')
	assert.ok(names.includes('summarize:videos'), 'expected seeded summarize:videos prompt')
})
