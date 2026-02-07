function normalizeStatus(value) {
	if (value === null || value === undefined) return undefined
	if (typeof value === 'number') return value
	let text = String(value).trim()
	if (!text) return undefined
	if (/^\d+$/.test(text)) return Number(text)
	return text
}

function extractReason(error) {
	if (!error) return ''
	let reason =
		error?.errors?.[0]?.reason ||
		error?.response?.data?.error?.status ||
		error?.response?.data?.error?.errors?.[0]?.reason ||
		error?.response?.data?.error?.message ||
		error?.reason ||
		''
	return reason ? String(reason) : ''
}

function extractStatus(error) {
	if (!error) return undefined
	return normalizeStatus(error?.response?.status ?? error?.status ?? error?.code)
}

function extractMessage(error) {
	if (!error) return ''
	let message = error?.message || error?.response?.data?.error?.message || ''
	return message ? String(message) : ''
}

function extractCode(error) {
	if (!error) return ''
	let code = error?.code || error?.response?.data?.error?.code || ''
	return code ? String(code) : ''
}

function actionForGoogle({ status, reason, message, resource, id, email }) {
	let lowerReason = String(reason || '').toLowerCase()
	let lowerMessage = String(message || '').toLowerCase()
	if (status === 401 || lowerReason.includes('unauthorized')) {
		return 'Check SERVICE_ACCOUNT_EMAIL/SERVICE_ACCOUNT_KEY and that the key is valid.'
	}
	if (status === 403 || lowerReason.includes('forbidden') || lowerReason.includes('permission')) {
		let target = resource ? `${resource} ${id || ''}`.trim() : 'resource'
		let account = email || 'SERVICE_ACCOUNT_EMAIL'
		return `Share ${target} with ${account} and ensure the account has access.`
	}
	if (status === 404 || lowerReason.includes('notfound') || lowerReason.includes('not found')) {
		let target = resource ? `${resource} ${id || ''}`.trim() : 'resource'
		return `Check that ${target} exists and the ID is correct.`
	}
	if (String(message).includes('invalid_grant') || lowerMessage.includes('invalid_grant')) {
		return 'Service account token invalid. Regenerate the key or fix system clock skew.'
	}
	if (status === 429 || lowerReason.includes('rate') || lowerReason.includes('quota')) {
		return 'Rate limited. Wait and retry later or reduce request rate.'
	}
	if (status === 503) {
		return 'Service unavailable. Retry later.'
	}
	return ''
}

function actionForFetch({ status, reason, code }) {
	let statusValue = normalizeStatus(status)
	let reasonText = String(reason || '').toLowerCase()
	let codeText = String(code || '').toLowerCase()
	if (statusValue === 401 || statusValue === 403 || reasonText.includes('forbidden')) {
		return 'Access blocked or paywalled. Try archive/Jina or alternative sources.'
	}
	if (statusValue === 429 || statusValue === 503) {
		return 'Rate limited. Wait or reduce request rate.'
	}
	if (statusValue === 404) {
		return 'Page not found. Use alternative sources.'
	}
	if (reasonText.includes('captcha') || codeText.includes('captcha')) {
		return 'Captcha detected. Try archive or manual browser.'
	}
	if (reasonText.includes('timeout') || codeText.includes('timeout')) {
		return 'Request timeout. Retry or increase timeout.'
	}
	if (reasonText.includes('short')) {
		return 'Content too short. Try alternative sources or adjust minTextLength.'
	}
	if (reasonText.includes('no_text')) {
		return 'No extractable text. Try alternative sources or use Playwright/archive.'
	}
	return ''
}

function actionForPlaywright({ reason, code }) {
	let reasonText = String(reason || '').toLowerCase()
	let codeText = String(code || '').toLowerCase()
	if (reasonText.includes('captcha') || codeText.includes('captcha')) {
		return 'Captcha detected. Use archive or manual browser.'
	}
	if (reasonText.includes('timeout') || codeText.includes('timeout')) {
		return 'Browser timeout. Retry or increase timeout.'
	}
	if (codeText.includes('browser_closed')) {
		return 'Browser window was closed. Re-run summarize and keep the browser open.'
	}
	return ''
}

function actionForOpenAI({ status, reason, message }) {
	let lowerReason = String(reason || '').toLowerCase()
	let lowerMessage = String(message || '').toLowerCase()
	if (status === 401 || lowerReason.includes('invalid') || lowerMessage.includes('api key')) {
		return 'Check OPENAI_API_KEY and model access.'
	}
	if (status === 429 || lowerReason.includes('rate') || lowerMessage.includes('rate')) {
		return 'Rate limited. Wait or reduce request rate.'
	}
	if (lowerReason.includes('insufficient_quota') || lowerMessage.includes('insufficient_quota')) {
		return 'Insufficient quota. Check billing or raise limits.'
	}
	return ''
}

function actionForXAI({ status, reason, message }) {
	let lowerReason = String(reason || '').toLowerCase()
	let lowerMessage = String(message || '').toLowerCase()
	if (status === 401 || lowerReason.includes('invalid') || lowerMessage.includes('api key')) {
		return 'Check XAI_API_KEY and model access.'
	}
	if (lowerMessage.includes('model') && lowerMessage.includes('does not exist')) {
		return 'Check VERIFY_MODEL and that the model exists for your xAI account.'
	}
	if (status === 429 || lowerReason.includes('rate') || lowerMessage.includes('rate')) {
		return 'Rate limited. Wait or reduce request rate.'
	}
	if (status === 403 || lowerReason.includes('forbidden')) {
		return 'Access denied. Check account permissions for the model.'
	}
	return ''
}

export function describeError(error, { scope = '', resource = '', id = '', email = '' } = {}) {
	let status = extractStatus(error)
	let reason = extractReason(error)
	let code = extractCode(error)
	let message = extractMessage(error)
	let action = ''
	if (scope === 'sheets' || scope === 'drive') {
		action = actionForGoogle({ status, reason, message, resource, id, email })
	} else if (scope === 'fetch') {
		action = actionForFetch({ status, reason, code })
	} else if (scope === 'playwright') {
		action = actionForPlaywright({ reason, code })
	} else if (scope === 'xai' || scope === 'grok') {
		action = actionForXAI({ status, reason, message })
	} else if (scope === 'openai' || scope === 'verify') {
		action = actionForOpenAI({ status, reason, message })
	}
	let summaryParts = []
	if (status !== undefined) summaryParts.push(`status=${status}`)
	if (reason) summaryParts.push(`reason=${reason}`)
	if (code) summaryParts.push(`code=${code}`)
	if (!summaryParts.length && message) summaryParts.push(message)
	let summary = summaryParts.join(' ')
	return { status, reason, code, message, action, summary }
}
