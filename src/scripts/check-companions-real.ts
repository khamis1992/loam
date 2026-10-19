/**
 * Real-provider evidence for the companion device layer (stage 2).
 * Runs against the host's actual WSL2/Hyper-V — NOT part of the deterministic
 * gate. Prints what the app's own RealDeviceRunner sees and, when a distro is
 * available, proves exec-inside-distro through the runner protocol.
 */
import { RealDeviceRunner } from "../server/companionDevices.js";

const runner = new RealDeviceRunner();
const providers = await runner.detect();
console.log("providers:", JSON.stringify(providers));
if (!providers.wsl) {
  console.log("no WSL provider on this host — evidence limited to detection");
  process.exit(0);
}
const distro = (providers.wslDistros ?? []).find((d) => !d.startsWith("docker")) ?? providers.wslDistros?.[0];
if (!distro) {
  console.log("no usable distro found");
  process.exit(0);
}
const res = await runner.exec(distro, "root", "echo loam-real-ready && uname -srm", 60_000);
console.log(`exec inside ${distro} as root: code=${res.code}`);
console.log(res.stdout || res.stderr);
process.exit(res.code === 0 ? 0 : 1);
