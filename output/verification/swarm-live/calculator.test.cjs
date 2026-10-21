'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { add, divide } = require('./calculator.cjs');

test('add: normal addition', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(0, 0), 0);
  assert.equal(add(10, -4), 6);
});

test('add: negative addition', () => {
  assert.equal(add(-2, -3), -5);
  assert.equal(add(-7, 7), 0);
});

test('add: float arithmetic follows IEEE-754', () => {
  assert.equal(add(0.1, 0.2), 0.30000000000000004);
});

test('divide: normal division', () => {
  assert.equal(divide(10, 4), 2.5);
  assert.equal(divide(-9, 3), -3);
  assert.equal(divide(7, 2), 3.5);
});

test('divide: rejects zero divisor (0 and -0)', () => {
  assert.throws(() => divide(5, 0), RangeError);
  assert.throws(() => divide(5, -0), RangeError);
  assert.throws(() => divide(0, 0), RangeError);
});

test('add: rejects invalid inputs with TypeError', () => {
  assert.throws(() => add('2', 3), TypeError);
  assert.throws(() => add(2, '3'), TypeError);
  assert.throws(() => add(NaN, 1), TypeError);
  assert.throws(() => add(1, Infinity), TypeError);
  assert.throws(() => add(null, 1), TypeError);
  assert.throws(() => add(undefined, 1), TypeError);
  assert.throws(() => add(true, 1), TypeError);
  assert.throws(() => add({}, 1), TypeError);
});

test('divide: rejects invalid inputs with TypeError', () => {
  assert.throws(() => divide('10', 2), TypeError);
  assert.throws(() => divide(10, '2'), TypeError);
  assert.throws(() => divide(NaN, 2), TypeError);
  assert.throws(() => divide(10, NaN), TypeError);
  assert.throws(() => divide(Infinity, 2), TypeError);
  assert.throws(() => divide(10, -Infinity), TypeError);
  assert.throws(() => divide(null, 2), TypeError);
  assert.throws(() => divide(10, undefined), TypeError);
});

test('module exports exactly add and divide', () => {
  assert.deepEqual(Object.keys(require('./calculator.cjs')), ['add', 'divide']);
  assert.equal(typeof add, 'function');
  assert.equal(typeof divide, 'function');
});