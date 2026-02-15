# Coffee Grinder

## Git hooks
This repo uses a pre-commit hook that runs `npm run test` in `grinder/`.
It is enabled automatically when you run `npm install` in `grinder/`
(via the `prepare` script), or you can enable it manually:

```
cd grinder
npm run prepare
```

## Google OAuth setup (Drive, Sheets, Slides)
1. Go to Google Cloud Console: `https://console.cloud.google.com/`.
2. Open `APIs & Services` -> `Credentials`.
3. Click `Create Credentials` -> `OAuth client ID`.
4. Choose `Desktop app` (recommended) or `Web application`.
5. If you choose `Web application`, add this redirect URI:
   `https://developers.google.com/oauthplayground`
6. Save the Client ID and Client Secret.
7. Open OAuth 2.0 Playground: `https://developers.google.com/oauthplayground/`.
8. In settings, enable `Use your own OAuth credentials` and enter the Client ID and Secret.
9. Select these scopes:
   `https://www.googleapis.com/auth/drive`
   `https://www.googleapis.com/auth/spreadsheets`
   `https://www.googleapis.com/auth/presentations`
10. Click `Authorize APIs`, sign in, then `Exchange authorization code for tokens`.
11. Copy the Refresh Token.
12. Set environment variables in `grinder/.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

Make sure the Google account you authorize has access to the Drive folders and Sheets used by the pipeline.

## OpenAI model selection (summarize)
See `OPENAI_MODELS.md`.
