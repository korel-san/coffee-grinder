const WEBSEARCH_WITH_TEMPERATURE_FAMILIES = [
	// Order matters: more specific prefixes first (e.g. "gpt-4.1-mini" before "gpt-4.1").
	'gpt-4.1-mini',
	'gpt-4.1',
	'gpt-5.2',
]

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSnapshotOfFamily(model, family) {
	// Snapshots are expected to be `${family}-YYYY-MM-DD`.
	// This intentionally does NOT treat `${family}-pro` or `${family}-nano` as a snapshot.
	let re = new RegExp(`^${escapeRegExp(family)}-\\d{4}-\\d{2}-\\d{2}$`)
	return re.test(model)
}

export function normalizeWebSearchWithTemperatureModel(model) {
	if (typeof model !== 'string') return null
	let m = model.trim()
	if (!m) return null
	for (let family of WEBSEARCH_WITH_TEMPERATURE_FAMILIES) {
		if (m === family || isSnapshotOfFamily(m, family)) return family
	}
	return null
}

export function assertWebSearchWithTemperatureModel(model, envVarName) {
	let family = normalizeWebSearchWithTemperatureModel(model)
	if (family) return family
	let where = envVarName ? ` (from ${envVarName})` : ''
	throw new Error(
		`Model "${model}"${where} is not allowed for web_search+temperature. ` +
		`Allowed models: ${WEBSEARCH_WITH_TEMPERATURE_FAMILIES.join(', ')}`
	)
}

function buildWebSearchTool(opts) {
	let tool = { type: 'web_search' }
	if (opts && typeof opts === 'object') {
		if (opts.search_context_size) tool.search_context_size = opts.search_context_size
		if (opts.user_location) tool.user_location = opts.user_location
	}
	return tool
}

function buildInput({ system, user }) {
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	]
}

export function buildWebSearchWithTemperatureResponseBody({ model, system, user, temperature, webSearchOptions }) {
	let family = assertWebSearchWithTemperatureModel(model)
	let body = {
		model,
		input: buildInput({ system, user }),
		tools: [buildWebSearchTool(webSearchOptions)],
		temperature,
	}

	// GPT-5.2 supports temperature only with reasoning.effort="none".
	if (family === 'gpt-5.2') {
		body.reasoning = { effort: 'none' }
	}

	return body
}

export function extractResponseOutputText(res) {
	if (!res) return ''
	if (typeof res.output_text === 'string' && res.output_text.trim()) return res.output_text.trim()

	// Fallback to raw Responses shape: output[].content[].text.
	let out = []
	let output = Array.isArray(res.output) ? res.output : []
	for (let item of output) {
		if (!item || typeof item !== 'object') continue
		if (item.type !== 'message') continue
		let content = Array.isArray(item.content) ? item.content : []
		for (let c of content) {
			if (!c || typeof c !== 'object') continue

			// Most common: { type: 'output_text', text: '...' }
			if (typeof c.text === 'string' && c.text.trim()) {
				out.push(c.text.trim())
				continue
			}

			// Some SDK shapes: { type: 'output_text', text: { value: '...' } }
			if (c.text && typeof c.text === 'object') {
				let v = c.text.value
				if (typeof v === 'string' && v.trim()) out.push(v.trim())
			}
		}
	}
	return out.join('\n').trim()
}
