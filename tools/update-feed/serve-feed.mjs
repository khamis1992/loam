// Serve a folder as a generic electron-updater feed (self-host / local test).
//
//   node tools/serve-feed.mjs [dir] [port]
//
// Point the app's update feed URL at http://<host>:<port>/ and it will read
// /latest.yml and download the installer named inside it.

import path from "node:path";
import { createFeedServer } from "./feed-lib.mjs";

const dir = path.resolve(process.argv[2] || "feed");
const port = Number(process.argv[3] || process.env.PORT || 8788);
const { url } = await createFeedServer({ dir, port, host: process.env.HOST || "0.0.0.0" });
console.log(`feed serving ${dir}`);
console.log(`feed url: ${url}/  (set the app's updateFeedUrl to this)`);
