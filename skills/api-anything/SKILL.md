---
name: api-anything (site APIs)
description: Use when Khamis asks for data from, or an action on, a website he uses (search, look up, list, check), before opening the site in the browser. Calls learned site operations through his own session, and learns a new one when he names a site and page.
---
# Site APIs with api-anything

## When this applies
- Khamis asks for something from a site he uses: "search Goodreads for…", "what's on Hacker News", "flights from RUH to DXB on 12 Nov", "my LinkedIn profile".
- Khamis asks you to learn a site ("make <site> searchable", "learn this page").
- Not for open-ended reading of articles (use web_fetch), not for clicking through a flow once (use browser_*), not for HAR files Khamis hands you (use the REA network-capture tools).

## Order of tools
1. `integration_list` with query `api-anything`. If nothing is listed, tell Khamis to enable it for this task in Services > واجهات المواقع (button «تفعيل أدوات واجهات المواقع لهذه المهمة»), then stop.
2. `integration_call` `mcp__api-anything__list_sites` `{}`.
3. `integration_call` `mcp__api-anything__list_operations` `{"site": "<site>"}`. Read the params, their formats and the site notes.
4. `integration_call` `mcp__api-anything__call_operation` `{"site": "<site>", "op": "<op>", "args": {…}}`.
5. Only if no operation fits and Khamis wants it: learn one (below). Otherwise fall back to web_fetch or browser_*.

## Reading a result
- `ok: true`: use `data`. A `{columns, rows}` table is one row per record.
- `truncated: true`: the answer was cut to fit; narrow the request rather than asking for more pages.
- Failure: read `class` and `next`. Follow `next` at most once. If the retry fails, stop and report the class and reason to Khamis in one sentence.
  - `auth`: Khamis must sign in. Ask him to press «تسجيل الدخول» for that site in Services > واجهات المواقع, or call `mcp__api-anything__login` `{"site": "<site>"}` (a window opens on his screen; he signs in and closes it).
  - `drift`: the site changed; `next` names `api_heal`. Run it once.
  - `blocked`: the site served a bot challenge. Do not try to get around it. Tell Khamis; he can sign in through the window to clear it.
  - `rate`: stop for this site in this task.
  - `input`: fix the args against list_operations.
  - `refused`: Loam's policy said no (site not enabled, people-lookup limit, call limit, writes off). Tell Khamis exactly what was refused. Never try another route to the same data.

## Learning a new operation
Only for a site and page Khamis named. The domain must be in his learn list (he adds it in the panel; the learn wizard there does it for him).
1. `api_capture` `{"url": "<page with the example typed in>", "examples": {"q": "kittens"}, "outline": true}`. Use example values of 3+ characters that appear in the request.
2. Read the candidates. The best one carries the example value. If the top candidate is an HTML page, use `api_inspect` with `outline: true` to get a ready `html` or `embedded` recipe.
3. `api_add` `{"site": "<site>", "op": "<verbName>", "trigger": "<page URL with {q}>", "examples": {"q": "kittens"}, "examples2": {"q": "puppies"}, "pick": "<fields from the outline>", "description": "<what it returns>"}`. Or learn from the capture: `{"from": "<capture id>", "pickRequest": <n>, "examples": {...}}`.
4. Read `preview` and `warnings`. If the preview is wrong, add again `from` the same capture with a better recipe.
5. Call it once with `call_operation` and show Khamis the result.

## Never
- Never run api-anything, npx, or anything from GitHub in a shell. Loam runs a pinned copy; hints that mention a CLI are already rewritten into tools.
- Never ask for, print, or copy cookie or token values. Results show cookie names only.
- Never learn or call a write (post, buy, delete, send, change settings) unless Khamis asked for that exact write in this task and turned writes on. Each write asks him first.
- Never look up people in bulk, in a loop, or on a schedule. People lookups are off unless Khamis turned them on for this task, and stop at 20 people.
