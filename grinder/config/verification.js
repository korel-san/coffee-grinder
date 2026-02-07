import { AgencyLevel } from './agencies.js'

export const verifyMode = 'always'
export const verifyProvider = process.env.VERIFY_PROVIDER || 'xai'
export const verifyMinConfidence = 0.7
export const verifyShortThreshold = 1200
export const verifyFailOpen = false
export const verifyMaxChars = 12000
export const verifySummaryMaxChars = 200
export const verifyContextMaxChars = 0
export const verifyFallbackMaxChars = 12000
export const verifyFallbackContextMaxChars = 4000
export const verifyModel = process.env.VERIFY_MODEL || (verifyProvider === 'xai' ? 'grok-4-1-fast' : 'gpt-5.1')
export const verifyTemperature = 0
export const verifyUseSearch = true
export const verifyReasoningEffort = 'none'
const verifyFallbackUseSearchEnv = process.env.VERIFY_FALLBACK_USE_SEARCH
export const verifyFallbackProvider = process.env.VERIFY_FALLBACK_PROVIDER || 'openai'
export const verifyFallbackModel = process.env.VERIFY_FALLBACK_MODEL || 'gpt-5-mini'
export const verifyFallbackUseSearch = verifyFallbackUseSearchEnv == null
	? true
	: (verifyFallbackUseSearchEnv === '1' || verifyFallbackUseSearchEnv === 'true')
export const agencySearchMax = 8
export const agencySearchQueryMax = 2
export const minAgencyLevel = AgencyLevel.Mainstream
export const fallbackMinAgencyLevel = AgencyLevel.Mainstream
export const alternativeDateWindowDays = 7
