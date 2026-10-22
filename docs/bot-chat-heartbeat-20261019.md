# Chat stream heartbeat

The first quote observer disconnected after roughly five minutes without task events while the task continued. Inspection found GET task streams already sent heartbeat comments but POST `/api/chat` did not. The timing is consistent with an idle transport timeout; it is not proof of the exact client timeout setting.

Added a transport-only SSE comment every fifteen seconds on the chat response. Headers flush immediately; the timer stops on close/finish or route completion and is unref'ed. Heartbeats skip a backpressured response. Disconnection does not cancel task execution, and writes are guarded after the response is destroyed. No task progress, message, or done event is synthesized by the heartbeat.

An actual isolated HTTP server regression test failed before route integration because no heartbeat arrived within eighteen seconds. After integration, typecheck and `src/scripts/check-bot-chat-heartbeat.ts` passed: a heartbeat arrives while the fixture task is still blocked, no false completion is delivered, and releasing the task after observer disconnect still finishes its work. No external model or installed profile was used.

This is a pending source change, not installed or fully built yet. Installed cohort remains pinned to 4CAAED2B99C94E8765988474E663F7CAB636CCCFA144F63DA8065839AB14BB3C. Pending prior build 5E5D5A34... does not include the heartbeat. Do not install while cohort tasks run.

Validation update: full `npm run verify` and `npm run build:server` passed; session 73191 exited 0. Log `output/verification/bot-chat-heartbeat-verify.log`. Candidate SHA256 **7B02A01A4DB5DE372A18E3FE16C338AB791BEA3F7BC4FD7543B1AFAB5BFCB3F7**, including direct-file search, author-envelope changes and heartbeat. This supersedes pending 5E5D5A34..., but is not installed during cohort session 89891. The actual POST chat heartbeat test was run separately and passed before the full suite.

Regression integration: `check:bot-chat-heartbeat` is now appended to the standard `verify` script. Running that npm target passed (session 3232 exit 0). This is a package-script-only change after the successful full suite; it does not imply another full-suite run occurred.
