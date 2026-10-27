const test = require('node:test');
const assert = require('node:assert/strict');
const { add, divide } = require('./calculator.cjs');
test('add', () => assert.equal(add(2, 3), 5));
test('divide', () => assert.equal(divide(6, 3), 2));
