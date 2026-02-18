import seedPrompts from '../config/prompts.seed.js'
import { promptsSheet } from '../config/google-drive.js'
import { append, ensureSheet, load, save } from './google-sheets.js'
import { log } from './log.js'

const HEADERS = ['name', 'prompt']

function norm(v) {
	return String(v ?? '').trim()
}

function ensureHeaderRow(rows) {
	if (!Array.isArray(rows) || rows.length === 0) return false
	let [a, b] = rows[0] ?? []
	return norm(a) === HEADERS[0] && norm(b) === HEADERS[1]
}

export async function ensurePromptsTable(spreadsheetId) {
	await ensureSheet(spreadsheetId, promptsSheet)

	let header = await load(spreadsheetId, `${promptsSheet}!A1:B1`)
	if (!Array.isArray(header) || header.length === 0) {
		await save(spreadsheetId, `${promptsSheet}!A1:B1`, [HEADERS])
		return
	}
	if (!ensureHeaderRow(header)) {
		throw new Error(`Invalid prompts sheet header. Expected: ${HEADERS.join(', ')}`)
	}
}

export async function loadPrompts(spreadsheetId) {
	await ensurePromptsTable(spreadsheetId)

	let rows = await load(spreadsheetId, `${promptsSheet}!A:B`)
	let map = new Map()
	if (!Array.isArray(rows) || rows.length < 2) return map

	for (let i = 1; i < rows.length; i++) {
		let [name, prompt] = rows[i] ?? []
		name = norm(name)
		if (!name) continue
		map.set(name, String(prompt ?? ''))
	}
	return map
}

export async function seedMissingPrompts(spreadsheetId, prompts = seedPrompts) {
	let existing = await loadPrompts(spreadsheetId)

	let missing = []
	for (let p of prompts) {
		let name = norm(p?.name)
		if (!name) continue
		if (existing.has(name)) continue
		missing.push([name, String(p?.prompt ?? '')])
	}

	if (missing.length) {
		log('Seeding prompts:', missing.map(r => r[0]).join(', '))
		await append(spreadsheetId, `${promptsSheet}!A:B`, missing)
	}

	return await loadPrompts(spreadsheetId)
}

let cache = new Map()
export async function getPrompt(spreadsheetId, name) {
	let key = `${spreadsheetId}:${name}`
	if (cache.has(key)) return cache.get(key)

	let prompts = await seedMissingPrompts(spreadsheetId)
	let prompt = prompts.get(norm(name))
	if (!prompt) {
		throw new Error(`Missing prompt '${name}' in '${promptsSheet}' sheet`)
	}
	cache.set(key, prompt)
	return prompt
}

