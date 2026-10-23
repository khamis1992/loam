import { describeScore } from "../src/scores.ts";

const cases = [
  [100, "excellent"],
  [90, "excellent"],
  [89, "good"],
  [70, "good"],
  [69, "fair"],
  [50, "fair"],
  [49, "poor"],
  [0, "poor"],
  [-10, "poor"],
];

for (const [score, expected] of cases) {
  const actual = describeScore(score);
  if (actual !== expected) {
    console.error(`describeScore(${score}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    process.exit(1);
  }
  if (typeof actual !== "string") {
    console.error(`describeScore(${score}) returned ${typeof actual}, expected string`);
    process.exit(1);
  }
}
console.log("task-017 ok");
