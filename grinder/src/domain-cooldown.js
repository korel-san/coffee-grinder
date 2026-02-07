import { log } from './log.js'

const cooldowns = new Map()
const cooldownProbeMs = Number.isFinite(Number(process.env.COOLDOWN_PROBE_MS))
	? Number(process.env.COOLDOWN_PROBE_MS)
	: 0

function getHost(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return ''
	}
}

export function isDomainInCooldown(url) {
	let host = getHost(url)
	if (!host) return null
	let entry = cooldowns.get(host)
	if (!entry) return null
	let until = typeof entry === 'number' ? entry : entry.until
	let lastProbe = typeof entry === 'object' ? entry.lastProbe || 0 : 0
	if (Date.now() >= until) {
		cooldowns.delete(host)
		return null
	}
	if (cooldownProbeMs > 0 && Date.now() - lastProbe >= cooldownProbeMs) {
		cooldowns.set(host, { until, lastProbe: Date.now(), reason: entry?.reason || '' })
		log('domain cooldown probe', host, Math.ceil(cooldownProbeMs / 1000), 's')
		return null
	}
	return { host, until, remainingMs: until - Date.now() }
}

export function setDomainCooldown(url, ms, reason) {
	let host = getHost(url)
	if (!host || !ms) return null
	let until = Date.now() + ms
	let existing = cooldowns.get(host)
	let existingUntil = typeof existing === 'number' ? existing : existing?.until || 0
	let lastProbe = typeof existing === 'object' ? existing.lastProbe || 0 : 0
	if (until > existingUntil) cooldowns.set(host, { until, lastProbe, reason: reason || '' })
	log('domain cooldown set', host, Math.ceil(ms / 1000), 's', reason || '')
	return { host, until, reason }
}
