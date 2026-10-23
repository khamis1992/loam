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
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
};
