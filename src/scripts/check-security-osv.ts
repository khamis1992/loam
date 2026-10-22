import assert from "node:assert/strict";
import { queryAdvisories, type DependencyInventory } from "../security/dependencies.js";

// Only a fixed public package is queried; never read the user's project/lockfile here.
const inventory:DependencyInventory={packages:[{name:"lodash",version:"4.17.20",dev:false}],findings:[],warnings:[]};
await queryAdvisories(inventory,AbortSignal.timeout(25000));
assert.equal(inventory.advisories?.complete,true,inventory.warnings.join("; "));
assert.equal(inventory.advisories.queried,1);
assert.ok(inventory.advisories.matches.length>0,"Known vulnerable public fixture should match OSV");
console.log("PASS: live OSV returned "+inventory.advisories.matches[0]!.ids.length+" advisory identifiers for the public lodash@4.17.20 fixture");
