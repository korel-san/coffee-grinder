import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')
const configDir = path.join(rootDir, 'config')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href
const cfg = relativePath => pathToFileURL(path.join(configDir, relativePath)).href

const news = []

mock.module(mod('store.js'), {
	namedExports: { news }
})

mock.module(mod('log.js'), {
	namedExports: { log: () => {} }
})

mock.module(cfg('feeds.js'), {
	defaultExport: [{ url: 'https://example.test/rss', max: 3 }],
})

const { load } = await import(mod('1.load.js'))

test('load pipeline (mocked fetch)', async () => {
	news.length = 0

	const pubDate = new Date().toUTCString()
	const rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n\t<channel>\n\t\t<item>\n\t\t\t<title>Test event A</title>\n\t\t\t<link>https://news.google.com/rss/articles/test-a</link>\n\t\t\t<source>Example</source>\n\t\t\t<pubDate>${pubDate}</pubDate>\n\t\t</item>\n\t\t<item>\n\t\t\t<title>Test event B</title>\n\t\t\t<link>https://news.google.com/rss/articles/test-b</link>\n\t\t\t<source>Example</source>\n\t\t\t<pubDate>${pubDate}</pubDate>\n\t\t</item>\n\t</channel>\n</rss>\n`

	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => ({ text: async () => rss })
	try {
		const res = await load()
		assert.equal(res, news)

		assert.equal(news.length, 2)
		assert.equal(news[0].titleEn, 'Test event A')
		assert.equal(news[0].gnUrl, 'https://news.google.com/rss/articles/test-a')
		assert.equal(news[0].source, 'Example')
		assert.ok(news[0].date instanceof Date)
		assert.deepEqual(news[0].articles, [])

		assert.equal(news[1].titleEn, 'Test event B')
		assert.equal(news[1].gnUrl, 'https://news.google.com/rss/articles/test-b')
	} finally {
		globalThis.fetch = originalFetch
	}
})
