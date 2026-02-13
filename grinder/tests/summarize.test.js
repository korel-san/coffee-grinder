import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')
const fixturesDir = path.join(rootDir, 'tests', 'fixtures', 'summarize')
const articlesDir = path.join(rootDir, 'articles')

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

const fixtureNews = readJson(path.join(fixturesDir, 'news.json'))
const fixtureFetch = readJson(path.join(fixturesDir, 'fetch.json'))
const fixtureAi = readJson(path.join(fixturesDir, 'ai.json'))
const fixtureGoogleNews = readJson(path.join(fixturesDir, 'google-news.json'))

function cloneRows(rows) {
	return JSON.parse(JSON.stringify(rows))
}

const newsRows = cloneRows(fixtureNews.rows ?? fixtureNews)
const news = newsRows.map(row => ({ ...row }))

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

mock.module(mod('store.js'), {
	namedExports: { news }
})

mock.module(mod('google-news.js'), {
	namedExports: {
		decodeGoogleNewsUrl: async (url) => fixtureGoogleNews[url],
	}
})

mock.module(mod('fetch-article.js'), {
	namedExports: {
		fetchArticle: async (url) => fixtureFetch[url],
	}
})

mock.module(mod('browse-article.js'), {
	namedExports: {
		browseArticle: async (url) => fixtureFetch[url],
		finalyze: async () => {},
	}
})

mock.module(mod('ai.js'), {
	namedExports: {
		ai: async ({ url, text }) => {
			const res = fixtureAi[url]
			if (!res) return null
			return {
				summary: res.summary ?? text?.slice(0, 200) ?? '',
				topic: res.topic ?? 'US',
				priority: res.priority ?? 5,
				titleRu: res.titleRu,
				delay: 0,
			}
		}
	}
})

mock.module(mod('sleep.js'), {
	namedExports: {
		sleep: async () => {},
	}
})

mock.module(mod('log.js'), {
	namedExports: {
		log: () => {},
	}
})

const { summarize } = await import(mod('2.summarize.js'))

test('summarize pipeline (mocked)', async () => {
	fs.mkdirSync(articlesDir, { recursive: true })

	await summarize()

	const byId = new Map(news.map(item => [String(item.id), item]))

	for (const row of newsRows) {
		if (row.topic === 'other') continue
		const updated = byId.get(String(row.id))
		assert.ok(updated, `Missing updated row for id=${row.id}`)
		assert.ok(updated.summary && String(updated.summary).length > 10, `Missing summary for id=${row.id}`)
		assert.ok(updated.text && String(updated.text).length > 200, `Missing text for id=${row.id}`)
		assert.ok(updated.aiTopic, `Missing aiTopic for id=${row.id}`)
		assert.ok(updated.aiPriority, `Missing aiPriority for id=${row.id}`)
		if (row.gnUrl) {
			assert.ok(updated.url, `Missing decoded url for id=${row.id}`)
		}
		const htmlPath = path.join(articlesDir, `${row.id}.html`)
		const txtPath = path.join(articlesDir, `${row.id}.txt`)
		assert.ok(fs.existsSync(htmlPath), `Missing html output for id=${row.id}`)
		assert.ok(fs.existsSync(txtPath), `Missing txt output for id=${row.id}`)
	}
})
