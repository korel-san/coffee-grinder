import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const fixturesDir = path.join(rootDir, 'fixtures', 'summarize')
const outputPath = process.env.MOCK_SHEETS_SAVE_PATH ?? path.join(fixturesDir, 'news.saved.json')
const articlesDir = path.join(fixturesDir, 'articles-out')

process.env.MOCK_DATA_DIR = fixturesDir
process.env.MOCK_SHEETS = '1'
process.env.MOCK_SHEETS_DIR = fixturesDir
process.env.MOCK_SHEETS_NEWS_PATH = path.join(fixturesDir, 'news.json')
process.env.MOCK_SHEETS_AI_PATH = path.join(fixturesDir, 'ai-instructions.json')
process.env.MOCK_SHEETS_SAVE_PATH = outputPath
process.env.MOCK_GOOGLE_NEWS = '1'
process.env.MOCK_GOOGLE_NEWS_PATH = path.join(fixturesDir, 'google-news.json')
process.env.MOCK_FETCH = '1'
process.env.MOCK_FETCH_PATH = path.join(fixturesDir, 'fetch.json')
process.env.MOCK_BROWSE = '1'
process.env.MOCK_BROWSE_PATH = path.join(fixturesDir, 'fetch.json')
process.env.MOCK_AI = '1'
process.env.MOCK_AI_PATH = path.join(fixturesDir, 'ai.json')
process.env.MOCK_SLEEP = '1'
process.env.ARTICLES_DIR = articlesDir

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function findRow(rows, id) {
	return rows.find(r => String(r.id) === String(id))
}

fs.mkdirSync(articlesDir, { recursive: true })
if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)

const { summarize } = await import('../src/2.summarize.js')
await summarize()

assert(fs.existsSync(outputPath), 'Expected mock sheets output file to be created')

const input = readJson(path.join(fixturesDir, 'news.json'))
const inputRows = input.rows ?? input
const saved = readJson(outputPath)
const savedRows = saved.rows ?? saved

for (const row of inputRows) {
	if (row.topic === 'other') continue
	const updated = findRow(savedRows, row.id)
	assert(updated, `Missing updated row for id=${row.id}`)
	assert(updated.summary && String(updated.summary).length > 10, `Missing summary for id=${row.id}`)
	assert(updated.text && String(updated.text).length > 200, `Missing text for id=${row.id}`)
	assert(updated.aiTopic, `Missing aiTopic for id=${row.id}`)
	assert(updated.aiPriority, `Missing aiPriority for id=${row.id}`)
	if (row.gnUrl) {
		assert(updated.url, `Missing decoded url for id=${row.id}`)
	}
	const htmlPath = path.join(articlesDir, `${row.id}.html`)
	const txtPath = path.join(articlesDir, `${row.id}.txt`)
	assert(fs.existsSync(htmlPath), `Missing html output for id=${row.id}`)
	assert(fs.existsSync(txtPath), `Missing txt output for id=${row.id}`)
}

console.log('summarize test passed')
