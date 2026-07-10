# Manual smoke scripts

These are **not** unit tests. Each script hits a **running** swap-api server
(`API_URL`, default `http://localhost:3000`) with axios and logs the response for
eyeballing. They require live network/chain access and are excluded from the
hermetic `npm test` suite (which only runs `tests/**/*.test.js` via
`node --test`).

Run one manually against a running server, e.g.:

```
node scripts/smoke/test-quote.js
```
