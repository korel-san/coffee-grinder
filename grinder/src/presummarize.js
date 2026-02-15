import { autoSpreadsheetId, mainSpreadsheetId } from '../config/google-drive.js'

import { log } from './log.js'
import { seedMissingPrompts } from './prompts.js'

const spreadsheetId = process.argv[2]?.endsWith('auto') ? autoSpreadsheetId : mainSpreadsheetId

await seedMissingPrompts(spreadsheetId)
log('Prompts ready')

