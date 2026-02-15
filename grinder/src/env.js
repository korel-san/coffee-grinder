export function readEnv(...names) {
	for (const name of names) {
		const raw = process.env[name]
		if (typeof raw !== 'string') continue
		const v = raw.trim()
		if (v) return v
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
