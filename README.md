# X (Twitter) Plugin

Phantasy plugin for X (Twitter) integration.

## Installation

```bash
npm install @phantasy/plugin-x
```

## Usage

```typescript
import { XPlugin } from "@phantasy/plugin-x";

const plugin = new XPlugin({
  apiKey: process.env.X_API_KEY,
  apiSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});
```

## Tools

- `post_tweet` - Post a tweet
- `reply_to_tweet` - Reply to a tweet
- `search_tweets` - Search for tweets

## License

BUSL-1.1
