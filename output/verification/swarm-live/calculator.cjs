'use strict';

/**
 * calculator.cjs — tiny dependency-free math module (CommonJS).
 *
 * Exports:
 *   add(a, b)    -> a + b
 *   divide(a, b) -> a / b
 *
 * Contract:
 *   - Both arguments must be finite numbers (typeof 'number' && Number.isFinite).
 *     Anything else (string, boolean, null, undefined, object, NaN, ±Infinity)
 *     throws a TypeError.
 *   - divide() rejects a zero divisor (0 or -0) with a RangeError.
 */

/**
 * Validate that x is a finite number.
 * @param {*} x value to check
 * @param {string} label argument name used in the error message
 * @returns {number} the validated number
 * @throws {TypeError} if x is not a finite number
 */
function assertFiniteNumber(x, label) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new TypeError(
      `${label} must be a finite number, got ${typeof x === 'object' && x !== null ? 'object' : String(x)}`
    );
  }
  return x;
}

/**
 * Add two finite numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number} a + b
 * @throws {TypeError} if a or b is not a finite number
 */
function add(a, b) {
  assertFiniteNumber(a, 'a');
  assertFiniteNumber(b, 'b');
  return a + b;
}

/**
 * Divide one finite number by another.
 * @param {number} a
 * @param {number} b
 * @returns {number} a / b
 * @throws {TypeError} if a or b is not a finite number
 * @throws {RangeError} if b is 0 or -0
 */
function divide(a, b) {
  assertFiniteNumber(a, 'a');
  assertFiniteNumber(b, 'b');
  if (b === 0) {
    // b === 0 is true for both 0 and -0, so one check covers the spec.
    throw new RangeError('divisor must not be zero');
  }
  return a / b;
}

module.exports = { add, divide };