const path = require("node:path");
const { flipFuses, FuseVersion, FuseV1Name, FuseV1Options } = require("@electron/fuses");

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
    [FuseV1Name.RunAsNode]: FuseV1Options.Disable,
    [FuseV1Name.EnableNodeOptionsEnvironmentVariable]: FuseV1Options.Disable,
    [FuseV1Name.EnableNodeCliInspectArguments]: FuseV1Options.Disable,
    [FuseV1Name.EnableEmbeddedAsarIntegrityValidation]: FuseV1Options.Enable,
    [FuseV1Name.OnlyLoadAppFromAsar]: FuseV1Options.Enable,
    [FuseV1Name.EnableCookieEncryption]: FuseV1Options.Enable,
    [FuseV1Name.GrantFileProtocolExtraPrivileges]: FuseV1Options.Disable,
  });
};
