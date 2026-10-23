const path = require("node:path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

/** Flip the security fuses required by BUILD_SPEC §10.4 after the packaged
 *  Electron executable has been produced.
 *
 *  This script is invoked by electron-builder via the afterPack hook.
 *  It targets the main executable in appOutDir and leaves app files untouched.
 */
module.exports = async function afterPack(context) {
  const exeName = `${context.packager.appInfo.productName}.exe`;
  const exePath = path.join(context.appOutDir, exeName);

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    // RunAsNode stays ENABLED on purpose. The server and MCP bridge no longer need
    // it (they run via utilityProcess.fork), but server tools still spawn
    // process.execPath with ELECTRON_RUN_AS_NODE=1 to run plain Node scripts
    // (design build checks: "node build.mjs", TypeScript/ESLint diagnostics).
    // Disabling it would make those children launch a second Loam window.
    // Follow-up: route those through utilityProcess or a bundled node, then set false.
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
};
