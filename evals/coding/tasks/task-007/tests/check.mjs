import { describeCount, displayName } from "../src/format.js";

const failures = [];
const eq = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

eq("describeCount(1)", describeCount(1), "1 item");
eq("describeCount(0)", describeCount(0), "0 items");
eq("describeCount(12)", describeCount(12), "12 items");
eq("displayName(null)", displayName(null), "anonymous");
eq("displayName(undefined)", displayName(undefined), "anonymous");
eq("displayName({name})", displayName({ name: "Ada" }), "Ada");
eq("displayName({})", displayName({}), undefined);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("task-007 ok");
