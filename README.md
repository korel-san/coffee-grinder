# Coffee Grinder

## Git hooks
This repo uses a pre-commit hook that runs `npm run test` in `grinder/`.
It is enabled automatically when you run `npm install` in `grinder/`
(via the `prepare` script), or you can enable it manually:

```
cd grinder
npm run prepare
```
