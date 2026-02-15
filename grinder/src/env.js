import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.template')
let templateEnv

function loadTemplateEnv() {
	if (templateEnv) return templateEnv
	templateEnv = Object.create(null)
	try {
		const file = fs.readFileSync(templatePath, 'utf8')
		for (const rawLine of file.split(/\r?\n/)) {
			const line = rawLine.trim()
			if (!line || line.startsWith('#')) continue
			const eq = line.indexOf('=')
			if (eq <= 0) continue
			const key = line.slice(0, eq).trim()
			if (!key) continue
			let value = line.slice(eq + 1)
			value = value.trim()
			if (value === '') continue
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1)
			}
			templateEnv[key] = value
		}
	} catch {
		// no-op: fallback-only mode for environments without template file
	}
	return templateEnv
}

export function readEnv(...names) {
	for (const name of names) {
		const raw = process.env[name]
		if (typeof raw !== 'string') continue
		const v = raw.trim()
		if (v) return v
	}
	for (const name of names) {
		const fallback = loadTemplateEnv()[name]
		if (fallback) return String(fallback).trim()
	}
	return undefined
}

export function requireEnv(names, desc) {
	const list = Array.isArray(names) ? names : [names]
	const v = readEnv(...list)
	if (v !== undefined) return v
	const label = desc || list.join(' or ')
	throw new Error(`Missing environment variable: ${label}`)
}
