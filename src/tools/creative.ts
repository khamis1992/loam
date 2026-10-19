import { CreativeError, readScene, saveScene } from "../creative/store.js";
import type { Tool } from "./registry.js";

export function createCreativeTools(): Tool[] {
  return [{
    name: "loam_creative",
    description: "Read or replace the active task's live 3D scene. Always read first, preserve existing nodes unless asked to remove them, and replace using expectedRevision. Scene version 1 has title, nodes (max 200), environment {background hex,lightIntensity 0..10,exposure .1..5,grid}, camera {position,target,fov 20..100}, duration 1..60. Each node needs safe unique id,name,type (box/sphere/cylinder/torus/plane/cone/model),position,rotation radians,scale (three-number arrays),material {color hex,metalness,roughness},visible,spin radians/sec. Base dimensions BEFORE scale: box 2×2×2; sphere radius 1; cylinder radius 1 and height 2 along Y; cone radius 1 and height 2 along Y; torus major radius 1 and tube .3 with axis Z; plane is a thin 4×.04×4 box. Y is up. Scale multiplies these dimensions; it is not the desired final size. A cylinder wheel whose axle is X requires rotation Z=pi/2. Model nodes need an existing self-contained task-relative .glb asset. Changes appear in the studio and actual rendered views are independently checked before completion; names alone do not establish the requested shape.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "replace"] }, scene: { type: "object" }, expectedRevision: { type: "integer", minimum: 0 } }, required: ["action"] },
    async run(args, ctx) {
      if (!ctx.taskId) return { ok: false, content: "An active task is required to edit its creative scene." };
      try {
        if (args.action === "read") return { ok: true, content: JSON.stringify({ scene: readScene(ctx.workspace) }) };
        if (args.action !== "replace") return { ok: false, content: "action must be read or replace" };
        return { ok: true, content: JSON.stringify({ scene: saveScene(ctx.workspace, args.scene, args.expectedRevision) }) };
      } catch (error) {
        return { ok: false, content: JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(error instanceof CreativeError ? { status: error.status, scene: error.scene } : {}) }) };
      }
    },
  }];
}
