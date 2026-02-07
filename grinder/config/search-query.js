const enabled = process.env.SEARCH_QUERY_ENABLED !== '0'
const defaultProvider = process.env.SEARCH_QUERY_PROVIDER || (process.env.XAI_API_KEY ? 'xai' : 'openai')
const defaultModel = process.env.SEARCH_QUERY_MODEL || (defaultProvider === 'xai' ? 'grok-4-1-fast' : 'gpt-4o')
const fallbackProvider = process.env.SEARCH_QUERY_FALLBACK_PROVIDER || 'openai'
const fallbackModel = process.env.SEARCH_QUERY_FALLBACK_MODEL || 'gpt-4o'

export const searchQueryConfig = {
	enabled,
	provider: defaultProvider,
	model: defaultModel,
	fallbackProvider,
	fallbackModel,
	temperature: 0,
	maxQueries: 1,
	minTitleChars: 20,
	minDescriptionChars: 40,
	maxQueryChars: 120,
	timeoutMs: 12000,
}
