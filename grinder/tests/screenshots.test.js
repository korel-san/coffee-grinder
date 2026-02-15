import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

let launched = null
let gotos = []
let shots = []
let browserClosed = 0

mock.module(mod('log.js'), {
	namedExports: { log: () => {} }
})

mock.module('fs/promises', {
	namedExports: {
		readFile: async () => '3\nhttps://example.com/a\n4\nhttps://example.com/b\n',
	}
})

mock.module('playwright', {
	namedExports: {
		firefox: {
			launch: async (options) => {
				launched = options
				return {
					newContext: async () => ({
						newPage: async () => ({
							goto: async (url) => {
								gotos.push(url)
							},
							waitForTimeout: async () => {},
							evaluate: async () => {},
							screenshot: async ({ path: filePath }) => {
								shots.push(filePath)
							},
							close: async () => {},
						}),
					}),
					close: async () => {
						browserClosed++
					},
				}
			},
		},
	}
})

// src/screenshots.js auto-runs when process.argv[1] includes "screenshots".
// In Node's test runner argv[1] may include the test filename, so neutralize it for import.
const originalArgv1 = process.argv[1]
process.argv[1] = 'node'
const { screenshots } = await import(mod('screenshots.js'))
process.argv[1] = originalArgv1

test('screenshots pipeline (mocked)', async () => {
	launched = null
	gotos = []
	shots = []
	browserClosed = 0

	await screenshots()

	assert.deepEqual(launched, { headless: true })
	assert.equal(browserClosed, 1)

	assert.deepEqual(gotos, ['https://example.com/a', 'https://example.com/b'])
	assert.equal(shots.length, 2)
	assert.match(shots[0], /[\\/]+img[\\/]+3\.jpg$/)
	assert.match(shots[1], /[\\/]+img[\\/]+4\.jpg$/)
})
