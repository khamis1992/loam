import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');

function extractFunction(name: string): string {
  const header = `function ${name}(`;
  const start = source.indexOf(header);
  assert.equal(start >= 0, true, name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(name);
}

function positionStatements(): string[] {
  const marker = 'writeFileSync(positionFile,';
  const statements: string[] = [];
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(marker, from);
    if (at < 0) break;
    const end = source.indexOf(';', at);
    assert.equal(end >= 0, true);
    statements.push(source.slice(at, end + 1));
    from = end + 1;
  }
  return statements;
}

function stringifyArgument(statement: string): string {
  const token = 'JSON.stringify(';
  const at = statement.indexOf(token);
  assert.equal(at >= 0, true, statement);
  const open = at + token.length - 1;
  let depth = 0;
  for (let index = open; index < statement.length; index += 1) {
    const char = statement[index];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        assert.equal(statement.indexOf(token, index), -1, statement);
        return statement.slice(open + 1, index);
      }
    }
  }
  assert.fail(statement);
}

function savedRecord(expression: string, placed: Record<string, unknown>, frame: Record<string, unknown>): Record<string, unknown> {
  const storedPosition = vm.runInNewContext(`(${extractFunction('storedPosition')})`) as (
    placed: object,
    expanded: unknown,
  ) => Record<string, unknown>;
  const value: unknown = vm.runInNewContext(`(${expression})`, { storedPosition, placed, frame });
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true);
  return value as Record<string, unknown>;
}

function assertSavedShape(record: Record<string, unknown>, expanded: boolean): void {
  const text = `${JSON.stringify(record)}\n`;
  if (expanded) {
    assert.equal(text, '{"x":12,"y":8,"expanded":true}\n');
    assert.deepEqual(Object.keys(record), ['x', 'y', 'expanded']);
    assert.equal(record.expanded, true);
    return;
  }
  assert.equal(text, '{"x":12,"y":8}\n');
  assert.deepEqual(Object.keys(record), ['x', 'y']);
  assert.equal(Object.hasOwn(record, 'expanded'), false);
}

test('template position saves write only x,y or x,y,expanded true', () => {
  const statements = positionStatements();
  assert.equal(statements.length, 2);
  const expressions = statements.map((statement) => {
    assert.equal(statement.includes('\\n'), true, statement);
    return stringifyArgument(statement);
  });
  const extras = {
    width: 480,
    height: 360,
    displayId: 'screen-1',
    note: 'local',
    next: 'https://example.test/a',
  };
  const cases = [
    { placedExpanded: true, frameExpanded: false },
    { placedExpanded: false, frameExpanded: true },
    { placedExpanded: false, frameExpanded: false },
    { placedExpanded: true, frameExpanded: true },
  ];
  for (const item of cases) {
    const placed = { x: 12, y: 8, ...extras, expanded: item.placedExpanded };
    const frame = { width: 320, height: 220, note: 'frame', expanded: item.frameExpanded };
    for (const expression of expressions) {
      const usesFrame = expression.includes('frame.expanded');
      const usesPlaced = expression.includes('placed.expanded');
      assert.equal(usesFrame !== usesPlaced, true, expression);
      const record = savedRecord(expression, placed, frame);
      assertSavedShape(record, usesFrame ? item.frameExpanded : item.placedExpanded);
      assert.equal(record.x, 12);
      assert.equal(record.y, 8);
      for (const key of Object.keys(extras)) assert.equal(Object.hasOwn(record, key), false, key);
    }
  }
});

test('template webPreferences keep node integration off and context isolation on', () => {
  const blocks = [...source.matchAll(/webPreferences:\s*\{([^}]*)\}/g)];
  assert.equal(blocks.length, 1);
  const block = blocks[0]?.[1] ?? '';
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /nodeIntegration:\s*false/);
  assert.equal(/nodeIntegration:\s*true/.test(source), false);
  assert.equal(/contextIsolation:\s*false/.test(source), false);
  assert.equal(source.match(/nodeIntegration:/g)?.length, 1);
  assert.equal(source.match(/contextIsolation:/g)?.length, 1);
});
