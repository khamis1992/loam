# Auth agent handoff requests

## 1. Dynamic route `[sessionUid]` client must read the real id from the URL

**Owned by:** another agent (files under `packages/web/src/app/app/[sessionUid]/`).

The Electron `app://` protocol handler has been updated so that any `/app/<id>` (and its RSC payloads such as `/app/<id>.txt?_rsc=...` and `/app/<id>/__next.*`) that does not have a pre-rendered file falls back to serving the `app/demo-running` static export.

For the fallback to display the correct task, the client page must read the actual `sessionUid` from the browser URL (`usePathname()` / `window.location`) instead of relying on Next.js `useParams()`, because the pre-rendered `__NEXT_DATA__` still carries `demo-running`.

**Request:** change `packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx` (and `page.tsx` if it consumes the param) to derive `sessionUid` from the URL path segment at runtime, e.g.:

```ts
import { usePathname } from 'next/navigation';
const pathname = usePathname();
const sessionUid = pathname.split('/').filter(Boolean).pop() ?? 'demo-running';
```

Until this change lands, the fallback still works and renders the demo page; the id shown to the user will just be `demo-running` rather than the real id.
