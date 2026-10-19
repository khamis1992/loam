const fs=require('fs');const p='src/server/companionDevices.ts';const lines=fs.readFileSync(p,'utf8').split('\n');
function must(x,f){if(!f.includes(x)){console.error('MISSING:',JSON.stringify(x.slice(0,70)));process.exit(1);}}

// wslExe: kill child on abort (lines 112-118 shifted by edits; patch by anchor text)
let s=lines.join('\n');
const wslOld='      });\n    });\n  });\n\n  const runPowerShell';
must(wslOld,s);
s=s.replace(wslOld,'      });\n    });\n    if (signal) {\n      const onAbort = (): void => { child.kill(); };\n      if (signal.aborted) child.kill(); else signal.addEventListener("abort", onAbort, { once: true });\n    }\n  });\n\n  const runPowerShell',1);

// RealDeviceRunner.exec threads the signal.
must('  exec(osName: string, user: string, command: string, timeoutMs = 120_000): Promise<RunnerResult> {\n    return wslExe(["-d", osName, "-u", user, "--", "bash", "-lc", command], timeoutMs);\n  }',
     s);
s=s.replace('  exec(osName: string, user: string, command: string, timeoutMs = 120_000): Promise<RunnerResult> {\n    return wslExe(["-d", osName, "-u", user, "--", "bash", "-lc", command], timeoutMs);\n  }',
'  exec(osName: string, user: string, command: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<RunnerResult> {\n    return wslExe(["-d", osName, "-u", user, "--", "bash", "-lc", command], timeoutMs, signal);\n  }',1);
fs.writeFileSync(p,s);console.log('dev2 wsl exec signal done');
