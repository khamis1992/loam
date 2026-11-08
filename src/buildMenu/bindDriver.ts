import type { BuildDriver, BuildJobContext, BuildProfile, DriverPorts, Requirement } from '../../packages/shared/src/buildMenu.js';

export function bindDriver(profile: BuildProfile, ports: DriverPorts): BuildDriver {
  function check(ctx: BuildJobContext): void {
    if (ctx.manifest.selection.kind !== profile.kind) throw new Error('kind_mismatch');
    if (ctx.signal.aborted) throw new Error('cancelled');
  }
  function required(ctx: BuildJobContext): readonly Requirement[] {
    const op = ctx.operation;
    if (op.action === 'package') {
      if (op.format === 'source-zip' || op.format === 'ipynb' || op.format === 'mv3-zip') return [];
      if (op.format === 'apk-debug') return ['node', 'android-sdk'];
      if (op.format === 'xcode-source') return ['macos-xcode'];
    }
    if (profile.kind === 'notebook' && op.action !== 'kernel-execute') return [];
    return profile.requirements;
  }
  return {
    profile,
    async preflight(ctx) { check(ctx); return ports.missing(ctx, required(ctx)); },
    async scaffold(ctx) {
      check(ctx);
      if (ctx.operation.action !== 'generate') throw new Error('operation_mismatch');
      await ports.scaffold(ctx);
    },
    async preview(ctx) {
      check(ctx);
      if (ctx.operation.action !== 'preview') throw new Error('operation_mismatch');
      return ports.preview(ctx);
    },
    async export(ctx, format) {
      check(ctx);
      if (!profile.exports.includes(format)) throw new Error('unsupported_format');
      if (ctx.operation.action !== 'package' || ctx.operation.format !== format) throw new Error('operation_mismatch');
      return ports.export(ctx, format);
    },
    async executeCell(ctx, cellId) {
      check(ctx);
      if (profile.kind !== 'notebook' || ctx.operation.action !== 'kernel-execute' || ctx.operation.cellId !== cellId) {
        throw new Error('unsupported_operation');
      }
      await ports.executeCell(ctx, cellId);
    },
    async stop(ctx) {
      if (ctx.manifest.selection.kind !== profile.kind) throw new Error('kind_mismatch');
      await ports.stop(ctx);
    },
  };
}
