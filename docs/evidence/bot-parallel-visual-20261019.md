# Bounded concurrent visual batches

Actual installed ticket trials showed functional success but incomplete visual
coverage after sequential reviews timed out or transport failed. Two sequential
batches with two 90-second attempts each can require 360 seconds, exceeding the
shared 300-second application deadline before accounting for browser execution.

Source now starts at most two screenshot batches together under the same signal
and deadline. Each batch still holds at most 12 images and uses the same model,
prompt, retry limit and verdict validation. All outcomes settle before deciding;
known usage and successful sibling reports are retained even if the first fails.
Results remain in screenshot order, regardless of response order. Any unavailable
batch blocks certification without consuming application-repair allowance; any
semantic failure blocks certification. No screenshot omission or timeout increase.

Actual-browser tests with a controlled reviewer pass: 14 images, faster second
batch, peak concurrency exactly two, shared signal, exact coverage, early/late
semantic rejection, early/late transport unavailability, bounded retries and
known sibling usage. Typecheck passes. Focused session 55610 exit 0.

Full verification/build passed (28831 exit 0), candidate hash
35B3F4C54BE9805F2C342D38CD0288303B0D9E234CF036CEC2CAD4983C070C71.
Logs output/verification/bot-parallel-visual-20261019.log and
output/verification/bot-parallel-visual-build-20261019.log.
Installed runtime is still F4E5E821E745849826EC5A63484A195825D1FC1517900DB6306E33F3A0D22088;
active ticket observer 9434 uses that old sequential implementation. Do not
attribute its outcome to this source change. Real-model latency improvement is
not yet measured; providers may serialize requests or rate-limit concurrency.

Subsequently installed with failure screenshots and exhausted-worker resume fix
at 10:02:44 Riyadh, hash 8006789F1EBDB495450DDBA572DD7211BEC73CE08AC401B2D83A985D3392B240.
The old observer 9434 failed at the worker limit before installation. Current
observer 15010 is a separately recorded recovery on the new build.
