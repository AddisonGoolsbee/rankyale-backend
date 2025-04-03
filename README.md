# Rankyale Backend

This is the Firebase Cloud Functions for rankyale.com: a toxic website where Yale students can rank who is the most popular, what the most prestigious club is, etc.

## Development

`cd functions`, `npm run build`, and then `firebase emulators:start --import=../emulator-data --export-on-exit` to run in dev. Make sure to build each time!
`firebase deploy --only functions` to deploy to firebase

```bash
curl -X POST "http://127.0.0.1:5001/rankyale/us-central1/updateEloRating" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "collectionName": "colleges",
      "entry1Id": "a",
      "entry2Id": "b",
      "mode": 0
    }
  }'
```
