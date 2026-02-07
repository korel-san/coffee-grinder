import { getFile } from './src/google-drive.js'
import { rootFolderId, autoPresentationName } from './config/google-drive.js'

const file = await getFile(rootFolderId, autoPresentationName)
console.log('Looking for:', autoPresentationName)
console.log('In folder:', rootFolderId)
console.log('Result:', file ? `Found! ID: ${file.id}` : 'NOT FOUND')
