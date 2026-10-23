// Entry point for the Loam server inside an Electron utility process
// (utilityProcess.fork from electron/main.cjs).
//
// Tools inside the server (design build checks, diagnostics) spawn
// process.execPath to run plain Node scripts. Those descendants still rely on
// ELECTRON_RUN_AS_NODE, so it is set here for children only; this utility
// process itself is already running as Node.
process.env.ELECTRON_RUN_AS_NODE = "1";
require(process.env.LOAM_SERVER_BUNDLE);
