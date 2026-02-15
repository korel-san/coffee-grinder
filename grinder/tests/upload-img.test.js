import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

let calls = []

mock.module(mod('log.js'), {
	namedExports: { log: () => {} }
})

mock.module(mod('google-drive.js'), {
	namedExports: {
		uploadFolder: async (...args) => {
			calls.push(args)
		},
	}
})

// src/upload-img.js auto-runs when process.argv[1] includes "upload-img".
const originalArgv1 = process.argv[1]
process.argv[1] = 'node'
const { uploadImg } = await import(mod('upload-img.js'))
process.argv[1] = originalArgv1

test('upload-img pipeline (mocked)', async () => {
	calls = []

	await uploadImg()

	assert.equal(calls.length, 1)
	const [dir, parentId, folderName, exts] = calls[0]

	assert.equal(dir, '../img')
	assert.ok(parentId)
	assert.equal(folderName, 'img')
	assert.deepEqual(exts, ['.jpg', '.png'])
})

